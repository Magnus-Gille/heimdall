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
    assert.equal(db.pragma('user_version', { simple: true }), 16);
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

  it('accepts the Saga CI attempt-1 timing sidecar without widening other producers or files', async () => {
    const runId = 817;
    const sagaArchive = makeObjectiveArchive('sagascript', runId, 1, {
      auxiliaryFiles: [['evidence/ci-attempt1-timings.json', JSON.stringify({ per_run: [] })]],
    });
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    };
    const parsed = await parseObjectiveArtifact(sagaArchive, provenance);
    assert.equal(parsed.snapshots.length, sagaRegistry.scopes.length);

    const gilleArchive = makeObjectiveArchive('gille-inference', runId, 1, {
      auxiliaryFiles: [['evidence/ci-attempt1-timings.json', JSON.stringify({ per_run: [] })]],
    });
    await assert.rejects(
      parseObjectiveArtifact(gilleArchive, { ...provenance, repositoryName: 'gille-inference' }),
      /artifact contains an unknown file: evidence\/ci-attempt1-timings\.json/,
    );

    const sagaWithUnknown = makeObjectiveArchive('sagascript', runId, 1, {
      auxiliaryFiles: [
        ['evidence/ci-attempt1-timings.json', JSON.stringify({ per_run: [] })],
        ['evidence/unregistered.json', '{}'],
      ],
    });
    await assert.rejects(parseObjectiveArtifact(sagaWithUnknown, provenance), /artifact contains an unknown file: evidence\/unregistered\.json/);
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

  it('pins the current Saga main-push CI cohort scope', () => {
    assert.equal(
      sagaRegistry.scopes.find((scope) => scope.name === 'ci-release').slots.ci_first_attempt.scope_version,
      'main-push-current-config-ci-v2',
    );
  });

  it('accepts the current Saga producer registry and rejects its prior CI cohort declaration', async () => {
    const runId = 817;
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    };
    const archive = makeObjectiveArchive('sagascript', runId, 1);
    const parsed = await parseObjectiveArtifact(archive, provenance);
    assert.equal(parsed.snapshots.length, sagaRegistry.scopes.length);

    const priorRegistry = clone(sagaRegistry);
    priorRegistry.scopes.find((scope) => scope.name === 'ci-release').slots.ci_first_attempt.scope_version = 'main-push-ci-v1';
    const priorEntries = [...parseZipArchive(archive).files.entries()].map(([name, bytes]) => [
      name, name === 'scope-registry.json' ? JSON.stringify(priorRegistry) : bytes,
    ]);
    await assert.rejects(parseObjectiveArtifact(zipStored(priorEntries), provenance), /scope registry differs from the pinned producer registry/);
  });

  describe('Saga scope inventory', () => {
    const runId = 818;
    const provenance = {
      repositoryOwner: 'Magnus-Gille', repositoryName: 'sagascript', headSha: COMMIT,
      runId, attempt: 1, artifactCreatedAt: '2026-10-10T10:02:00Z',
    };
    const withRegistry = (mutate) => {
      const archive = makeObjectiveArchive('sagascript', runId, 1);
      const registry = clone(sagaRegistry);
      mutate(registry);
      return zipStored([...parseZipArchive(archive).files.entries()].map(([name, bytes]) => [
        name, name === 'scope-registry.json' ? JSON.stringify(registry) : bytes,
      ]));
    };
    const rejects = (mutate, pattern) => assert.rejects(parseObjectiveArtifact(withRegistry(mutate), provenance), pattern);
    const malformed = /complexity scope inventory is malformed/;
    const differs = /differs from the pinned producer registry/;

    it('accepts membership drift in complexity scope file lists', async () => {
      const parsed = await parseObjectiveArtifact(withRegistry((registry) => {
        const { scopes } = registry.complexity;
        const moved = scopes['rust-cli'].pop();
        scopes['rust-core'].push(moved, 'src-tauri/crates/synthetic/src/brand_new.rs');
        scopes['rust-cli'].reverse();
      }), provenance);
      assert.equal(parsed.snapshots.length, sagaRegistry.scopes.length);
    });

    it('accepts the inventory size boundaries', async () => {
      await parseObjectiveArtifact(withRegistry((r) => { r.complexity.scopes['rust-cli'] = ['src/synthetic/only.rs']; }), provenance);
      await parseObjectiveArtifact(withRegistry((r) => {
        r.complexity.scopes['rust-core'] = Array.from({ length: 2000 }, (_, i) => `src/synthetic/f${i}.rs`);
      }), provenance);
    });

    it('still rejects non-inventory registry changes', async () => {
      await rejects((r) => { r.scopes.find((s) => s.name === 'rust-cli').slots.coverage.scope_version = 'changed'; }, differs);
      await rejects((r) => { delete r.coverage.rust_cli; }, differs);
      await rejects((r) => { r.complexity.threshold = r.complexity.threshold === 99 ? 98 : 99; }, differs);
      await rejects((r) => { r.complexity.algorithm = `${r.complexity.algorithm}-changed`; }, differs);
    });

    it('rejects malformed scope inventories', async () => {
      await rejects((r) => { r.complexity.scopes['rust-extra'] = ['src/extra.rs']; }, malformed);
      await rejects((r) => { delete r.complexity.scopes['rust-cli']; }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-cli'] = 'src/a.rs'; }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-cli'] = []; }, malformed);
      await rejects((r) => { r.complexity.scopes = []; }, malformed);
      await rejects((r) => { r.complexity = []; }, malformed);
      await rejects((r) => { r.complexity = null; }, malformed);
      await rejects((r) => { r.complexity.scopes = null; }, malformed);
      await rejects((r) => { r.complexity.scopes = 'rust-core'; }, malformed);
      await rejects((r) => {
        Object.defineProperty(r.complexity.scopes, '__proto__', { value: ['src/synthetic/a.rs'], enumerable: true });
      }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('src\\synthetic\\a.rs'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('src/synthetic/a\0.rs'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('C:/synthetic/a.rs'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push(`${'a/'.repeat(120)}b.rs`); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('../outside.rs'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('/abs/path.rs'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push(42); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push(r.complexity.scopes['rust-core'][0]); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push(r.complexity.scopes['rust-cli'][0]); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('src/synthetic/other.py'); }, malformed);
      await rejects((r) => { r.complexity.scopes['rust-core'].push('src/synthetic/noext'); }, malformed);
      await rejects((r) => {
        r.complexity.scopes['rust-core'] = Array.from({ length: 2001 }, (_, i) => `src/synthetic/f${i}.rs`);
      }, malformed);
    });
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
      assert.ok(!slot.points.some((point) => point.status === 'unknown' && point.reason === 'not-collected'));
    }
    const ci = history.slots.find((item) => item.scope === 'ci-release' && item.metric === 'ci_first_attempt');
    assert.equal(ci.latest.snapshot_id.startsWith('ref:ci-only-t2'), true);
    assert.equal(ci.latest.current_status, 'measured');
    db.close();
  });

  it('keeps weekly static history free of daily not-collected cadence rows', async () => {
    const db = memoryDb();
    const day = (offset) => new Date(Date.parse('2026-10-12T10:00:00Z') + offset * 86400000).toISOString().replace('.000Z', 'Z');
    let runId = 2000;
    for (let offset = 0; offset < 42; offset += 1) {
      const weekly = offset % 7 === 0;
      const at = day(offset);
      runId += 1;
      await admitSagaFixture(db, {
        runId, snapshotId: `ref:cadence-${runId}`, artifactCreatedAt: at, collectedAt: at,
        mutate: (parsed) => {
          for (const [index, snapshot] of parsed.snapshots.entries()) {
            const scope = sagaRegistry.scopes[index].name;
            snapshot.observed_at = at;
            for (const metricName of Object.keys(snapshot.metrics)) {
              snapshot.metrics[metricName].observed_at = at;
              if (metricName === 'confirmed_regressions') snapshot.metrics[metricName].payload.as_of = at;
              const isCi = scope === 'ci-release' && metricName === 'ci_first_attempt';
              if (!weekly && !isCi) setStaticMetricState(snapshot, metricName, 'unknown', 'not-collected', at);
            }
          }
        },
      });
    }
    const history = await getObjectiveHistory(db, {
      repoOwner: 'Magnus-Gille', repoName: 'sagascript', asOf: day(43),
    });
    for (const scope of ['rust-core', 'rust-cli', 'swift-coreml']) {
      const slot = history.slots.find((item) => item.scope === scope && item.metric === 'coverage');
      assert.equal(slot.points.length, 6, scope);
      assert.ok(slot.points.every((point) => point.status === 'measured'));
    }
    const ci = history.slots.find((item) => item.scope === 'ci-release' && item.metric === 'ci_first_attempt');
    assert.equal(ci.points.length, 42);
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

// A read-only GitHub fake serving many runs per repository through the real
// transport, so settled-run filtering and the eligible-run limit are exercised
// end to end. Every request endpoint is recorded.
const GH_REPO_IDS = Object.freeze({ 'gille-inference': 4001, sagascript: 4002 });
function syntheticRun(id, index, archive, attempt = 1) {
  const created = new Date(Date.parse('2026-10-09T09:00:00Z') - index * 3600000).toISOString().replace('.000Z', 'Z');
  return { id, attempt, createdAt: created, archive };
}

function multiRunGh(runsByRepo) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const endpoint = args.at(-1);
    calls.push(endpoint);
    const match = /^repos\/Magnus-Gille\/([a-z-]+)\/actions\/(.*)$/.exec(endpoint);
    if (!match) { callback(new Error('unexpected fixture request'), '', ''); return; }
    const [, repo, rest] = match;
    const runs = runsByRepo[repo] || [];
    const repoId = GH_REPO_IDS[repo];
    const identity = { id: repoId, full_name: `Magnus-Gille/${repo}` };
    const runJson = (run) => ({
      id: run.id, workflow_id: 55, run_attempt: run.attempt, status: 'completed', event: 'schedule',
      head_branch: 'main', head_sha: COMMIT, created_at: run.createdAt, updated_at: '2026-10-09T10:06:00Z',
      repository: identity, head_repository: identity,
    });
    const byId = (id) => runs.find((run) => run.id === Number(id));
    let value;
    let found;
    if (rest === 'workflows/code-health.yml') value = { id: 55, path: '.github/workflows/code-health.yml' };
    else if (rest.startsWith('workflows/code-health.yml/runs?')) {
      const page = Number(new URLSearchParams(rest.split('?')[1]).get('page'));
      value = { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 25, page * 25).map(runJson) };
    } else if ((found = /^runs\/(\d+)$/.exec(rest))) value = runJson(byId(found[1]));
    else if ((found = /^runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(rest))) {
      const run = byId(found[1]);
      value = { total_count: 1, jobs: [{ id: run.id * 10, run_id: run.id, run_attempt: run.attempt, status: 'completed',
        started_at: '2026-10-09T10:01:00Z', completed_at: '2026-10-09T10:05:00Z' }] };
    } else if ((found = /^runs\/(\d+)\/artifacts\?/.exec(rest))) {
      const run = byId(found[1]);
      value = { total_count: 1, artifacts: [{ id: run.id + 100000, name: 'code-health-v1', size_in_bytes: run.archive.length,
        expired: false, created_at: '2026-10-09T10:02:00Z',
        workflow_run: { id: run.id, repository_id: repoId, head_repository_id: repoId, head_branch: 'main', head_sha: COMMIT } }] };
    } else if ((found = /^artifacts\/(\d+)\/zip$/.exec(rest))) {
      const run = byId(Number(found[1]) - 100000);
      callback(null, run.archive, '');
      return;
    } else { callback(new Error('unexpected fixture request'), '', ''); return; }
    callback(null, JSON.stringify(value), '');
  };
  return {
    calls,
    execFile,
    perRunCalls: () => calls.filter((endpoint) => /\/actions\/(runs\/\d+|artifacts\/\d+)/.test(endpoint)),
    downloads: () => calls.filter((endpoint) => endpoint.endsWith('/zip')),
  };
}

