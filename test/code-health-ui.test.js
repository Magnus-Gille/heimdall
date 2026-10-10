'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// server.js reads its runtime env file at import time. Point this test process
// at an empty fixture home before importing it so no operator config is loaded.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-ui-'));
process.env.HOME = TEST_HOME;
process.env.HEIMDALL_CONFIG_PATH = path.join(TEST_HOME, 'no-config.json');
process.env.GRIMNIR_SERVICES_JSON = path.join(TEST_HOME, 'no-services.json');

const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const { getObjectiveHistory } = require('../src/code-health/store');
const { buildCodeHealthView, codeHealthPage, summarizeSubjective } = require('../src/render/code-health');
const { filterSubjectiveEvidence } = require('../src/code-health/munin-export');

const NOW = '2026-10-10T12:00:00Z';
const OWNER = 'Magnus-Gille';
const REPO = 'sagascript';
const COMMIT = 'a'.repeat(40);

function objectiveSlot(metric, scope, latest, points = [latest]) {
  return {
    slot_ref: `ref:slot-${scope}-${metric}`,
    metric,
    scope,
    language: 'rust',
    platform: 'linux-x64',
    freshness_ms: 10 * 86400000,
    latest,
    points,
  };
}

function measuredPoint(metric, {
  id = 'current', at = NOW, series = `${metric}:v1`, payload, superseded = false,
  currentStatus = 'measured', commit = COMMIT,
} = {}) {
  const defaults = {
    complex_functions: { threshold: 10, eligible_functions: 20, above_threshold_functions: 3 },
    unused_candidates: { graph_status: 'unqualified', candidate_count: 4, validated_count: 0, false_positive_count: 0, uncertain_count: 4 },
    coverage: { measure: 'lines', covered: 80, eligible: 100, emitted_source_files: 4, eligible_source_files: 5, source_inventory: 'complete-declared-inventory' },
    ci_first_attempt: { runs: [{ overall_conclusion: 'success' }], expected_run_count: 1, window_start: '2026-09-10T00:00:00Z', window_end: '2026-10-08T00:00:00Z' },
    confirmed_regressions: { survey_complete: true, regressions: [], eligible_releases: 2, cohort_policy: 'published-in-cohort' },
  };
  return {
    kind: 'snapshot',
    snapshot_id: `ref:${id}`,
    commit,
    observed_at: at,
    collected_at: at,
    metric,
    status: 'measured',
    current_status: currentStatus,
    unit: metric === 'ci_first_attempt' ? 'runs' : metric === 'confirmed_regressions' ? 'regressions' : metric === 'unused_candidates' ? 'candidates' : metric === 'complex_functions' ? 'functions' : 'lines',
    language: 'rust',
    platform: 'linux-x64',
    metric_version: 'metric-v1',
    scope_version: 'scope-v1',
    tool: { name: 'fixture-tool', version: '1.2.3' },
    config_digest: 'b'.repeat(64),
    scope_digest: 'c'.repeat(64),
    feature_refs: ['ref:feature-fixture'],
    series_key: series,
    payload: payload || defaults[metric],
    superseded,
  };
}

function emptySubjective(status = 'unconfigured') {
  return {
    records: [],
    aggregate: { occurrences: [], assessment_attempts: [] },
    collection: { status, last_attempt_at: null, last_success_at: null, last_error_code: status === 'unconfigured' ? 'authenticated-transport-not-configured' : null },
  };
}

