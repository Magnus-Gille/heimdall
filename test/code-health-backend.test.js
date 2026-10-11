'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { REPOSITORIES, EXPECTED_SLOTS } = require('../src/code-health/registry');
const { parseObjectiveArtifact, parseZipArchive } = require('../src/code-health/artifact');
const { collectObjectiveReports } = require('../src/code-health/objective-collector');
const { loadCodeHealthRuntimeConfig } = require('../src/code-health/runtime-config');
const { runCodeHealthCollection } = require('../src/code-health/runtime');
const { expectedFilterHash, reconcileSubjectiveEvidence, readSubjectiveEvidence } = require('../src/code-health/munin-export');
const { admitObjectiveArtifact, pruneExpiredEvidence, getObjectiveHistory, readObjectiveSourceState } = require('../src/code-health/store');

const COMMIT = 'a'.repeat(40);
const NOW = '2026-10-10T12:00:00.000Z';
const objectiveFixture = require('../src/code-health/contract/tests/fixtures/code-health/objective-positive.json');
const agentFixture = require('../src/code-health/contract/tests/fixtures/code-health/agent-positive.json');
const sagaRegistry = require('../src/code-health/registries/sagascript/code-health-producer-v1.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

function setStaticMetricState(snapshot, metricName, status, reason, observedAt) {
  const metric = snapshot.metrics[metricName];
  metric.observed_at = observedAt;
  metric.status = status;
  metric.payload = null;
  metric.reason = reason;
  metric.source = null;
  metric.population = null;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(body);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localParts.push(local, body);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + body.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function walkRefs(value, refs = new Set()) {
  if (typeof value === 'string' && /^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(value)) refs.add(value);
  else if (Array.isArray(value)) value.forEach((item) => walkRefs(item, refs));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walkRefs(item, refs));
  return refs;
}

function objectiveFor(repoName, runId, attempt, scopeName, { snapshotId, observedAt, supersedesRef = null, correctionRef = null } = {}) {
  const objective = clone(objectiveFixture);
  objective.snapshot_id = snapshotId ?? `ref:synthetic-snapshot-${scopeName ?? 'gille'}`;
  objective.repository = { owner: 'Magnus-Gille', name: repoName };
  objective.commit = COMMIT;
  objective.observed_at = observedAt ?? '2026-10-09T10:00:00Z';
  objective.supersedes_ref = supersedesRef;
  objective.correction_ref = correctionRef;
  const registered = EXPECTED_SLOTS.get(repoName).slots;
  const scopeSlots = scopeName
    ? sagaRegistry.scopes.find((scope) => scope.name === scopeName).slots
    : null;
  for (const [metricName, metric] of Object.entries(objective.metrics)) {
    if (observedAt) metric.observed_at = observedAt;
    const slot = scopeSlots?.[metricName] ?? registered.find((candidate) => candidate.metric === metricName);
    metric.slot_ref = slot.slot_ref;
    metric.source.language = slot.language;
    metric.source.platform = slot.platform;
    metric.source.feature_refs = [...(slot.feature_refs ?? [])];
    metric.source.scope_version = slot.scope_version;
    metric.source.metric_version = slot.metric_version ?? metric.source.metric_version;
    metric.source.attempt = attempt;
    metric.source.scope_digest.value = 'c'.repeat(64);
    metric.source.config_digest.value = 'b'.repeat(64);
    metric.source.run_ref = repoName === 'sagascript'
      ? `ref:github-run-${runId}-attempt-${attempt}`
      : `ref:collection-gha-${runId}-attempt-${attempt}-${({
        complex_functions: 'complexity', unused_candidates: 'knip', coverage: 'coverage', ci_first_attempt: 'ci',
      })[metricName] ?? 'unused'}`;
    if (repoName === 'gille-inference' && metricName === 'confirmed_regressions') {
      metric.status = 'unknown';
      metric.payload = null;
      metric.reason = 'not-collected';
      metric.source = null;
      metric.population = null;
    }
  }
  return objective;
}

function makeObjectiveArchive(repoName, runId = 731, attempt = 1, {
  scopeNames: requestedScopes, observedAt, snapshotId, supersedesRef, correctionRef, auxiliaryFiles = [],
  referencedArtifactFiles = [],
} = {}) {
  const scopeNames = requestedScopes ?? (repoName === 'sagascript'
    ? sagaRegistry.scopes.map((scope) => scope.name)
    : [null]);
  const snapshots = scopeNames.map((scope, index) => objectiveFor(repoName, runId, attempt, scope, {
    observedAt,
    snapshotId: snapshotId ? `${snapshotId}${scope ? `-${scope}` : ''}${scopeNames.length > 1 && !snapshotId.endsWith('-') ? `-${index}` : ''}` : undefined,
    supersedesRef,
    correctionRef,
  }));
  const snapshotPaths = snapshots.map((_, index) => `snapshots/${index}.json`);
  const manifest = {
    contract_version: '1.0',
    repo_owner: 'Magnus-Gille',
    repo_name: repoName,
    commit_sha: COMMIT,
    snapshots: snapshotPaths,
    evidence_index: 'evidence-index.json',
  };
  const refs = {};
  for (const [, snapshot] of snapshots.entries()) {
    const snapshotRefs = new Set();
    for (const [key, value] of Object.entries(snapshot)) {
      if (key !== 'snapshot_id') walkRefs(value, snapshotRefs);
    }
    for (const ref of snapshotRefs) {
      if (repoName === 'sagascript' && (ref.startsWith('ref:slot-') || ref.startsWith('ref:feature-'))) {
        refs[ref] = { kind: 'artifact-file', path: 'scope-registry.json' };
      } else if (ref.startsWith('ref:github-run-') || ref.startsWith('ref:collection-gha-')) {
        refs[ref] = repoName === 'sagascript'
          ? { kind: 'github-run', run_id: runId, attempt }
          : { kind: 'artifact-file', path: 'evidence/collector-run.json' };
      } else refs[ref] = { kind: 'source', path: 'src/synthetic.ts', line: 1 };
    }
  }
  for (const [index, file] of referencedArtifactFiles.entries()) {
    refs[`ref:synthetic-artifact-${index}`] = { kind: 'artifact-file', path: file };
  }
  const entries = [
    ['manifest.json', JSON.stringify(manifest)],
    ['evidence-index.json', JSON.stringify({ version: '1.0', refs })],
    ...snapshots.map((snapshot, index) => [snapshotPaths[index], JSON.stringify(snapshot)]),
  ];
  if (repoName === 'sagascript') entries.push(['scope-registry.json', JSON.stringify(sagaRegistry)]);
  if (repoName === 'gille-inference') {
    entries.push(['evidence/collector-run.json', '{}']);
  }
  for (const [file, content = '{}'] of auxiliaryFiles) entries.push([file, content]);
  return zipStored(entries);
}

function transportMetadata(repoName, runId, attempt, archive, overrides = {}) {
  const source = REPOSITORIES.find((item) => item.name === repoName);
  return {
    workflow: { path: source.workflowPath },
    run: {
      repository_owner: source.owner,
      repository_name: source.name,
      branch: 'main',
      event: 'schedule',
      status: 'completed',
      id: runId,
      attempt,
      head_sha: COMMIT,
      created_at: '2026-10-09T10:00:00Z',
    },
    artifact: {
      id: 8801,
      name: 'code-health-v1',
      size_in_bytes: archive.length,
      created_at: '2026-10-09T10:02:00Z',
      workflow_run_id: runId,
      workflow_run_attempt: attempt,
    },
    ...overrides,
  };
}

function subjectiveRecord(id, taskId, observedAt = '2026-10-09T10:00:00Z') {
  const record = clone(agentFixture.records.find((item) => item.record_id === 'ref:rec-env-code'));
  record.record_id = id;
  record.repo_owner = 'Magnus-Gille';
  record.repo_name = 'gille-inference';
  record.task_id = taskId;
  record.attempt_id = 'attempt-1';
  record.parent_attempt_id = null;
  record.observed_at = observedAt;
  return record;
}

function retentionFor(records, collectedAt = '2026-10-01T00:00:00Z', expiresAt = '2027-03-31T00:00:00Z') {
  return records.map((record) => ({
    record_id: record.record_id,
    collected_at: collectedAt,
    expires_at: expiresAt,
    updated_at: '2026-10-09T10:00:00Z',
    classification: 'internal',
  }));
}

function exportPage(config, {
  records = [], contextRecords = [], complete = true, nextCursor = null,
  totalRecords = records.length, watermark = '2026-10-09T12:00:00Z', expiresAt = '2026-10-09T12:15:00Z',
  collectedAt = '2026-10-01T00:00:00Z', recordExpiresAt = '2027-03-31T00:00:00Z', updatedAt = '2026-10-09T10:00:00Z',
} = {}) {
  return {
    ok: true,
    action: 'code_health',
    export_scope: {
      namespace: config.namespace,
      producer_principal_id: config.producerPrincipalId,
      filter_hash: expectedFilterHash(config),
    },
    generated_at: watermark,
    watermark,
    expires_at: expiresAt,
    total_records: totalRecords,
    records,
    context_records: contextRecords,
    retention: retentionFor([...records, ...contextRecords], collectedAt, recordExpiresAt).map((item) => ({ ...item, updated_at: updatedAt })),
    complete,
    next_cursor: nextCursor,
    reconciliation: complete ? 'complete-authorized-retained-set' : 'incomplete-do-not-remove-consumer-records',
  };
}

function subjectiveConfig() {
  return {
    enabled: true,
    namespace: 'grimnir/code-health',
    producerPrincipalId: 'heimdall-producer',
    repoOwner: 'Magnus-Gille',
    repoName: 'gille-inference',
    rubricVersion: 'changeability-1.0',
  };
}

function memoryDb() { return openDatabase(':memory:'); }


describe('code-health objective backend', () => {
  it('migrates forward and leaves collection explicitly unconfigured by default', async () => {
    const db = memoryDb();
    assert.equal(db.pragma('user_version', { simple: true }), 15);
    let calls = 0;
    const result = await collectObjectiveReports({ db, clock: () => new Date(NOW), transport: {
      listArtifacts: async () => { calls += 1; return []; },
      downloadArtifact: async () => { calls += 1; return Buffer.alloc(0); },
    } });
    assert.equal(result.status, 'disabled');
    assert.equal(calls, 0);
    const enabled = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW) });
    assert.equal(enabled.status, 'unconfigured');
    assert.equal(enabled.reason, 'authenticated-transport-not-configured');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_audit').get().n, 2);
    db.close();
  });

  it('admits a synthetic Gille bundle using authenticated run and metric provenance', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference');
    const metadata = transportMetadata('gille-inference', 731, 1, archive);
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'gille-inference' ? [metadata] : [],
      downloadArtifact: async (request) => {
        assert.deepEqual(request, { owner: 'Magnus-Gille', repository: 'gille-inference', artifactId: 8801 });
        return archive;
      },
    } });
    assert.equal(result.status, 'committed');
    assert.equal(result.admitted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_gaps').get().n, 0);
    const history = await getObjectiveHistory(db, { repoOwner: 'Magnus-Gille', repoName: 'gille-inference', asOf: '2026-10-10T12:00:00Z' });
    assert.equal(history.slots.length, 5);
    assert.equal(history.slots.find((slot) => slot.metric === 'confirmed_regressions').latest.status, 'unknown');
    assert.ok(history.slots.every((slot) => slot.latest.kind === 'snapshot'));
    db.close();
  });

  it('rejects self-asserted repository, commit, event, or metric run provenance', async () => {
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 731, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z',
    };
    const good = makeObjectiveArchive('gille-inference');
    const parsed = await parseObjectiveArtifact(good, provenance);
    assert.equal(parsed.snapshots.length, 1);

    for (const candidate of [
      transportMetadata('gille-inference', 731, 1, good, { run: { ...transportMetadata('gille-inference', 731, 1, good).run, event: 'push' } }),
      transportMetadata('gille-inference', 731, 1, good, { run: { ...transportMetadata('gille-inference', 731, 1, good).run, repository_name: 'other-repo' } }),
    ]) {
      assert.throws(() => require('../src/code-health/objective-collector').validateTransportMetadata(candidate, REPOSITORIES[0]));
    }

    const badRun = makeObjectiveArchive('gille-inference');
    const names = [
      ['manifest.json', JSON.stringify({ contract_version: '1.0', repo_owner: 'Magnus-Gille', repo_name: 'gille-inference', commit_sha: 'c'.repeat(40), snapshots: ['snapshots/0.json'], evidence_index: 'evidence-index.json' })],
      ['evidence-index.json', '{}'],
      ['snapshots/0.json', '{}'],
    ];
    assert.notDeepEqual(badRun, zipStored(names));
    await assert.rejects(parseObjectiveArtifact(zipStored(names), provenance), /manifest does not match authenticated run provenance/);

    const tampered = objectiveFor('gille-inference', 731, 1);
    tampered.metrics.complex_functions.source.run_ref = 'ref:collection-gha-999-attempt-1-complexity';
    const refs = {};
    for (const ref of walkRefs(tampered)) refs[ref] = { kind: 'source', path: 'src/synthetic.ts', line: 1 };
    const badBytes = zipStored([
      ['manifest.json', JSON.stringify({ contract_version: '1.0', repo_owner: 'Magnus-Gille', repo_name: 'gille-inference', commit_sha: COMMIT, snapshots: ['snapshots/0.json'], evidence_index: 'evidence-index.json' })],
      ['evidence-index.json', JSON.stringify({ version: '1.0', refs })],
      ['snapshots/0.json', JSON.stringify(tampered)],
    ]);
    await assert.rejects(parseObjectiveArtifact(badBytes, provenance), /snapshot source run is not bound/);
  });

  it('rejects unallowlisted origins before downloading and does not trust a manifest URL', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference');
    const source = transportMetadata('gille-inference', 731, 1, archive);
    source.run.repository_owner = 'attacker';
    let downloads = 0;
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'gille-inference' ? [source] : [],
      downloadArtifact: async () => { downloads += 1; return archive; },
    } });
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejected, 1);
    assert.equal(downloads, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, 0);
    db.close();
  });

  it('accepts bounded producer auxiliary files and resolves snapshot identity through the manifest path', async () => {
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 731, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z',
    };
    const allowed = makeObjectiveArchive('gille-inference', 731, 1, {
      auxiliaryFiles: [
        ['evidence/ci/inventory.json', JSON.stringify({ status: 'not-collected' })],
        ['evidence/complexity/summary.json', JSON.stringify({ status: 'measured' })],
        ['evidence/coverage/run.json', JSON.stringify({ status: 'measured' })],
        ['evidence/overhead.json', JSON.stringify({ report_status: 'partial' })],
        ['evidence/producer-status.json', JSON.stringify({ status: 'valid' })],
        ['workflow-run.json', JSON.stringify({ status: 'completed' })],
      ],
    });
    const parsed = await parseObjectiveArtifact(allowed, provenance);
    assert.equal(parsed.snapshots[0].snapshot_id, 'ref:synthetic-snapshot-gille');

    const unsupported = makeObjectiveArchive('gille-inference', 731, 1, {
      auxiliaryFiles: [['evidence/unlisted-extra.json', '{}']],
    });
    await assert.rejects(parseObjectiveArtifact(unsupported, provenance), /artifact contains an unknown file/);

    const sagaBytes = makeObjectiveArchive('sagascript', 731, 1, {
      auxiliaryFiles: [
        ['evidence/collection-status.json', '{}'],
        ['evidence/collection-overhead.json', '{}'],
        ['workflow-status.json', JSON.stringify({
          status: 'partial', phase: 'analyzer', reason: 'collector-failure', phase_elapsed_seconds: 7.792,
          preupload_elapsed_seconds: 301, preupload_budget_seconds: 900, preupload_over_budget: false,
          metadata_elapsed_seconds: null, metadata_budget_seconds: 30, metadata_over_budget: false, over_budget: false,
        })],
      ],
    });
    const saga = await parseObjectiveArtifact(sagaBytes, {
      ...provenance, repositoryName: 'sagascript',
    });
    assert.equal(saga.snapshots.length, sagaRegistry.scopes.length);

    for (const status of ['failed', 'not-collected']) {
      const failed = makeObjectiveArchive('sagascript', 731, 1, {
        auxiliaryFiles: [['workflow-status.json', JSON.stringify({
          status, phase: 'setup', reason: 'collector-exit', phase_elapsed_seconds: null,
          preupload_elapsed_seconds: 0, preupload_budget_seconds: 900, preupload_over_budget: false,
          metadata_elapsed_seconds: null, metadata_budget_seconds: 30, metadata_over_budget: false, over_budget: false,
        })]],
      });
      await assert.rejects(parseObjectiveArtifact(failed, { ...provenance, repositoryName: 'sagascript' }), /producer workflow reports/);
    }

    for (const status of [{ status: 'partial' }, { status: 'future-status' }]) {
      const malformedStatus = makeObjectiveArchive('sagascript', 731, 1, {
        auxiliaryFiles: [['workflow-status.json', JSON.stringify(status)]],
      });
      await assert.rejects(parseObjectiveArtifact(malformedStatus, { ...provenance, repositoryName: 'sagascript' }), /workflow status is malformed/);
    }
  });

  it('admits the full static Saga producer shape and rejects arbitrary extra files', async () => {
    const staticEvidenceFiles = [
      'evidence/inventory-rust-core.json',
      'evidence/functions-rust-core.json',
      'evidence/inventory-rust-cli.json',
      'evidence/functions-rust-cli.json',
      'evidence/inventory-rust-core-no-default.json',
      'evidence/profile-rust-core-no-default-inline.json',
      'evidence/inventory-swift-coreml-source-only.json',
      'evidence/profile-swift-coreml-source-only.json',
      'evidence/knip-candidates-typescript.json',
      'evidence/inventory-knip-typescript.json',
      'evidence/knip-candidates-svelte.json',
      'evidence/inventory-knip-svelte.json',
    ];
    const staticFiles = [
      ...staticEvidenceFiles,
      'evidence/collection-status.json',
      'evidence/collection-overhead.json',
      'evidence/ci-workflow.json',
    ];
    const staticArchive = makeObjectiveArchive('sagascript', 814, 1, {
      referencedArtifactFiles: staticEvidenceFiles,
      auxiliaryFiles: staticFiles.map((file) => [file, '{}']),
    });
    assert.equal(parseZipArchive(staticArchive).files.size, 24);
    const parsed = await parseObjectiveArtifact(staticArchive, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 814, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    });
    assert.equal(parsed.snapshots.length, sagaRegistry.scopes.length);

    const withUnknownExtra = makeObjectiveArchive('sagascript', 815, 1, {
      referencedArtifactFiles: staticEvidenceFiles,
      auxiliaryFiles: [
        ...staticFiles.map((file) => [file, '{}']),
        ['evidence/not-registered.json', '{}'],
      ],
    });
    await assert.rejects(parseObjectiveArtifact(withUnknownExtra, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 815, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    }), /artifact contains an unknown file: evidence\/not-registered\.json/);
  });

  it('accepts the measured Saga CLI coverage scope and rejects the prior deferred registry', async () => {
    const runId = 816;
    const archive = makeObjectiveArchive('sagascript', runId, 1, { scopeNames: ['rust-cli'] });
    const parsed = await parseObjectiveArtifact(archive, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    });
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.snapshots[0].metrics.coverage.status, 'measured');
    assert.equal(parsed.snapshots[0].metrics.coverage.source.scope_version, 'rust-cli-no-default-exported-v1');
    assert.equal(sagaRegistry.scopes.find((scope) => scope.name === 'rust-cli').slots.coverage.status, 'measured');
    assert.equal(sagaRegistry.coverage.rust_cli.package, 'sagascript-cli');

    const staleRegistry = clone(sagaRegistry);
    delete staleRegistry.coverage.rust_cli;
    const staleCoverage = staleRegistry.scopes.find((scope) => scope.name === 'rust-cli').slots.coverage;
    staleCoverage.status = 'unknown';
    staleCoverage.reason = 'incomplete-input';
    staleCoverage.scope_version = 'rust-cli-no-default-clean-deferred-v1';
    const staleEntries = [...parseZipArchive(archive).files.entries()].map(([name, bytes]) => [
      name, name === 'scope-registry.json' ? JSON.stringify(staleRegistry) : bytes,
    ]);
    await assert.rejects(parseObjectiveArtifact(zipStored(staleEntries), {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    }), /scope registry differs from the pinned producer registry/);
  });

  it('fails closed on duplicate and traversing archive entries', () => {
    assert.throws(() => parseZipArchive(zipStored([['../outside.json', '{}']])), /unsafe member path/);
    assert.throws(() => parseZipArchive(zipStored([['manifest.json', '{}'], ['manifest.json', '{}']])), /duplicate member/);
  });

  it('makes exact replays idempotent and rejects same-ID payload collisions', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference', 741, 1, { snapshotId: 'ref:snapshot-idempotent' });
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 741, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z',
    };
    const parsed = await parseObjectiveArtifact(archive, provenance);
    const first = await admitObjectiveArtifact(db, parsed, provenance, '2026-10-10T12:00:00Z');
    const replay = await admitObjectiveArtifact(db, parsed, provenance, '2026-10-11T12:00:00Z');
    assert.equal(first.admitted, 1);
    assert.equal(replay.replayed, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, 1);

    const collision = clone(parsed);
    collision.snapshots[0].metrics.complex_functions.payload.threshold += 1;
    await assert.rejects(admitObjectiveArtifact(db, collision, provenance, '2026-10-11T12:00:00Z'), /snapshot ID collision/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, 1);
    db.close();
  });

  it('keeps out-of-order history and validates correction lineage', async () => {
    const db = memoryDb();
    const firstProvenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 751, attempt: 1, artifactCreatedAt: '2026-10-08T10:02:00Z',
    };
    const first = await parseObjectiveArtifact(makeObjectiveArchive('gille-inference', 751, 1, {
      snapshotId: 'ref:snapshot-newer', observedAt: '2026-10-09T10:00:00Z',
    }), firstProvenance);
    await admitObjectiveArtifact(db, first, firstProvenance, '2026-10-10T12:00:00Z');

    const olderProvenance = { ...firstProvenance, runId: 750, artifactCreatedAt: '2026-10-07T10:02:00Z' };
    const older = await parseObjectiveArtifact(makeObjectiveArchive('gille-inference', 750, 1, {
      snapshotId: 'ref:snapshot-older', observedAt: '2026-10-08T10:00:00Z',
    }), olderProvenance);
    await admitObjectiveArtifact(db, older, olderProvenance, '2026-10-11T12:00:00Z');

    const correctionProvenance = { ...firstProvenance, runId: 752, artifactCreatedAt: '2026-10-09T10:02:00Z' };
    const correction = await parseObjectiveArtifact(makeObjectiveArchive('gille-inference', 752, 1, {
      snapshotId: 'ref:snapshot-correction', observedAt: '2026-10-10T10:00:00Z',
      supersedesRef: 'ref:snapshot-newer', correctionRef: 'ref:correction-receipt',
    }), correctionProvenance);
    await admitObjectiveArtifact(db, correction, correctionProvenance, '2026-10-12T12:00:00Z');

    const history = await getObjectiveHistory(db, {
      repoOwner: 'Magnus-Gille', repoName: 'gille-inference', asOf: '2026-10-12T12:00:00Z',
    });
    const slot = history.slots.find((item) => item.metric === 'complex_functions');
    assert.deepEqual(slot.points.map((point) => point.snapshot_id), ['ref:snapshot-older', 'ref:snapshot-newer', 'ref:snapshot-correction']);
    assert.equal(slot.points.find((point) => point.snapshot_id === 'ref:snapshot-newer').superseded, true);
    assert.equal(slot.latest.snapshot_id, 'ref:snapshot-correction');
    db.close();
  });

  it('admits all Saga scopes only with registry equality and run-attempt binding', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('sagascript', 812, 2);
    const metadata = transportMetadata('sagascript', 812, 2, archive);
    metadata.run.event = 'workflow_dispatch';
    await parseObjectiveArtifact(archive, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 812, attempt: 2, artifactCreatedAt: metadata.artifact.created_at,
    });
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'sagascript' ? [metadata] : [],
      downloadArtifact: async () => archive,
    } });
    assert.equal(result.status, 'committed');
    assert.equal(result.admitted, sagaRegistry.scopes.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, sagaRegistry.scopes.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_gaps').get().n, 0);
    assert.equal(EXPECTED_SLOTS.get('sagascript').slots.length, sagaRegistry.scopes.length * 5);
    db.close();
  });

  it('records registry-backed unknown gaps for omitted Saga scopes', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('sagascript', 813, 1, { scopeNames: ['rust-core'] });
    const metadata = transportMetadata('sagascript', 813, 1, archive);
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'sagascript' ? [metadata] : [],
      downloadArtifact: async () => archive,
    } });
    assert.equal(result.status, 'committed');
    assert.equal(result.admitted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_gaps').get().n, 25);
    const history = await getObjectiveHistory(db, { repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: '2026-10-10T12:00:00Z' });
    assert.equal(history.slots.length, 30);
    assert.equal(history.slots.filter((slot) => slot.latest.kind === 'gap' && slot.latest.status === 'unknown').length, 25);
    const state = readObjectiveSourceState(db, { repoOwner: 'Magnus-Gille', repoName: 'sagascript', enabled: true, configured: true });
    assert.equal(state.last_attempt_status, 'committed');
    assert.equal(state.last_success_at, '2026-10-10T12:00:00Z');
    db.close();
  });

  const admitSagaFixture = async (db, {
    runId, snapshotId, scopeNames, artifactCreatedAt = '2026-10-09T10:02:00Z', collectedAt = '2026-10-09T12:00:00Z', mutate,
  }) => {
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt,
    };
    const parsed = await parseObjectiveArtifact(makeObjectiveArchive('sagascript', runId, 1, { snapshotId, scopeNames }), provenance);
    if (mutate) mutate(parsed);
    await admitObjectiveArtifact(db, parsed, provenance, collectedAt);
  };

  it('preserves measured Saga points through a later full-scope CI-only report', async () => {
    const db = memoryDb();
    const first = await parseObjectiveArtifact(makeObjectiveArchive('sagascript', 901, 1, {
      snapshotId: 'ref:full-t1',
    }), {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 901, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z',
    });
    await admitObjectiveArtifact(db, first, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 901, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z',
    }, '2026-10-09T12:00:00Z');

    const second = await parseObjectiveArtifact(makeObjectiveArchive('sagascript', 902, 1, {
      snapshotId: 'ref:ci-only-t2',
    }), {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 902, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    });
    second.snapshots.forEach((snapshot, index) => {
      const scope = sagaRegistry.scopes[index].name;
      snapshot.observed_at = '2026-10-10T10:00:00Z';
      for (const metricName of Object.keys(snapshot.metrics)) {
        snapshot.metrics[metricName].observed_at = '2026-10-10T10:00:00Z';
        if (scope !== 'ci-release' || metricName !== 'ci_first_attempt') {
          setStaticMetricState(snapshot, metricName, 'unknown', 'not-collected', '2026-10-10T10:00:00Z');
        }
      }
    });
    await admitObjectiveArtifact(db, second, {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId: 902, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    }, '2026-10-10T12:00:00Z');

    const history = await getObjectiveHistory(db, {
      repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: '2026-10-11T12:00:00Z',
    });
    for (const scope of ['rust-core', 'rust-cli', 'swift-coreml']) {
      const slot = history.slots.find((item) => item.scope === scope && item.metric === 'coverage');
      assert.equal(slot.latest.snapshot_id.startsWith('ref:full-t1'), true);
      assert.equal(slot.latest.current_status, 'measured');
      assert.ok(slot.points.some((point) => point.snapshot_id.startsWith('ref:ci-only-t2')
        && point.status === 'unknown' && point.reason === 'not-collected'));
    }
    const ci = history.slots.find((item) => item.scope === 'ci-release' && item.metric === 'ci_first_attempt');
    assert.equal(ci.latest.snapshot_id.startsWith('ref:ci-only-t2'), true);
    assert.equal(ci.latest.current_status, 'measured');
    db.close();
  });

  it('keeps substantive failure, gap, stale, and conflict states authoritative', async () => {
    const db = memoryDb();
    await admitSagaFixture(db, { runId: 903, snapshotId: 'ref:substantive-t1' });
    await admitSagaFixture(db, {
      runId: 904, snapshotId: 'ref:substantive-t2', artifactCreatedAt: '2026-10-10T10:02:00Z', collectedAt: '2026-10-10T12:00:00Z',
      mutate: (parsed) => {
        for (const [scope, status, reason] of [['rust-cli', 'unknown', 'incomplete-input'], ['swift-coreml', 'failed', 'producer-error']]) {
          const snapshot = parsed.snapshots.find((item) => item.snapshot_id.includes(scope));
          snapshot.observed_at = '2026-10-10T10:00:00Z';
          setStaticMetricState(snapshot, 'coverage', status, reason, '2026-10-10T10:00:00Z');
        }
      },
    });
    await admitSagaFixture(db, {
      runId: 905, snapshotId: 'ref:gap-t3', scopeNames: ['rust-core', 'rust-cli', 'svelte', 'swift-coreml', 'ci-release'],
      artifactCreatedAt: '2026-10-11T10:02:00Z', collectedAt: '2026-10-11T12:00:00Z',
    });
    const history = await getObjectiveHistory(db, {
      repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: '2026-10-12T12:00:00Z',
    });
    assert.equal(history.slots.find((item) => item.scope === 'rust-cli' && item.metric === 'coverage').latest.reason, 'incomplete-input');
    assert.equal(history.slots.find((item) => item.scope === 'swift-coreml' && item.metric === 'coverage').latest.status, 'failed');
    const gap = history.slots.find((item) => item.scope === 'typescript' && item.metric === 'coverage').latest;
    assert.equal(gap.kind, 'gap');
    assert.equal(gap.reason, 'missing-expected-slot');
    db.close();

    const staleDb = memoryDb();
    await admitSagaFixture(staleDb, { runId: 906, snapshotId: 'ref:stale-t1' });
    await admitSagaFixture(staleDb, {
      runId: 907, snapshotId: 'ref:stale-noop-t2', artifactCreatedAt: '2026-10-10T10:02:00Z', collectedAt: '2026-10-10T12:00:00Z',
      mutate: (parsed) => {
        const snapshot = parsed.snapshots.find((item) => item.snapshot_id.includes('rust-cli'));
        snapshot.observed_at = '2026-10-10T10:00:00Z';
        setStaticMetricState(snapshot, 'coverage', 'unknown', 'not-collected', '2026-10-10T10:00:00Z');
      },
    });
    const stale = await getObjectiveHistory(staleDb, {
      repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: '2026-10-21T12:00:00Z',
    });
    const staleSlot = stale.slots.find((item) => item.scope === 'rust-cli' && item.metric === 'coverage');
    assert.equal(staleSlot.latest.snapshot_id.startsWith('ref:stale-t1'), true);
    assert.equal(staleSlot.latest.current_status, 'stale');
    staleDb.close();

    const conflictDb = memoryDb();
    await admitSagaFixture(conflictDb, { runId: 908, snapshotId: 'ref:conflict-t1' });
    await admitSagaFixture(conflictDb, { runId: 909, snapshotId: 'ref:conflict-t2', collectedAt: '2026-10-10T12:00:00Z' });
    const conflict = await getObjectiveHistory(conflictDb, {
      repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: '2026-10-10T12:00:00Z',
    });
    const conflictSlot = conflict.slots.find((item) => item.scope === 'rust-cli' && item.metric === 'coverage');
    assert.equal(conflictSlot.latest.status, 'unknown');
    assert.equal(conflictSlot.latest.reason, 'conflicting-samples-at-same-time');
    conflictDb.close();
  });
});