function gilleRuns(count, { firstId = 7000, bad = new Set() } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const id = firstId + index;
    const archive = bad.has(id) ? Buffer.from('not a zip archive') : makeObjectiveArchive('gille-inference', id, 1, { snapshotId: `ref:run-${id}` });
    return syntheticRun(id, index, archive);
  });
}

const auditRows = (db, repo = 'gille-inference') => db.prepare(`SELECT status, record_count FROM code_health_audit
  WHERE source_id = ? ORDER BY id`).all(`objective:Magnus-Gille/${repo}`);
const runRow = (db, runId) => db.prepare(`SELECT outcome, reason_code, artifact_id, run_created_at, first_handled_at, last_handled_at
  FROM code_health_objective_runs WHERE repo_owner = 'Magnus-Gille' AND repo_name = 'gille-inference' AND run_id = ? AND attempt = 1`).get(runId);
const gilleState = (db) => readObjectiveSourceState(db, { repoOwner: 'Magnus-Gille', repoName: 'gille-inference', enabled: true, configured: true });

async function cycle(db, fixture, at = NOW) {
  const { createGitHubTransport } = require('../src/code-health/github-transport');
  const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => new Date(NOW) });
  const before = fixture.calls.length;
  const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(at), transport });
  return { result, calls: fixture.calls.slice(before) };
}