function sampleSubjective() {
  const worker = {
    record_kind: 'observation', record_id: 'ref:worker-observation', repo_owner: OWNER, repo_name: REPO,
    task_id: 'task-1', attempt_id: 'attempt-1', occurrence_id: 'ref:occurrence-1', dimension: 'locate',
    polarity: 'positive', cause: 'code', module_refs: ['ref:module-private'], summary: '<img src=x onerror=alert(1)>',
    reporter: { kind: 'worker' }, actual_worker: { observed_model: 'gpt-6-luna' },
  };
  const parent = { ...worker, record_id: 'ref:parent-observation', reporter: { kind: 'parent' }, summary: 'parent context' };
  const assessment = {
    record_kind: 'assessment', record_id: 'ref:assessment-1', repo_owner: OWNER, repo_name: REPO,
    task_id: 'task-1', attempt_id: 'attempt-1', applicability: 'applicable', completeness: 'complete', outcome: 'completed',
    ratings: [
      { dimension: 'locate', value: 'easy' },
      { dimension: 'understand', value: 'manageable' },
      { dimension: 'verify', value: 'not-assessable' },
    ],
    reporter: { kind: 'worker' }, actual_worker: { observed_model: 'gpt-6-luna' },
  };
  const partialAssessment = {
    ...assessment,
    record_id: 'ref:assessment-2', task_id: 'task-2', attempt_id: 'attempt-2',
    completeness: 'partial', outcome: 'partial',
  };
  return {
    records: [{ record: worker }, { record: parent }, { record: assessment }, { record: partialAssessment }],
    aggregate: {
      occurrences: [{ repo_name: REPO, occurrence_id: worker.occurrence_id, conflict: false, records: [worker, parent] }],
      assessment_attempts: [
        {
          repo_name: REPO, applicable: true, not_applicable: false, applicability_conflict: false, rating_conflict: false,
          records: [assessment],
        },
        {
          repo_name: REPO, applicable: true, not_applicable: false, applicability_conflict: false, rating_conflict: false,
          records: [partialAssessment],
        },
      ],
    },
    collection: { status: 'committed', last_attempt_at: NOW, last_success_at: NOW, last_error_code: null },
  };
}

function historyFixture() {
  const old = measuredPoint('unused_candidates', { id: 'old', at: '2026-09-20T12:00:00Z', series: 'unused-v1', commit: 'b'.repeat(40) });
  const latestUnused = measuredPoint('unused_candidates', { id: 'new', series: 'unused-v1' });
  const mixedVersion = measuredPoint('unused_candidates', { id: 'different', at: '2026-10-01T12:00:00Z', series: 'unused-v2', commit: 'c'.repeat(40) });
  const stale = measuredPoint('complex_functions', { currentStatus: 'stale' });
  const gap = { kind: 'gap', status: 'unknown', current_status: 'unknown', reason: 'incomplete-input', observed_at: NOW, collected_at: NOW, payload: null };
  const unsupported = { kind: 'snapshot', status: 'unsupported', current_status: 'unsupported', reason: 'unsupported-tool', observed_at: NOW, collected_at: NOW, payload: null };
  const failed = { kind: 'snapshot', status: 'failed', current_status: 'failed', reason: 'producer-error', observed_at: NOW, collected_at: NOW, payload: null };
  const noSample = { status: 'unknown', current_status: 'unknown', reason: 'no-retained-sample', payload: null };
  return {
    repo_owner: OWNER, repo_name: REPO, window_days: 90, since: '2026-07-12T12:00:00.000Z', as_of: NOW, retention_months: 6,
    slots: [
      objectiveSlot('complex_functions', 'rust-core', stale),
      objectiveSlot('unused_candidates', 'rust-core', latestUnused, [old, mixedVersion, latestUnused]),
      objectiveSlot('coverage', 'rust-core', gap, [gap]),
      objectiveSlot('ci_first_attempt', 'rust-core', unsupported, [unsupported]),
      objectiveSlot('confirmed_regressions', 'rust-core', noSample, []),
      objectiveSlot('confirmed_regressions', 'rust-cli', failed, [failed]),
      objectiveSlot('unused_candidates', 'rust-cli', mixedVersion, [mixedVersion]),
    ],
  };
}