describe('Munin export reconciliation', () => {
  it('keeps the default disabled and performs no RPC call', async () => {
    const db = memoryDb();
    let calls = 0;
    const result = await reconcileSubjectiveEvidence(db, { enabled: false }, { rpc: async () => { calls += 1; } });
    assert.equal(result.status, 'disabled');
    assert.equal(calls, 0);
    const view = await readSubjectiveEvidence(db, { enabled: false }, { now: NOW });
    assert.equal(view.collection.status, 'unconfigured');
    assert.equal(view.collection.last_attempt_at, null);
    assert.equal(view.records.length, 0);
    assert.equal(view.aggregate.assessment_coverage.denominator, null);
    db.close();
  });

  it('follows complete pages and stores the full retained set with authoritative expiry', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const first = subjectiveRecord('ref:record-one', 'task-one');
    const second = subjectiveRecord('ref:record-two', 'task-two');
    const pages = [
      exportPage(config, { records: [first], totalRecords: 2, complete: false, nextCursor: 'cursor-next' }),
      exportPage(config, { records: [second], totalRecords: 2 }),
    ];
    const requests = [];
    const result = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW),
      rpc: async (tool, args) => {
        assert.equal(tool, 'memory_code_health');
        requests.push(args);
        return pages[requests.length - 1];
      },
    });
    assert.equal(result.status, 'committed');
    assert.equal(result.records, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      action: 'export',
      namespace: 'grimnir/code-health',
      producer_principal_id: 'heimdall-producer',
      repo_owner: 'Magnus-Gille',
      repo_name: 'gille-inference',
      rubric_version: 'changeability-1.0',
      limit: 100,
    });
    assert.deepEqual(requests[1], {
      action: 'export',
      namespace: 'grimnir/code-health',
      producer_principal_id: 'heimdall-producer',
      repo_owner: 'Magnus-Gille',
      repo_name: 'gille-inference',
      rubric_version: 'changeability-1.0',
      limit: 100,
      cursor: 'cursor-next',
    });
    assert.equal(requests[1].cursor, 'cursor-next');
    const stored = await readSubjectiveEvidence(db, config, { now: NOW });
    assert.equal(stored.records.length, 2);
    assert.equal(stored.records[0].retention.expires_at, '2027-03-31T00:00:00Z');
    assert.equal(stored.source.total_records, 2);
    assert.equal(stored.aggregate.occurrences.length, 2);
    assert.equal(stored.aggregate.assessment_coverage.denominator, null);
    assert.equal(stored.collection.status, 'committed');
    assert.equal(stored.collection.last_success_at, '2026-10-10T12:00:00Z');
    db.close();
  });

  it('reads a bounded source status and retains the last success when a later attempt fails', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const record = subjectiveRecord('ref:record-status', 'task-status');
    const first = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => exportPage(config, { records: [record] }),
    });
    assert.equal(first.status, 'committed');
    const failed = await reconcileSubjectiveEvidence(db, config, {
      now: new Date('2026-10-11T12:00:00Z'), rpc: async () => { throw new Error('synthetic unavailable'); },
    });
    assert.equal(failed.status, 'incomplete');
    const view = await readSubjectiveEvidence(db, config, { now: '2026-10-11T12:00:00Z' });
    assert.equal(view.collection.status, 'incomplete');
    assert.equal(view.collection.last_attempt_status, 'incomplete');
    assert.equal(view.collection.last_attempt_at, '2026-10-11T12:00:00Z');
    assert.equal(view.collection.last_success_at, '2026-10-10T12:00:00Z');
    assert.equal(view.collection.last_error_code, 'export-not-reconciled');
    assert.equal(view.records.length, 1);
    db.close();
  });

  it('does not replace existing rows after an incomplete or out-of-scope export', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const oldRecord = subjectiveRecord('ref:record-old', 'task-old');
    const seeded = exportPage(config, { records: [oldRecord] });
    await reconcileSubjectiveEvidence(db, config, { now: new Date(NOW), rpc: async () => seeded });
    const malformed = exportPage(config, { records: [], totalRecords: 0, complete: false, nextCursor: 'cursor-next' });
    const incomplete = await reconcileSubjectiveEvidence(db, config, { now: new Date(NOW), rpc: async () => malformed });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records.length, 1);

    const wrongScope = exportPage(config, { records: [], totalRecords: 0 });
    wrongScope.export_scope.filter_hash = '0'.repeat(64);
    const rejected = await reconcileSubjectiveEvidence(db, config, { now: new Date(NOW), rpc: async () => wrongScope });
    assert.equal(rejected.status, 'incomplete');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records.length, 1);

    const changed = subjectiveRecord('ref:record-old', 'task-old');
    changed.summary = 'same immutable ID, different payload';
    const collision = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => exportPage(config, { records: [changed] }),
    });
    assert.equal(collision.status, 'incomplete');
    assert.notEqual((await readSubjectiveEvidence(db, config, { now: NOW })).records[0].record.summary, changed.summary);
    db.close();
  });

  it('keeps stored rows when a cursor repeats or the export watermark changes', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const existing = subjectiveRecord('ref:record-before-pages', 'task-before-pages');
    await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => exportPage(config, { records: [existing] }),
    });

    const repeatedPages = [
      exportPage(config, { records: [], totalRecords: 1, complete: false, nextCursor: 'repeat-cursor' }),
      exportPage(config, { records: [], totalRecords: 1, complete: false, nextCursor: 'repeat-cursor' }),
    ];
    let index = 0;
    const repeated = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => repeatedPages[index++],
    });
    assert.equal(repeated.status, 'incomplete');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records[0].record.record_id, existing.record_id);

    const first = subjectiveRecord('ref:page-one', 'task-page-one');
    const second = subjectiveRecord('ref:page-two', 'task-page-two');
    const changingPages = [
      exportPage(config, { records: [first], totalRecords: 2, complete: false, nextCursor: 'page-two' }),
      exportPage(config, { records: [second], totalRecords: 2, watermark: '2026-10-09T12:00:01Z' }),
    ];
    index = 0;
    const changing = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => changingPages[index++],
    });
    assert.equal(changing.status, 'incomplete');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records[0].record.record_id, existing.record_id);
    db.close();
  });

  it('reconciles deletions only from a complete source-scoped retained set', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const oldRecord = subjectiveRecord('ref:record-old', 'task-old');
    const seed = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => exportPage(config, { records: [oldRecord] }),
    });
    assert.equal(seed.status, 'committed');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records.length, 1);

    const deletion = await reconcileSubjectiveEvidence(db, config, {
      now: new Date(NOW), rpc: async () => exportPage(config, { records: [], totalRecords: 0 }),
    });
    assert.equal(deletion.status, 'committed');
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records.length, 0);
    assert.equal(db.prepare('SELECT total_records FROM code_health_subjective_sources').get().total_records, 0);
    db.close();
  });

  it('expires local subjective evidence during an outage', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const record = subjectiveRecord('ref:record-expire', 'task-expire', '2026-03-01T00:00:00Z');
    const seed = await reconcileSubjectiveEvidence(db, config, {
      now: new Date('2026-03-01T00:00:00Z'),
      rpc: async () => exportPage(config, { records: [record], watermark: '2026-03-01T00:00:00Z', expiresAt: '2026-03-01T00:15:00Z',
        collectedAt: '2026-03-01T00:00:00Z', recordExpiresAt: '2026-09-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }),
    });
    assert.equal(seed.status, 'committed');
    const result = await reconcileSubjectiveEvidence(db, config, {
      now: new Date('2026-10-10T00:00:00Z'), rpc: async () => { throw new Error('simulated outage'); },
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.expired.subjective, 1);
    assert.equal((await readSubjectiveEvidence(db, config, { now: NOW })).records.length, 0);
    db.close();
  });

  it('expires authenticated context and removes dependent records', async () => {
    const db = memoryDb();
    const config = subjectiveConfig();
    const observation = subjectiveRecord('ref:context-observation', 'task-context', '2026-05-01T00:00:00Z');
    const assessment = clone(agentFixture.records.find((item) => item.record_id === 'ref:assess-env'));
    assessment.record_id = 'ref:dependent-assessment';
    assessment.repo_owner = 'Magnus-Gille';
    assessment.repo_name = 'gille-inference';
    assessment.task_id = 'task-context';
    assessment.attempt_id = 'attempt-1';
    assessment.parent_attempt_id = null;
    assessment.observed_at = '2026-05-01T00:00:00Z';
    assessment.observation_refs = ['ref:context-observation'];
    const page = exportPage(config, {
      records: [assessment], contextRecords: [observation], totalRecords: 1,
      watermark: '2026-05-01T00:00:00Z', expiresAt: '2026-05-01T00:15:00Z',
      collectedAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    });
    page.retention.find((item) => item.record_id === 'ref:context-observation').expires_at = '2026-06-01T00:00:00Z';
    page.retention.find((item) => item.record_id === 'ref:dependent-assessment').expires_at = '2026-11-01T00:00:00Z';
    const seeded = await reconcileSubjectiveEvidence(db, config, {
      now: new Date('2026-05-01T00:00:00Z'), rpc: async () => page,
    });
    assert.equal(seeded.status, 'committed');
    const view = await readSubjectiveEvidence(db, config, { now: '2026-05-15T00:00:00Z' });
    assert.equal(view.records.length, 1);
    assert.equal(view.contextRecords.length, 1);
    assert.equal(view.aggregate.assessments.length, 1);

    const afterContextExpiry = await readSubjectiveEvidence(db, config, { now: '2026-07-01T00:00:00Z' });
    assert.equal(afterContextExpiry.records.length, 0);
    assert.equal(afterContextExpiry.contextRecords.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_subjective_records').get().n, 2);

    const outage = await reconcileSubjectiveEvidence(db, config, {
      now: new Date('2026-07-01T00:00:00Z'), rpc: async () => { throw new Error('synthetic outage'); },
    });
    assert.equal(outage.expired.subjective, 2);
    const after = await readSubjectiveEvidence(db, config, { now: '2026-07-01T00:00:00Z' });
    assert.equal(after.records.length, 0);
    assert.equal(after.contextRecords.length, 0);
    db.close();
  });
});


describe('code-health local retention and boundaries', () => {
  it('keeps artifact snapshots within six calendar months and limits history windows', async () => {
    const db = memoryDb();
    assert.equal(pruneExpiredEvidence(db, '2027-04-10T00:00:00Z').objective, 0);
    await assert.rejects(getObjectiveHistory(db, { repoOwner: 'Magnus-Gille', repoName: 'gille-inference', days: 180 }), /30, 90, or 365/);
    await assert.rejects(getObjectiveHistory(db, { repoOwner: 'other', repoName: 'gille-inference' }), /registered/);
    db.close();
  });
});

describe('code-health runtime integration', () => {
  it('runs objective-only collection without invoking Munin', async () => {
    const runtimeConfig = loadCodeHealthRuntimeConfig({
      env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'objective-only-config' },
      readConfig: () => ({ sources: [] }),
    });
    const db = memoryDb();
    let muninCalls = 0;
    try {
      const result = await runCodeHealthCollection(db, runtimeConfig, {
        clock: () => new Date(NOW),
        githubTransport: {
          listArtifacts: async () => ({ candidates: [], incomplete: false }),
          downloadArtifact: async () => { throw new Error('download should not be called without candidates'); },
        },
        muninRpc: async () => { muninCalls += 1; },
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.objective.status, 'no-artifacts');
      assert.deepEqual(result.subjective, []);
      assert.equal(muninCalls, 0);
    } finally {
      db.close();
    }
  });

  it('keeps the subjective reader disabled for objective-only configuration', async () => {
    const runtimeConfig = loadCodeHealthRuntimeConfig({
      env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'objective-only-config' },
      readConfig: () => ({ sources: [] }),
    });
    const db = memoryDb();
    try {
      const subjective = await readSubjectiveEvidence(db, runtimeConfig.subjectiveConfigForRepo('sagascript'), { now: NOW });
      assert.equal(subjective.collection.status, 'unconfigured');
      assert.equal(subjective.records.length, 0);
      assert.equal(subjective.contextRecords.length, 0);
    } finally {
      db.close();
    }
  });

  it('collects injected producer and Munin fixtures, then serves stored rows through the normal app', async () => {
    const sourceConfig = subjectiveConfig();
    const runtimeConfig = loadCodeHealthRuntimeConfig({
      env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'fixture-only' },
      readConfig: () => ({
        sources: [{
          repoOwner: sourceConfig.repoOwner,
          repoName: sourceConfig.repoName,
          namespace: sourceConfig.namespace,
          producerPrincipalId: sourceConfig.producerPrincipalId,
        }],
      }),
    });
    assert.equal(runtimeConfig.status, 'enabled');
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference', 731, 1);
    const metadata = transportMetadata('gille-inference', 731, 1, archive);
    const result = await runCodeHealthCollection(db, runtimeConfig, {
      clock: () => new Date(NOW),
      githubTransport: {
        listArtifacts: async ({ repository }) => repository === 'gille-inference'
          ? { candidates: [metadata], incomplete: false }
          : { candidates: [], incomplete: false },
        downloadArtifact: async () => archive,
      },
      muninRpc: async (method, args) => {
        assert.equal(method, 'memory_code_health');
        assert.equal(args.action, 'export');
        return exportPage(sourceConfig, { records: [subjectiveRecord('ref:runtime-record', 'runtime-task')] });
      },
    });
    assert.equal(result.objective.status, 'committed');
    assert.equal(result.subjective[0].status, 'committed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_snapshots').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_health_subjective_records WHERE record_role = \'record\'').get().n, 1);

    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-runtime-'));
    const envKeys = ['HOME', 'HEIMDALL_CONFIG_PATH', 'GRIMNIR_SERVICES_JSON'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    let app;
    try {
      process.env.HOME = home;
      process.env.HEIMDALL_CONFIG_PATH = path.join(home, 'missing-config.json');
      process.env.GRIMNIR_SERVICES_JSON = path.join(home, 'missing-services.json');
      const { buildApp } = require('../src/server');
      app = buildApp(db, {
        runtimeRoot: path.resolve(__dirname, '..'),
        grimnirPath: path.join(home, 'missing-nodes.json'),
        now: () => Date.parse(NOW),
        codeHealth: runtimeConfig,
      }).app;
      await app.ready();
      const response = await app.inject({ method: 'GET', url: '/api/code-health?repo=gille-inference' });
      assert.equal(response.statusCode, 200);
      const view = response.json();
      assert.equal(view.objectiveCollection.status, 'committed');
      assert.equal(view.subjective.status, 'committed');
      assert.equal(view.subjective.workerSamples, 1);
      assert.ok(view.objective.some((metric) => metric.slots.some((slot) => slot.status === 'measured')));

      await app.close();
      app = null;
      const rejectedConfig = loadCodeHealthRuntimeConfig({
        env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'fixture-only' },
        readConfig: () => ({ sources: [{
          repoOwner: 'Magnus-Gille',
          repoName: 'gille-inference',
          namespace: 'grimnir/code-health',
          producerPrincipalId: 'heimdall-producer',
          extra: true,
        }] }),
      });
      app = buildApp(db, {
        runtimeRoot: path.resolve(__dirname, '..'),
        grimnirPath: path.join(home, 'missing-nodes.json'),
        now: () => Date.parse(NOW),
        codeHealth: rejectedConfig,
      }).app;
      await app.ready();
      const rejectedResponse = await app.inject({ method: 'GET', url: '/api/code-health?repo=gille-inference' });
      assert.equal(rejectedResponse.statusCode, 200);
      assert.equal(rejectedResponse.json().objectiveCollection.status, 'rejected');
      assert.equal(rejectedResponse.json().subjective.status, 'rejected');
    } finally {
      if (app) await app.close();
      for (const key of envKeys) {
        if (priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
      }
      fs.rmSync(home, { recursive: true, force: true });
      db.close();
    }
  });
});