describe('objective collection settled runs and cycle status', () => {
  it('skips settled runs: >10 eligible all settled reports current with no per-run calls and one audit row', async () => {
    const db = memoryDb();
    const runs = gilleRuns(15);
    const insert = db.prepare(`INSERT INTO code_health_objective_runs (repo_owner, repo_name, run_id, attempt, outcome,
      artifact_id, run_created_at, first_handled_at, last_handled_at, expires_at)
      VALUES ('Magnus-Gille', 'gille-inference', ?, 1, 'admitted', ?, ?, ?, ?, '2027-04-01T00:00:00Z')`);
    for (const run of runs) insert.run(run.id, run.id + 100000, run.createdAt, NOW, NOW);
    const fixture = multiRunGh({ 'gille-inference': runs });
    const { result, calls } = await cycle(db, fixture);
    assert.equal(result.status, 'current');
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.sources, [{ repository: 'gille-inference', status: 'current' }, { repository: 'sagascript', status: 'no-artifacts' }]);
    assert.equal(calls.filter((endpoint) => endpoint.endsWith('/zip')).length, 0);
    assert.equal(calls.filter((endpoint) => /\/actions\/(runs\/\d+|artifacts\/\d+)/.test(endpoint)).length, 0);
    assert.deepEqual(auditRows(db), [{ status: 'current', record_count: 0 }]);
    const state = gilleState(db);
    assert.equal(state.status, 'current');
    assert.equal(state.last_error_code, null);
    assert.equal(state.rejected_runs, 0);
    db.close();
  });

  it('drains a pre-existing backlog with an empty runs table and settles into current', async () => {
    const db = memoryDb();
    const runs = gilleRuns(15);
    // Simulate a database from before run bookkeeping: snapshots were admitted,
    // but the new runs table starts empty.
    for (const run of runs) {
      const provenance = { repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
        runId: run.id, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z' };
      await admitObjectiveArtifact(db, await parseObjectiveArtifact(run.archive, provenance), provenance, '2026-10-09T12:00:00Z');
    }
    db.prepare('DELETE FROM code_health_objective_runs').run();
    db.prepare('DELETE FROM code_health_audit').run();
    const fixture = multiRunGh({ 'gille-inference': runs });

    const first = await cycle(db, fixture);
    assert.equal(first.result.replayed, 10);
    assert.equal(first.result.admitted, 0);
    assert.equal(first.calls.filter((endpoint) => endpoint.endsWith('/zip')).length, 10);
    assert.equal(gilleState(db).status, 'incomplete', 'more unsettled runs than the limit remain');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM code_health_objective_runs WHERE outcome = 'admitted'").get().n, 10);

    const second = await cycle(db, fixture);
    assert.equal(second.result.replayed, 5);
    assert.equal(second.calls.filter((endpoint) => endpoint.endsWith('/zip')).length, 5);
    assert.equal(gilleState(db).status, 'current');

    const third = await cycle(db, fixture);
    assert.equal(third.result.status, 'current');
    assert.equal(third.calls.filter((endpoint) => endpoint.endsWith('/zip')).length, 0);
    assert.deepEqual(auditRows(db).map((row) => row.status), ['incomplete', 'current', 'current']);
    db.close();
  });

  it('reports a rejected newest artifact over truncation and recovers it once the artifact admits', async () => {
    const db = memoryDb();
    const runs = gilleRuns(15, { bad: new Set([7000]) });
    const fixture = multiRunGh({ 'gille-inference': runs });
    const first = await cycle(db, fixture, '2026-10-10T12:00:00Z');
    assert.equal(first.result.incomplete, true);
    assert.equal(first.result.rejected, 1);
    assert.equal(first.result.admitted, 9);
    assert.equal(first.result.sources[0].status, 'rejected');
    let state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.last_error_code, 'objective-report-rejected');
    assert.equal(state.last_rejection_code, 'artifact-parse-rejected');
    assert.equal(state.last_rejection_at, '2026-10-10T12:00:00Z');
    assert.equal(state.rejected_runs, 1);
    // The in-transaction rows for real insertions stay; no per-candidate
    // rejected row is written, and the cycle row is last.
    const rows = auditRows(db);
    assert.equal(rows.filter((row) => row.status === 'committed').length, 9);
    assert.ok(rows.filter((row) => row.status === 'committed').every((row) => row.record_count === 1));
    assert.deepEqual(rows.at(-1), { status: 'rejected', record_count: 0 });
    assert.equal(rows.filter((row) => row.status === 'rejected').length, 1);
    assert.deepEqual(runRow(db, 7000), {
      outcome: 'rejected', reason_code: 'artifact-parse-rejected', artifact_id: 107000,
      run_created_at: '2026-10-09T09:00:00Z', first_handled_at: '2026-10-10T12:00:00Z', last_handled_at: '2026-10-10T12:00:00Z',
    });

    // Rejected runs stay unsettled and are retried; the row tracks the latest attempt.
    const second = await cycle(db, fixture, '2026-10-10T12:05:00Z');
    assert.equal(second.result.rejected, 1);
    assert.equal(second.calls.filter((endpoint) => endpoint.endsWith('/artifacts/107000/zip')).length, 1);
    state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.last_rejection_at, '2026-10-10T12:05:00Z');
    assert.equal(runRow(db, 7000).first_handled_at, '2026-10-10T12:00:00Z');

    // A later fix makes the artifact admissible: the row flips to admitted.
    runs[0].archive = makeObjectiveArchive('gille-inference', 7000, 1, { snapshotId: 'ref:run-7000' });
    const third = await cycle(db, fixture, '2026-10-10T12:10:00Z');
    assert.equal(third.result.admitted, 1);
    assert.equal(third.result.rejected, 0);
    assert.equal(runRow(db, 7000).outcome, 'admitted');
    assert.equal(runRow(db, 7000).reason_code, null);
    state = gilleState(db);
    assert.equal(state.status, 'committed');
    assert.equal(state.rejected_runs, 0);
    assert.equal(state.last_rejection_code, null);
    assert.equal((await cycle(db, fixture, '2026-10-10T12:15:00Z')).result.status, 'current');
    db.close();
  });

  it('keeps more than ten unsettled runs and the provider page limit incomplete despite settled filtering', async () => {
    const db = memoryDb();
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(11) });
    const { result } = await cycle(db, fixture);
    assert.equal(result.admitted, 10);
    assert.equal(gilleState(db).status, 'incomplete');
    assert.equal((await cycle(db, fixture)).result.sources[0].status, 'committed');

    // 51 runs exceed RUN_PAGE_LIMIT × RUN_PAGE_SIZE: still fail-closed even
    // when every listed run is already settled.
    const pageDb = memoryDb();
    const many = gilleRuns(51).map((run) => ({ ...run, createdAt: new Date(Date.parse('2026-10-09T09:00:00Z') - (run.id - 7000) * 600000).toISOString().replace('.000Z', 'Z') }));
    const insert = pageDb.prepare(`INSERT INTO code_health_objective_runs (repo_owner, repo_name, run_id, attempt, outcome,
      run_created_at, first_handled_at, last_handled_at, expires_at)
      VALUES ('Magnus-Gille', 'gille-inference', ?, 1, 'admitted', ?, ?, ?, '2027-04-01T00:00:00Z')`);
    for (const run of many) insert.run(run.id, run.createdAt, NOW, NOW);
    const paged = await cycle(pageDb, multiRunGh({ 'gille-inference': many }));
    assert.equal(paged.result.incomplete, true);
    assert.equal(paged.calls.filter((endpoint) => endpoint.endsWith('/zip')).length, 0);
    assert.equal(gilleState(pageDb).status, 'incomplete');
    db.close();
    pageDb.close();
  });

  it('records a bounded stage reason for every rejection step without exposing error text', async () => {
    const good = makeObjectiveArchive('gille-inference', 9100, 1, { snapshotId: 'ref:stage-good' });
    const collision = makeObjectiveArchive('gille-inference', 9101, 1, { snapshotId: 'ref:stage-good', observedAt: '2026-10-09T10:01:00Z' });
    // A failed download is an incomplete read, not a rejection: see
    // 'objective collection download failures'.
    const cases = [
      ['transport-provenance-invalid', (metadata) => { metadata.run.repository_owner = 'attacker'; }, async () => good],
      ['artifact-size-mismatch', (metadata) => { metadata.artifact.size_in_bytes += 1; }, async () => good],
      ['artifact-parse-rejected', (metadata) => { metadata.artifact.size_in_bytes = 17; }, async () => Buffer.from('not a zip archive')],
      ['admission-rejected', (metadata) => { metadata.artifact.size_in_bytes = collision.length; }, async () => collision, true],
    ];
    for (const [reason, mutate, download, seed] of cases) {
      const db = memoryDb();
      if (seed) {
        const provenance = { repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
          runId: 9100, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z' };
        await admitObjectiveArtifact(db, await parseObjectiveArtifact(good, provenance), provenance, NOW);
        db.prepare('DELETE FROM code_health_audit').run();
      }
      const metadata = transportMetadata('gille-inference', seed ? 9101 : 9100, 1, good);
      mutate(metadata);
      const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
        listArtifacts: async ({ repository }) => repository === 'gille-inference' ? { candidates: [metadata], incomplete: false } : { candidates: [], incomplete: false },
        downloadArtifact: download,
      } });
      assert.equal(result.rejected, 1, reason);
      const row = db.prepare(`SELECT outcome, reason_code FROM code_health_objective_runs WHERE run_id = ?`).get(seed ? 9101 : 9100);
      assert.deepEqual(row, { outcome: 'rejected', reason_code: reason }, reason);
      assert.deepEqual(auditRows(db), [{ status: 'rejected', record_count: 0 }], reason);
      const state = gilleState(db);
      assert.equal(state.last_rejection_code, reason);
      assert.doesNotMatch(JSON.stringify(state), /private|stderr|collision|zip/);
      db.close();
    }
  });

  it('writes no audit row for a replay-only admission but still settles the run', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference', 9200, 1, { snapshotId: 'ref:replay-only' });
    const provenance = { repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 9200, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z' };
    const parsed = await parseObjectiveArtifact(archive, provenance);
    await admitObjectiveArtifact(db, parsed, provenance, NOW);
    assert.equal(auditRows(db).length, 1);
    db.prepare('DELETE FROM code_health_objective_runs').run();
    const replay = await admitObjectiveArtifact(db, parsed, provenance, '2026-10-11T12:00:00Z');
    assert.equal(replay.replayed, 1);
    assert.equal(auditRows(db).length, 1);
    assert.equal(runRow(db, 9200).outcome, 'admitted');

    // An injected transport that ignores the predicate never re-downloads a settled run.
    let downloads = 0;
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'gille-inference' ? [transportMetadata('gille-inference', 9200, 1, archive)] : [],
      downloadArtifact: async () => { downloads += 1; return archive; },
    } });
    assert.equal(downloads, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.sources[0].status, 'current');
    db.close();
  });

  it('prunes expired run rows without touching retained ones', () => {
    const db = memoryDb();
    const insert = db.prepare(`INSERT INTO code_health_objective_runs (repo_owner, repo_name, run_id, attempt, outcome,
      reason_code, first_handled_at, last_handled_at, expires_at)
      VALUES ('Magnus-Gille', 'gille-inference', ?, 1, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`);
    insert.run(1, 'admitted', null, '2026-07-01T00:00:00Z');
    insert.run(2, 'rejected', 'artifact-parse-rejected', '2026-07-01T00:00:00Z');
    insert.run(3, 'admitted', null, '2027-01-01T00:00:00Z');
    const expired = pruneExpiredEvidence(db, NOW);
    assert.equal(expired.runs, 2);
    assert.deepEqual(db.prepare('SELECT run_id FROM code_health_objective_runs').all(), [{ run_id: 3 }]);
    assert.equal(db.prepare("SELECT record_count FROM code_health_audit WHERE source_kind = 'retention'").get().record_count, 2);
    db.close();
  });

  it('keeps admitted run rows well beyond the 30-day listing window', async () => {
    const db = memoryDb();
    const archive = makeObjectiveArchive('gille-inference', 9300, 1, { snapshotId: 'ref:retained-run' });
    const provenance = { repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 9300, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z' };
    await admitObjectiveArtifact(db, await parseObjectiveArtifact(archive, provenance), provenance, NOW);
    const { expires_at: expiresAt } = db.prepare('SELECT expires_at FROM code_health_objective_runs WHERE run_id = 9300').get();
    assert.ok(Date.parse(expiresAt) - Date.parse(NOW) > 90 * 86400000);
    db.close();
  });

  it('drops a rejected run that is no longer retried, so it stops reading as a current rejection', () => {
    const { recordRejectedRun } = require('../src/code-health/store');
    const db = memoryDb();
    const source = { repoOwner: 'Magnus-Gille', repoName: 'gille-inference', enabled: true, configured: true };
    const rejection = { repoOwner: 'Magnus-Gille', repoName: 'gille-inference', runId: 9400, attempt: 1, reasonCode: 'artifact-parse-rejected' };
    recordRejectedRun(db, rejection, '2026-10-10T12:00:00Z');
    // Retried the next day: the retry keeps the row alive.
    assert.equal(pruneExpiredEvidence(db, '2026-10-11T11:00:00Z').runs, 0);
    recordRejectedRun(db, rejection, '2026-10-11T11:00:00Z');
    assert.equal(pruneExpiredEvidence(db, '2026-10-12T10:00:00Z').runs, 0);
    assert.equal(readObjectiveSourceState(db, source).rejected_runs, 1);
    // Not retried for more than a day (aged out of the listing window): gone.
    assert.equal(pruneExpiredEvidence(db, '2026-10-12T11:00:01Z').runs, 1);
    const state = readObjectiveSourceState(db, source);
    assert.equal(state.rejected_runs, 0);
    assert.equal(state.last_rejection_at, null);
    assert.equal(state.last_rejection_code, null);
    db.close();
  });
});