function seedObjectiveForProjection(db) {
  const positive = require('../src/code-health/contract/tests/fixtures/code-health/objective-positive.json');
  const objective = JSON.parse(JSON.stringify(positive));
  objective.snapshot_id = 'ref:projection-provenance';
  objective.repository = { owner: OWNER, name: 'gille-inference' };
  objective.commit = COMMIT;
  objective.observed_at = NOW;
  const { EXPECTED_SLOTS } = require('../src/code-health/registry');
  const expected = EXPECTED_SLOTS.get('gille-inference').slots;
  for (const [metricName, metric] of Object.entries(objective.metrics)) {
    const slot = expected.find((item) => item.metric === metricName);
    metric.slot_ref = slot.slot_ref;
    metric.observed_at = NOW;
    if (metricName !== 'complex_functions') {
      metric.status = 'unknown';
      metric.payload = null;
      metric.reason = 'not-collected';
      metric.source = null;
      metric.population = null;
      continue;
    }
    metric.source.tool = { name: 'projection-fixture', version: '9.8.7' };
    metric.source.config_digest.value = 'd'.repeat(64);
    metric.source.scope_digest.value = 'e'.repeat(64);
  }
  db.prepare(`INSERT INTO code_health_objective_snapshots (
    snapshot_id, repo_owner, repo_name, commit_sha, observed_at, collected_at, expires_at,
    source_run_id, source_attempt, artifact_sha256, payload_sha256, payload_json, supersedes_ref, correction_ref
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    objective.snapshot_id, OWNER, 'gille-inference', COMMIT, NOW, NOW, '2027-04-10T12:00:00.000Z',
    9001, 1, 'f'.repeat(64), 'a'.repeat(64), JSON.stringify(objective), null, null,
  );
  return objective;
}

describe('code-health renderer', () => {
  it('keeps the five objective groups separate and represents unknown as a dash with reason', () => {
    const view = buildCodeHealthView({ repoName: REPO, days: 90, objectiveHistory: historyFixture(), objectiveSource: { status: 'disabled' }, subjective: emptySubjective(), now: new Date(NOW) });
    const html = codeHealthPage('v', view);
    assert.equal(view.objective.length, 5);
    assert.match(html, /Complex functions/);
    assert.match(html, /Unused candidates/);
    assert.match(html, /Test coverage/);
    assert.match(html, /CI first attempt/);
    assert.match(html, /Confirmed regressions/);
    assert.match(html, /No sample is retained for this window/);
    assert.match(html, /Failed/);
    assert.match(html, /One-point history has no trend/);
    assert.match(html, /Compatible baseline/);
    assert.match(html, /No sprint marker supplied/);
    assert.doesNotMatch(html, /composite score|leaderboard|ranked/i);
    assert.equal(view.objective[1].slots.find((slot) => slot.module === 'rust-core').baseline.revision, 'bbbbbbbb', 'baseline uses the compatible v1 series and ignores mixed v2');
    assert.equal(view.objective[1].slots.find((slot) => slot.module === 'rust-cli').baseline, null, 'a single point in a distinct series has no invented baseline');
  });

  it('renders an empty stored history as missing instead of zero', () => {
    const view = buildCodeHealthView({ repoName: REPO, days: 365, objectiveHistory: { slots: [], as_of: NOW, since: '2026-04-13T12:00:00Z', retention_months: 6 }, subjective: emptySubjective(), now: new Date(NOW) });
    const html = codeHealthPage('v', view);
    assert.equal(view.period.olderEvidenceMayBeAbsent, true);
    assert.equal(view.period.requestedDays, 365);
    assert.equal(view.period.effectiveDays, undefined);
    assert.match(html, /365-day requested window/);
    assert.match(html, /Records are retained for 6 calendar months from collection/);
    assert.doesNotMatch(html, /180-day|effective window/);
    assert.match(html, /No registered metric slots match this module filter/);
    assert.doesNotMatch(html, /0 above threshold|0 candidates|0 confirmed/);
  });

  it('keeps subjective counts deduplicated and redacts summaries without public retention', () => {
    const source = sampleSubjective();
    const summary = summarizeSubjective(source, REPO, { 'ref:module-private': 'Core data layer' });
    assert.equal(summary.workerSamples, 3, 'parent context is not a worker sample');
    assert.equal(summary.observationOccurrences, 1, 'one occurrence remains one count');
    assert.equal(summary.helpfulFriction.locate.helpful, 1);
    assert.equal(summary.eligibleAssessments, 2);
    assert.equal(summary.completeness.complete, 1);
    assert.equal(summary.completeness.partial, 1);
    assert.equal(summary.participation, null);
    assert.equal(summary.recurrentModules[0].label, 'Core data layer');
    const html = codeHealthPage('v', buildCodeHealthView({ repoName: REPO, objectiveHistory: historyFixture(), subjective: source, resolvedEvidenceRefs: { 'ref:module-private': 'Core data layer' }, now: new Date(NOW) }));
    assert.equal(summary.evidence[0].summary, null);
    assert.doesNotMatch(html, /onerror=alert|<img src=x|&lt;img src=x/);
    const publicSource = sampleSubjective();
    for (const item of publicSource.records) item.retention = { classification: 'public' };
    const publicHtml = codeHealthPage('v', buildCodeHealthView({ repoName: REPO, objectiveHistory: historyFixture(), subjective: publicSource, resolvedEvidenceRefs: { 'ref:module-private': 'Core data layer' }, now: new Date(NOW) }));
    assert.match(publicHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /participation rate is unavailable/);
  });

  it('filters subjective aggregates before rendering', async () => {
    const contract = await require('../src/code-health/contract').loadContract();
    const fixture = require('../src/code-health/contract/tests/fixtures/code-health/agent-positive.json');
    const records = JSON.parse(JSON.stringify(fixture.records));
    for (const record of records) {
      record.module_refs = ['ref:module-other'];
      record.actual_worker = { ...(record.actual_worker || {}), observed_model: 'worker-core' };
    }
    records.find((record) => record.record_id === 'ref:assess-main-corrected').module_refs = ['ref:module-core'];
    const oldRecord = records.find((record) => record.record_id === 'ref:assess-partial');
    oldRecord.observed_at = '2026-01-01T10:00:00Z';
    oldRecord.actual_worker.observed_model = 'worker-other';
    const source = {
      records: records.map((record) => ({ record, retention: { classification: 'public' } })),
      contextRecords: [],
      aggregate: contract.aggregateRecords(records),
      collection: { status: 'committed' },
    };
    const filtered = await filterSubjectiveEvidence(source, {
      repoName: 'sample-project',
      days: 30,
      asOf: NOW,
      moduleRefs: ['ref:module-core'],
      cohort: 'worker-core',
    });
    assert.deepEqual(filtered.records.map(({ record }) => record.record_id), ['ref:assess-main-corrected']);
    assert.deepEqual(filtered.contextRecords.map(({ record }) => record.record_id).sort(), ['ref:assess-main', 'ref:rec-close', 'ref:rec-worker']);
    assert.equal(filtered.aggregate.assessment_attempts.length, 1);
    assert.equal(filtered.aggregate.occurrences.length, 0);
    assert.ok(source.aggregate.occurrences.length > 0);
    assert.ok(source.aggregate.assessment_attempts.length > filtered.aggregate.assessment_attempts.length);
  });

  it('renders registered source provenance without outputting opaque reference IDs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-projection-'));
    const db = openDatabase(path.join(dir, 'test.db'));
    try {
      const objective = seedObjectiveForProjection(db);
      const contract = await require('../src/code-health/contract').loadContract();
      const validation = contract.validateObjective(contract.objectiveSchema, objective);
      assert.equal(validation.valid, true, JSON.stringify(validation));
      const history = await getObjectiveHistory(db, { repoOwner: OWNER, repoName: 'gille-inference', days: 30, asOf: new Date(NOW) });
      const point = history.slots[0].latest;
      assert.deepEqual(point.tool, { name: 'projection-fixture', version: '9.8.7' });
      assert.equal(point.config_digest, 'd'.repeat(64));
      assert.equal(point.scope_digest, 'e'.repeat(64));
      const view = buildCodeHealthView({ repoName: 'gille-inference', objectiveHistory: history, subjective: emptySubjective(), now: new Date(NOW) });
      const serialized = JSON.stringify(view);
      assert.match(serialized, /projection-fixture 9\.8\.7/);
      assert.match(serialized, /sha256:d{12}/);
      assert.doesNotMatch(serialized, /ref:projection-provenance|ref:slot-/);
    } finally {
      db.close();
    }
  });
});

describe('code-health read routes', () => {
  let app;
  let db;
  let readCalls;

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-routes-'));
    db = openDatabase(path.join(dir, 'test.db'));
    readCalls = [];
    const providers = {
      getObjectiveHistory: async (_db, params) => {
        readCalls.push(['history', params.repoName, params.days]);
        return { ...historyFixture(), repo_name: params.repoName, window_days: params.days };
      },
      readObjectiveSourceState: (_db, params) => {
        readCalls.push(['objective-state', params.repoName]);
        return { status: 'unconfigured', last_attempt_at: null, last_success_at: null, last_error_code: 'authenticated-transport-not-configured' };
      },
      readSubjectiveEvidence: async (_db, _config, { now }) => {
        readCalls.push(['subjective', now.toISOString()]);
        return sampleSubjective();
      },
      resolveEvidenceRefs: async (_db, refs) => {
        readCalls.push(['resolve', refs.length]);
        return { 'ref:module-private': 'Core data layer' };
      },
    };
    ({ app } = buildApp(db, {
      runtimeRoot: path.resolve(__dirname, '..'),
      grimnirPath: path.join(TEST_HOME, 'no-nodes.json'),
      now: () => Date.parse(NOW),
      codeHealth: { providers },
    }));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('serves the page and bounded API with validated filters and no source collection', async () => {
    const page = await app.inject({ method: 'GET', url: '/code-health?repo=sagascript&days=30&module=rust-core' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Code health/);
    assert.match(page.body, /href="\/code-health"[^>]*aria-current="page"/);
    assert.match(page.body, /Stored evidence view; writes are disabled/);
    assert.doesNotMatch(page.body, /No live Hugin capture is connected|Fixture-only UI acceptance|Synthetic fixture data/);
    assert.doesNotMatch(page.body, /<script>\s*document\.querySelector\('\.ch-filters'\)/);
    assert.match(page.body, /<script src="\/app\.js\?v=/);
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const listeners = {};
    vm.runInNewContext(appJs, {
      document: {
        documentElement: { setAttribute() {}, getAttribute() { return null; } },
        addEventListener(name, handler) { listeners[name] = handler; },
      },
      localStorage: { getItem() { return null; }, setItem() {} },
      window: {},
    });
    const moduleSelect = { value: 'rust-core' };
    const cohortSelect = { value: 'gpt-6-luna' };
    const form = { querySelector(selector) { return selector.includes('[name="module"]') ? moduleSelect : cohortSelect; } };
    const repoSelect = {
      form,
      matches(selector) { return selector === '.ch-filters select[name="repo"]'; },
    };
    listeners.change({ target: repoSelect });
    assert.equal(moduleSelect.value, 'all');
    assert.equal(cohortSelect.value, 'all');
    assert.match(page.body, /Core data layer/);
    assert.doesNotMatch(page.body, /onerror=alert|<img src=x|&lt;img src=x/);

    const resetRoute = await app.inject({ method: 'GET', url: '/code-health?repo=gille-inference&days=30&module=all&cohort=all' });
    assert.equal(resetRoute.statusCode, 200);

    const api = await app.inject({ method: 'GET', url: '/api/code-health?repo=sagascript&days=30&module=rust-core' });
    assert.equal(api.statusCode, 200);
    assert.match(api.headers['cache-control'], /no-store/);
    const body = api.json();
    assert.equal(body.period.requestedDays, 30);
    assert.equal(body.filters.module, 'rust-core');
    assert.equal(body.objective.length, 5);
    assert.equal(body.objective[0].slots.length, 1);
    assert.equal(body.subjective.participation, null);
    assert.equal(body.acceptance.writesEnabled, false);
    assert.doesNotMatch(api.body, /ref:module-private|ref:worker-observation|file:|\/Users\//);
    assert.ok(readCalls.every(([kind]) => ['history', 'objective-state', 'subjective', 'resolve'].includes(kind)));

    const css = await app.inject({ method: 'GET', url: '/css/code-health.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /css/);
  });

  it('shows the fixture notice only for injected synthetic subjective evidence', () => {
    const base = { repoName: REPO, objectiveHistory: { ...historyFixture(), slots: [] }, now: new Date(NOW) };
    const stored = codeHealthPage('v', buildCodeHealthView({ ...base, subjective: emptySubjective('committed') }));
    assert.doesNotMatch(stored, /Synthetic fixture data|Fixture-only UI acceptance|No live Hugin capture is connected/);

    const fixture = codeHealthPage('v', buildCodeHealthView({ ...base, subjective: emptySubjective('fixture') }));
    assert.match(fixture, /Synthetic fixture data is shown for visual acceptance/);
  });

  it('rejects unknown repository, period, and module query values', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/code-health?repo=other' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/code-health?days=31' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/code-health?module=not-registered' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/code-health?cohort=not-observed' })).statusCode, 400);
  });
});
