'use strict';

// Isolated, loopback-only preview for visual review. It uses a temporary HOME,
// temporary SQLite file, and injected synthetic read providers. No collectors
// or source transports are configured or started.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-demo-'));
process.env.HOME = path.join(tempRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.HEIMDALL_CONFIG_PATH = path.join(tempRoot, 'no-config.json');
process.env.GRIMNIR_SERVICES_JSON = path.join(tempRoot, 'no-services.json');

const { openDatabase } = require('../src/db');
const { EXPECTED_SLOTS } = require('../src/code-health/registry');
const { buildApp } = require('../src/server');

const now = new Date();
const nowIso = now.toISOString();
const commit = 'a'.repeat(40);

function point(metric, scope, { id, at = nowIso, value, status = 'measured', reason = null, series = `${metric}-${scope}-v1` } = {}) {
  const payloads = {
    complex_functions: { algorithm: 'cyclomatic-complexity-v1', threshold: 10, eligible_functions: 34, above_threshold_functions: 4 },
    unused_candidates: { graph_status: 'unqualified', candidate_count: 6, validated_count: 0, false_positive_count: 0, uncertain_count: 6, owner_validation_refs: [], graph_qualification_ref: null },
    coverage: { measure: 'lines', covered: 781, eligible: 1000, emitted_source_files: 14, eligible_source_files: 18, includes_inline_tests: true, clean_profiles: true, source_inventory: 'exported-only' },
    ci_first_attempt: { runs: [{ overall_conclusion: 'success' }, { overall_conclusion: 'failure' }], expected_run_count: 2, window_start: '2026-09-10T00:00:00Z', window_end: '2026-10-08T00:00:00Z' },
    confirmed_regressions: { survey_complete: false, regressions: [], eligible_releases: 0 },
  };
  return {
    kind: 'snapshot', snapshot_id: `ref:demo-${id || metric}-${scope}`, commit, observed_at: at, collected_at: at,
    metric, status, current_status: status, reason, unit: metric === 'ci_first_attempt' ? 'runs' : metric === 'confirmed_regressions' ? 'regressions' : metric === 'unused_candidates' ? 'candidates' : metric === 'complex_functions' ? 'functions' : 'lines',
    language: metric === 'ci_first_attempt' ? 'github-actions' : scope.startsWith('rust') ? 'rust' : 'typescript',
    platform: scope === 'swift-coreml' ? 'macos' : 'linux-x64',
    feature_refs: [], tool: { name: 'synthetic-code-health', version: '1.0' },
    config_digest: 'b'.repeat(64), scope_digest: 'c'.repeat(64), metric_version: 'fixture-v1', scope_version: `${scope}-fixture-v1`,
    series_key: series, payload: status === 'measured' ? (value || payloads[metric]) : null, superseded: false,
  };
}

function history(repoName, days, asOf) {
  const repo = EXPECTED_SLOTS.get(repoName);
  const slots = repo.slots.map((slot, index) => {
    const scope = slot.scope || 'repository';
    let status = 'unsupported';
    let reason = 'unsupported-tool';
    if (slot.metric === 'complex_functions' || slot.metric === 'unused_candidates' || (repoName === 'gille-inference' && slot.metric === 'coverage')) {
      status = 'measured';
      reason = null;
    }
    if (slot.metric === 'confirmed_regressions') { status = 'unknown'; reason = 'incomplete-input'; }
    const latest = point(slot.metric, scope, { id: `latest-${index}`, status, reason });
    const points = [latest];
    if (slot.metric === 'unused_candidates' && status === 'measured') {
      const baseline = point(slot.metric, scope, { id: `baseline-${index}`, at: new Date(Date.parse(asOf) - 21 * 86400000).toISOString(), series: latest.series_key, value: { ...latest.payload, candidate_count: 9 } });
      points.unshift(baseline);
    }
    return { ...slot, latest, points };
  });
  return {
    repo_owner: repo.source.owner,
    repo_name: repoName,
    window_days: days,
    since: new Date(Date.parse(asOf) - days * 86400000).toISOString(),
    as_of: asOf,
    retention_months: 6,
    slots,
  };
}

function subjectiveFixture(repoName, asOf) {
  const workerObservation = {
    record_kind: 'observation', record_id: 'ref:demo-observation', repo_name: repoName,
    occurrence_id: 'ref:demo-occurrence', dimension: 'understand', polarity: 'negative', cause: 'code',
    module_refs: ['ref:demo-module'], summary: 'The relevant behavior required tracing two related modules.',
    reporter: { kind: 'worker' }, actual_worker: { observed_model: 'gpt-6-luna' },
  };
  const assessment = {
    record_kind: 'assessment', record_id: 'ref:demo-assessment', repo_name: repoName,
    applicability: 'applicable', completeness: 'complete', outcome: 'completed',
    ratings: [
      { dimension: 'locate', value: 'manageable' },
      { dimension: 'understand', value: 'difficult' },
      { dimension: 'verify', value: 'easy' },
    ], reporter: { kind: 'worker' }, actual_worker: { observed_model: 'gpt-6-luna' },
  };
  return {
    records: [{ record: workerObservation }, { record: assessment }],
    aggregate: {
      occurrences: [{ repo_name: repoName, occurrence_id: workerObservation.occurrence_id, conflict: false, records: [workerObservation] }],
      assessment_attempts: [{ repo_name: repoName, applicable: true, not_applicable: false, applicability_conflict: false, rating_conflict: false, records: [assessment] }],
    },
    collection: { status: 'fixture', last_attempt_at: asOf, last_success_at: asOf, last_error_code: null },
  };
}

const db = openDatabase(path.join(tempRoot, 'preview.sqlite'));
const { app } = buildApp(db, {
  runtimeRoot: path.resolve(__dirname, '..'),
  grimnirPath: path.join(tempRoot, 'no-nodes.json'),
  now: () => now.getTime(),
  codeHealth: {
    providers: {
      getObjectiveHistory: async (_db, { repoName, days, asOf }) => history(repoName, days, asOf.toISOString()),
      readObjectiveSourceState: () => ({ status: 'unconfigured', last_attempt_at: null, last_success_at: null, last_error_code: 'authenticated-transport-not-configured' }),
      readSubjectiveEvidence: async (_db, config, { now: at }) => subjectiveFixture(config?.repoName || 'sagascript', at.toISOString()),
      resolveEvidenceRefs: async () => ({ 'ref:demo-module': 'Task coordination' }),
    },
    subjectiveConfigForRepo: (repoName) => ({ enabled: false, repoName }),
  },
});

async function stop() {
  await app.close();
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const shutdown = () => { stop().finally(() => process.exit(0)); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 0) })
  .then((address) => console.log(`Synthetic code-health preview: ${address}/code-health?repo=sagascript&days=90&module=rust-core`))
  .catch((error) => { console.error('Preview failed to start:', error.message); stop().finally(() => process.exitCode = 1); });