describe('objective collection download failures', () => {
  const runCount = (db, runId) => db.prepare('SELECT COUNT(*) AS n FROM code_health_objective_runs WHERE run_id = ?').get(runId).n;
  const failingDownloads = [
    ['throws', async () => { throw new Error('github-read-unavailable private stderr details'); }],
    ['returns no bytes', async () => 'not bytes'],
  ];

  function candidate(runId, artifactId, archive, createdAt = '2026-10-09T10:00:00Z') {
    const metadata = transportMetadata('gille-inference', runId, 1, archive);
    metadata.artifact.id = artifactId;
    metadata.run.created_at = createdAt;
    return metadata;
  }

  // An injected transport lists `candidates` for gille-inference and serves
  // downloads from `download`; every artifact download is recorded.
  async function injected(db, candidates, download, at = NOW) {
    const downloads = [];
    const result = await collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(at), transport: {
      listArtifacts: async ({ repository }) => repository === 'gille-inference'
        ? { candidates, incomplete: false } : { candidates: [], incomplete: false },
      downloadArtifact: async (request) => { downloads.push(request.artifactId); return download(request); },
    } });
    return { result, downloads };
  }

  for (const [label, failing] of failingDownloads) {
    it(`reports a download that ${label} as incomplete, records no rejected run, and retries it`, async () => {
      const db = memoryDb();
      const good = makeObjectiveArchive('gille-inference', 9700, 1, { snapshotId: 'ref:download-retry' });
      const listed = [candidate(9700, 8901, good)];
      const first = await injected(db, listed, failing);
      assert.equal(first.result.rejected, 0);
      assert.equal(first.result.downloadFailures, 1);
      assert.equal(first.result.incomplete, true);
      assert.equal(first.result.admitted, 0);
      assert.equal(first.result.status, 'partial');
      assert.deepEqual(first.result.sources, [{ repository: 'gille-inference', status: 'incomplete' }, { repository: 'sagascript', status: 'no-artifacts' }]);
      assert.deepEqual(auditRows(db), [{ status: 'incomplete', record_count: 0 }]);
      assert.equal(runCount(db, 9700), 0);
      let state = gilleState(db);
      assert.equal(state.status, 'incomplete');
      assert.equal(state.rejected_runs, 0);
      assert.equal(state.last_rejection_code, null);
      assert.doesNotMatch(JSON.stringify(state), /private|stderr/);

      // The next cycle downloads the same run again and admits it.
      const second = await injected(db, listed, async () => good, '2026-10-10T12:05:00Z');
      assert.deepEqual(second.downloads, [8901]);
      assert.equal(second.result.admitted, 1);
      assert.equal(second.result.downloadFailures, 0);
      assert.equal(second.result.sources[0].status, 'committed');
      assert.equal(runRow(db, 9700).outcome, 'admitted');
      state = gilleState(db);
      assert.equal(state.status, 'committed');
      assert.equal(state.rejected_runs, 0);
      db.close();
    });
  }

  it('lets a real rejection in the same cycle decide the status over a failed download', async () => {
    const db = memoryDb();
    const good = makeObjectiveArchive('gille-inference', 9710, 1, { snapshotId: 'ref:download-mixed-reject' });
    const bad = Buffer.from('not a zip archive');
    const { result } = await injected(db, [candidate(9710, 8910, good), candidate(9711, 8911, bad)],
      async ({ artifactId }) => { if (artifactId === 8910) throw new Error('github-read-unavailable'); return bad; });
    assert.equal(result.rejected, 1);
    assert.equal(result.supersededRejections, 0);
    assert.equal(result.downloadFailures, 1);
    assert.equal(result.incomplete, true);
    assert.equal(result.status, 'rejected');
    assert.equal(result.sources[0].status, 'rejected');
    assert.equal(runCount(db, 9710), 0);
    assert.equal(runRow(db, 9711).reason_code, 'artifact-parse-rejected');
    assert.deepEqual(auditRows(db), [{ status: 'rejected', record_count: 0 }]);
    const state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.rejected_runs, 1);
    db.close();
  });

  it('keeps a source incomplete, not committed, when an admission and a failed download share a cycle', async () => {
    const db = memoryDb();
    const good = makeObjectiveArchive('gille-inference', 9720, 1, { snapshotId: 'ref:download-mixed-admit' });
    const other = makeObjectiveArchive('gille-inference', 9721, 1, { snapshotId: 'ref:download-mixed-failed' });
    const { result } = await injected(db, [candidate(9720, 8920, good), candidate(9721, 8921, other)],
      async ({ artifactId }) => { if (artifactId === 8921) throw new Error('github-read-unavailable'); return good; });
    assert.equal(result.admitted, 1);
    assert.equal(result.rejected, 0);
    assert.equal(result.downloadFailures, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.sources[0].status, 'incomplete');
    assert.equal(runRow(db, 9720).outcome, 'admitted');
    assert.equal(runCount(db, 9721), 0);
    assert.deepEqual(auditRows(db).at(-1), { status: 'incomplete', record_count: 0 });
    assert.equal(gilleState(db).status, 'incomplete');
    db.close();
  });

  it('leaves an earlier rejected row untouched when the retry fails to download', async () => {
    const db = memoryDb();
    const bad = Buffer.from('not a zip archive');
    const listed = [candidate(9730, 8930, bad, '2026-10-09T09:30:00Z')];
    const first = await injected(db, listed, async () => bad);
    assert.equal(first.result.rejected, 1);
    const before = runRow(db, 9730);
    assert.deepEqual(before, {
      outcome: 'rejected', reason_code: 'artifact-parse-rejected', artifact_id: 8930,
      run_created_at: '2026-10-09T09:30:00Z', first_handled_at: NOW.replace('.000Z', 'Z'), last_handled_at: NOW.replace('.000Z', 'Z'),
    });

    const second = await injected(db, listed, async () => { throw new Error('github-read-unavailable'); }, '2026-10-10T12:05:00Z');
    assert.equal(second.result.rejected, 0);
    assert.equal(second.result.downloadFailures, 1);
    assert.equal(second.result.sources[0].status, 'incomplete');
    assert.deepEqual(runRow(db, 9730), before);
    assert.equal(gilleState(db).rejected_runs, 1);
    db.close();
  });

  it('stops the source on a scan-deadline download without counting a download failure', async () => {
    const db = memoryDb();
    const good = makeObjectiveArchive('gille-inference', 9740, 1, { snapshotId: 'ref:download-deadline' });
    const { result, downloads } = await injected(db, [candidate(9740, 8940, good), candidate(9741, 8941, good)],
      async () => { throw new Error('github-scan-deadline-exceeded'); });
    assert.deepEqual(downloads, [8940], 'the deadline stops the source before the next candidate');
    assert.equal(result.rejected, 0);
    assert.equal(result.downloadFailures, 0);
    assert.equal(result.incomplete, true);
    assert.equal(result.sources[0].status, 'incomplete');
    assert.equal(runCount(db, 9740), 0);
    assert.deepEqual(auditRows(db), [{ status: 'incomplete', record_count: 0 }]);
    db.close();
  });
});

describe('objective collection superseded rejections', () => {
  const { newestAdmittedRunCreatedAt, isRejectionSuperseded } = require('../src/code-health/store');
  const downloadsOf = (calls, runId) => calls.filter((endpoint) => endpoint.endsWith(`/artifacts/${runId + 100000}/zip`)).length;

  it('does not let rejections older than the newest admitted run decide the status, but still records and retries them', async () => {
    const db = memoryDb();
    // 7000 and 7001 are the newest runs and admit; 7002 and 7003 are older and rejected.
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(4, { bad: new Set([7002, 7003]) }) });
    const first = await cycle(db, fixture);
    assert.equal(first.result.admitted, 2);
    assert.equal(first.result.rejected, 2);
    assert.equal(first.result.supersededRejections, 2);
    assert.equal(first.result.status, 'committed');
    assert.equal(first.result.sources[0].status, 'committed');
    assert.equal(auditRows(db).at(-1).status, 'committed');
    assert.equal(runRow(db, 7002).outcome, 'rejected');
    assert.equal(runRow(db, 7003).reason_code, 'artifact-parse-rejected');
    let state = gilleState(db);
    assert.equal(state.status, 'committed');
    assert.equal(state.rejected_runs, 2);
    assert.equal(state.superseded_rejected_runs, 2);

    const second = await cycle(db, fixture, '2026-10-10T12:05:00Z');
    assert.equal(downloadsOf(second.calls, 7002), 1, 'superseded rejections are still retried');
    assert.equal(downloadsOf(second.calls, 7003), 1);
    assert.equal(second.result.rejected, 2);
    assert.equal(second.result.supersededRejections, 2);
    assert.equal(second.result.status, 'current');
    assert.equal(second.result.sources[0].status, 'current');
    assert.deepEqual(auditRows(db).at(-1), { status: 'current', record_count: 0 });
    assert.equal(runRow(db, 7002).last_handled_at, '2026-10-10T12:05:00Z');
    state = gilleState(db);
    assert.equal(state.status, 'current');
    assert.equal(state.last_error_code, null);
    assert.equal(state.rejected_runs, 2);
    assert.equal(state.superseded_rejected_runs, 2);
    db.close();
  });

  it('keeps rejecting when the newest runs are the rejected ones (the motivating incident)', async () => {
    const db = memoryDb();
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(3, { bad: new Set([7000, 7001]) }) });
    const first = await cycle(db, fixture);
    assert.equal(first.result.admitted, 1);
    assert.equal(first.result.supersededRejections, 0);
    assert.equal(first.result.status, 'partial');
    assert.equal(first.result.sources[0].status, 'rejected');
    const second = await cycle(db, fixture, '2026-10-10T12:05:00Z');
    assert.equal(second.result.rejected, 2);
    assert.equal(second.result.supersededRejections, 0);
    assert.equal(second.result.status, 'rejected');
    assert.equal(second.result.sources[0].status, 'rejected');
    const state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.rejected_runs, 2);
    assert.equal(state.superseded_rejected_runs, 0);
    db.close();
  });

  it('reports rejected when only some rejections are older than the newest admitted run', async () => {
    const db = memoryDb();
    // 7001 admits; 7000 is newer and 7002 older, both rejected.
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(3, { bad: new Set([7000, 7002]) }) });
    const { result } = await cycle(db, fixture);
    assert.equal(result.rejected, 2);
    assert.equal(result.supersededRejections, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.sources[0].status, 'rejected');
    const second = await cycle(db, fixture, '2026-10-10T12:05:00Z');
    assert.equal(second.result.status, 'rejected');
    const state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.rejected_runs, 2);
    assert.equal(state.superseded_rejected_runs, 1);
    db.close();
  });

  it('fails closed to rejected when no admitted run is tracked', async () => {
    const db = memoryDb();
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(2, { bad: new Set([7000, 7001]) }) });
    const { result } = await cycle(db, fixture);
    assert.equal(result.rejected, 2);
    assert.equal(result.supersededRejections, 0);
    assert.equal(result.status, 'rejected');
    assert.equal(result.sources[0].status, 'rejected');
    assert.equal(gilleState(db).superseded_rejected_runs, 0);
    db.close();
  });

  // An injected transport lists one admissible run and one rejected run.
  async function injectedCycle(db, { admittedCreatedAt, rejectedCreatedAt, mutateRejected = () => {} }) {
    const good = makeObjectiveArchive('gille-inference', 9500, 1, { snapshotId: 'ref:superseding-run' });
    const bad = Buffer.from('not a zip archive');
    const admitted = transportMetadata('gille-inference', 9500, 1, good);
    admitted.run.created_at = admittedCreatedAt;
    const rejected = transportMetadata('gille-inference', 9501, 1, bad);
    rejected.artifact.id = 8802;
    rejected.run.created_at = rejectedCreatedAt;
    mutateRejected(rejected);
    return collectObjectiveReports({ db, config: { enabled: true }, clock: () => new Date(NOW), transport: {
      listArtifacts: async ({ repository }) => repository === 'gille-inference'
        ? { candidates: [rejected, admitted], incomplete: false } : { candidates: [], incomplete: false },
      downloadArtifact: async ({ artifactId }) => artifactId === 8802 ? bad : good,
    } });
  }

  it('counts an admission made later in the same cycle and compares creation times strictly', async () => {
    const earlier = memoryDb();
    const superseded = await injectedCycle(earlier, { admittedCreatedAt: '2026-10-09T10:00:00Z', rejectedCreatedAt: '2026-10-09T09:59:59Z' });
    assert.equal(superseded.supersededRejections, 1);
    assert.equal(superseded.sources[0].status, 'committed');
    assert.equal(gilleState(earlier).superseded_rejected_runs, 1);
    earlier.close();

    const equal = memoryDb();
    const same = await injectedCycle(equal, { admittedCreatedAt: '2026-10-09T10:00:00Z', rejectedCreatedAt: '2026-10-09T10:00:00Z' });
    assert.equal(same.rejected, 1);
    assert.equal(same.supersededRejections, 0);
    assert.equal(same.sources[0].status, 'rejected');
    assert.equal(gilleState(equal).superseded_rejected_runs, 0);
    equal.close();
  });

  it('fails closed to rejected when the rejected run has no known creation time', async () => {
    const db = memoryDb();
    const result = await injectedCycle(db, {
      admittedCreatedAt: '2026-10-09T10:00:00Z',
      rejectedCreatedAt: '2026-10-01T00:00:00Z',
      mutateRejected: (metadata) => { metadata.run.repository_owner = 'attacker'; },
    });
    assert.equal(result.admitted, 1);
    assert.equal(result.rejected, 1);
    assert.equal(result.supersededRejections, 0);
    assert.equal(result.sources[0].status, 'rejected');
    const row = db.prepare('SELECT reason_code, run_created_at FROM code_health_objective_runs WHERE run_id = 9501').get();
    assert.deepEqual(row, { reason_code: 'transport-provenance-invalid', run_created_at: null });
    assert.equal(gilleState(db).superseded_rejected_runs, 0);
    db.close();
  });

  it('forgets a creation time the latest retry could not validate, so the page agrees with the status', async () => {
    const db = memoryDb();
    const times = { admittedCreatedAt: '2026-10-09T10:00:00Z', rejectedCreatedAt: '2026-10-09T09:00:00Z' };
    const first = await injectedCycle(db, times);
    assert.equal(first.supersededRejections, 1);
    assert.equal(first.sources[0].status, 'committed');
    assert.equal(gilleState(db).superseded_rejected_runs, 1);

    // The same run is retried, but its metadata no longer validates.
    const second = await injectedCycle(db, { ...times, mutateRejected: (metadata) => { metadata.run.repository_owner = 'attacker'; } });
    assert.equal(second.rejected, 1);
    assert.equal(second.supersededRejections, 0);
    assert.equal(second.sources[0].status, 'rejected');
    const row = db.prepare('SELECT reason_code, run_created_at FROM code_health_objective_runs WHERE run_id = 9501').get();
    assert.deepEqual(row, { reason_code: 'transport-provenance-invalid', run_created_at: null });
    const state = gilleState(db);
    assert.equal(state.status, 'rejected');
    assert.equal(state.rejected_runs, 1);
    assert.equal(state.superseded_rejected_runs, 0);

    // Valid again on the next retry: superseded again, in both places.
    const third = await injectedCycle(db, times);
    assert.equal(third.supersededRejections, 1);
    assert.equal(third.sources[0].status, 'current');
    assert.equal(gilleState(db).superseded_rejected_runs, 1);
    db.close();
  });

  it('reads superseded rejected rows against tracked admitted run creation times only', async () => {
    const db = memoryDb();
    const insert = db.prepare(`INSERT INTO code_health_objective_runs (repo_owner, repo_name, run_id, attempt, outcome,
      reason_code, run_created_at, first_handled_at, last_handled_at, expires_at)
      VALUES ('Magnus-Gille', 'gille-inference', ?, 1, ?, ?, ?, ?, ?, '2027-04-01T00:00:00Z')`);
    const rejected = (runId, createdAt) => insert.run(runId, 'rejected', 'artifact-parse-rejected', createdAt, NOW, NOW);
    rejected(1, '2026-10-09T09:00:00Z');
    rejected(2, null);
    assert.equal(newestAdmittedRunCreatedAt(db, 'Magnus-Gille', 'gille-inference'), null);
    let state = gilleState(db);
    assert.deepEqual([state.rejected_runs, state.superseded_rejected_runs], [2, 0]);

    // A snapshot collected by this collector's clock is not a tracked admitted
    // run: it moves last_admitted_run_at but never supersedes a rejection.
    const archive = makeObjectiveArchive('gille-inference', 9600, 1, { snapshotId: 'ref:untracked' });
    const provenance = { repositoryOwner: 'Magnus-Gille', repositoryName: 'gille-inference', headSha: COMMIT,
      runId: 9600, attempt: 1, artifactCreatedAt: '2026-10-09T10:02:00Z' };
    await admitObjectiveArtifact(db, await parseObjectiveArtifact(archive, provenance), provenance, NOW);
    db.prepare('DELETE FROM code_health_objective_runs WHERE run_id = 9600').run();
    state = gilleState(db);
    assert.ok(state.last_admitted_run_at);
    assert.equal(state.superseded_rejected_runs, 0);

    insert.run(10, 'admitted', null, '2026-10-09T10:00:00Z', NOW, NOW);
    insert.run(11, 'admitted', null, null, NOW, NOW);
    rejected(3, '2026-10-09T10:00:00Z');
    rejected(4, '2026-10-09T11:00:00Z');
    rejected(5, '2026-10-09T10:00:00.250Z');
    state = gilleState(db);
    assert.equal(state.rejected_runs, 5);
    assert.equal(state.superseded_rejected_runs, 1, 'only the 09:00 rejection; NULL, equal and later ones are not superseded');

    // Mixed precision is compared as instants, not as strings.
    insert.run(12, 'admitted', null, '2026-10-09T10:00:00.500Z', NOW, NOW);
    assert.equal(newestAdmittedRunCreatedAt(db, 'Magnus-Gille', 'gille-inference'), '2026-10-09T10:00:00.500Z');
    state = gilleState(db);
    assert.equal(state.superseded_rejected_runs, 3, '09:00, 10:00:00 and 10:00:00.250 are older than 10:00:00.500');
    assert.equal(readObjectiveSourceState(db, { repoOwner: 'Magnus-Gille', repoName: 'sagascript' }).superseded_rejected_runs, 0);
    db.close();
  });

  it('decides supersession only from two valid instants with the rejection strictly earlier', () => {
    assert.equal(isRejectionSuperseded('2026-10-09T09:00:00Z', '2026-10-09T10:00:00Z'), true);
    assert.equal(isRejectionSuperseded('2026-10-09T10:00:00Z', '2026-10-09T10:00:00Z'), false);
    assert.equal(isRejectionSuperseded('2026-10-09T11:00:00Z', '2026-10-09T10:00:00Z'), false);
    assert.equal(isRejectionSuperseded(null, '2026-10-09T10:00:00Z'), false);
    assert.equal(isRejectionSuperseded('not a time', '2026-10-09T10:00:00Z'), false);
    assert.equal(isRejectionSuperseded('2026-10-09T09:00:00Z', null), false);
    assert.equal(isRejectionSuperseded('2026-10-09T09:00:00Z', 'not a time'), false);
  });
});

describe('GitHub transport settled-run predicate', () => {
  const { createGitHubTransport, ELIGIBLE_RUN_LIMIT } = require('../src/code-health/github-transport');
  const request = { owner: 'Magnus-Gille', repository: 'gille-inference', workflowPath: '.github/workflows/code-health.yml',
    branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' };

  it('behaves as before without a predicate: the eligible-run limit truncates and flags incomplete', async () => {
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(ELIGIBLE_RUN_LIMIT + 2) });
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => new Date(NOW) });
    const listing = await transport.listArtifacts(request);
    assert.deepEqual(Object.keys(listing).sort(), ['candidates', 'incomplete']);
    assert.equal(listing.incomplete, true);
    assert.equal(listing.candidates.length, ELIGIBLE_RUN_LIMIT);
    assert.deepEqual(listing.candidates.map((candidate) => candidate.run.id), Array.from({ length: 10 }, (_, index) => 7000 + index));
  });

  it('drops settled attempts before the limit and before any per-run request', async () => {
    const fixture = multiRunGh({ 'gille-inference': gilleRuns(ELIGIBLE_RUN_LIMIT + 2) });
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => new Date(NOW) });
    const asked = [];
    const listing = await transport.listArtifacts({ ...request, isSettled: (runId, attempt) => {
      asked.push([runId, attempt]);
      return runId < 7005;
    } });
    assert.equal(asked.length, ELIGIBLE_RUN_LIMIT + 2);
    assert.ok(asked.every(([, attempt]) => attempt === 1));
    assert.equal(listing.incomplete, false);
    assert.equal(listing.settledRuns, 5);
    assert.deepEqual(listing.candidates.map((candidate) => candidate.run.id), [7005, 7006, 7007, 7008, 7009, 7010, 7011]);
    assert.equal(fixture.perRunCalls().filter((endpoint) => /\/runs\/700[0-4]\b/.test(endpoint)).length, 0);
  });

  it('treats a new attempt of a settled run as unsettled', async () => {
    const runs = gilleRuns(1);
    runs[0].attempt = 2;
    runs[0].archive = makeObjectiveArchive('gille-inference', 7000, 2, { snapshotId: 'ref:run-7000-attempt-2' });
    const fixture = multiRunGh({ 'gille-inference': runs });
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => new Date(NOW) });
    const listing = await transport.listArtifacts({ ...request, isSettled: (runId, attempt) => runId === 7000 && attempt === 1 });
    assert.equal(listing.settledRuns, 0);
    assert.equal(listing.candidates.length, 1);
    assert.equal(listing.candidates[0].run.attempt, 2);
  });

  it('keeps a settled attempt whose listed metadata fails provenance validation as incomplete', async () => {
    // The listing accepts a run without `updated_at`; the per-run revision check
    // does not. Settling the attempt earlier must not hide that fail-closed signal.
    const listingWithoutUpdatedAt = () => {
      const fixture = multiRunGh({ 'gille-inference': gilleRuns(3) });
      const execFile = (file, args, options, callback) => fixture.execFile(file, args, options, (error, stdout, stderr) => {
        if (error || !/workflows\/code-health\.yml\/runs\?/.test(args.at(-1))) { callback(error, stdout, stderr); return; }
        const page = JSON.parse(stdout);
        for (const run of page.workflow_runs) if (run.id === 7000) delete run.updated_at;
        callback(null, JSON.stringify(page), stderr);
      });
      return { fixture, transport: createGitHubTransport({ execFile, now: () => new Date(NOW) }) };
    };

    const unfiltered = await listingWithoutUpdatedAt().transport.listArtifacts(request);
    assert.equal(unfiltered.incomplete, true);
    assert.deepEqual(unfiltered.candidates.map((candidate) => candidate.run.id).sort(), [7001, 7002]);

    const { fixture, transport } = listingWithoutUpdatedAt();
    const asked = [];
    const listing = await transport.listArtifacts({ ...request, isSettled: (runId) => { asked.push(runId); return true; } });
    assert.equal(listing.incomplete, true);
    assert.equal(listing.settledRuns, 2);
    assert.deepEqual(listing.candidates, []);
    // The predicate is only consulted for runs that passed revision validation.
    assert.deepEqual(asked.sort(), [7001, 7002]);
    assert.equal(fixture.perRunCalls().length, 0);
  });
});
