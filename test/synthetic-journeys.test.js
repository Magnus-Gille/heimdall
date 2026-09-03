'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {
  openDatabase, insertSyntheticJourney, getSyntheticJourneyHistory,
  getLatestSyntheticJourneys, getActiveAlerts,
} = require('../src/db');
const {
  validateJourneyOutcome, projectJourneyOutcome, computeJourneyObjectives,
  runMuninReadJourney, runMimirMetadataJourney, evaluateJourneyAlerts,
  ingestSyntheticJourney,
} = require('../src/synthetic-journeys');
const { reliabilityPage } = require('../src/render/reliability');
const { buildApp } = require('../src/server');

const NOW = Date.parse('2026-09-03T08:00:00Z');

const STEPS = {
  'heimdall-munin-read': ['connect', 'authenticate', 'read'],
  'heimdall-mimir-metadata': ['connect', 'authenticate', 'metadata-read'],
  'hugin-gateway-preflight': ['preflight', 'gateway-admission'],
  'gateway-model-readiness': ['gateway-readiness', 'model-readiness'],
};

function outcome(journeyId = 'heimdall-munin-read', overrides = {}) {
  const steps = STEPS[journeyId].map((id) => ({ id, outcome: 'pass', latency_ms: 10, error_class: null }));
  return {
    kind: 'synthetic-journey-outcome', schema_version: 'v1', journey_id: journeyId,
    producer: journeyId.startsWith('heimdall-') ? 'heimdall' : (journeyId.startsWith('hugin-') ? 'hugin' : 'gille-inference'),
    attempt_id: `attempt-${journeyId}-001`, version: 'producer@abc1234',
    started_at: '2026-09-03T07:59:59Z', observed_at: '2026-09-03T08:00:00Z',
    max_age_seconds: 900, outcome: 'pass', runner_outcome: 'ok', latency_ms: 30,
    error_class: null, trace_id: '0123456789abcdef0123456789abcdef', steps, extensions: [],
    ...overrides,
  };
}

function tmpDb() {
  return openDatabase(path.join(os.tmpdir(), `heimdall-journeys-${process.pid}-${Date.now()}-${Math.random()}.db`));
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

describe('synthetic journey v1 contract', () => {
  it('accepts a complete content-free attempt and rejects unknown/private fields', () => {
    assert.equal(validateJourneyOutcome(outcome()).ok, true);
    const checked = validateJourneyOutcome({ ...outcome(), prompt: 'private payload' });
    assert.equal(checked.ok, false);
    assert.doesNotMatch(JSON.stringify(checked.errors), /private payload/);
  });

  it('requires every declared step from the same attempt before pass', () => {
    const partial = outcome('hugin-gateway-preflight', {
      outcome: 'partial', steps: [{ id: 'preflight', outcome: 'pass', latency_ms: 10, error_class: null }],
    });
    assert.equal(validateJourneyOutcome(partial).ok, true);
    assert.equal(projectJourneyOutcome(partial, { now: NOW }).state, 'partial');
    assert.equal(validateJourneyOutcome({ ...partial, outcome: 'pass' }).ok, false);
  });

  it('separates runner failure from dependency step failure', () => {
    const dependency = outcome('heimdall-munin-read', {
      outcome: 'fail', error_class: 'auth-denied',
      steps: [
        { id: 'connect', outcome: 'pass', latency_ms: 2, error_class: null },
        { id: 'authenticate', outcome: 'fail', latency_ms: 3, error_class: 'auth-denied' },
        { id: 'read', outcome: 'skipped', latency_ms: null, error_class: 'blocked-by-auth' },
      ],
    });
    assert.equal(validateJourneyOutcome(dependency).ok, true);
    assert.equal(projectJourneyOutcome(dependency, { now: NOW }).failureDomain, 'dependency');
    const runner = outcome(undefined, {
      outcome: 'unknown', runner_outcome: 'failed', error_class: 'runner-clock',
      steps: STEPS['heimdall-munin-read'].map((id) => ({ id, outcome: 'skipped', latency_ms: null, error_class: 'runner-unavailable' })),
    });
    assert.equal(validateJourneyOutcome(runner).ok, true);
    assert.equal(projectJourneyOutcome(runner, { now: NOW }).failureDomain, 'runner');
  });

  it('recomputes stale/future outcomes locally and never renders them compliant', () => {
    const stale = projectJourneyOutcome(outcome(undefined, { started_at: '2026-09-03T07:29:59Z', observed_at: '2026-09-03T07:30:00Z' }), { now: NOW });
    assert.equal(stale.state, 'stale');
    const future = projectJourneyOutcome(outcome(undefined, { observed_at: '2026-09-03T08:00:06Z' }), { now: NOW });
    assert.equal(future.state, 'stale');
  });
});

describe('direct content-free journeys', () => {
  it('runs an authenticated Munin missing-sentinel read without retaining content', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, opts });
      return response(200, 'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"found\\":false}"}]}}\n');
    };
    const result = await runMuninReadJourney({ apiKey: 'secret-token', fetchFn, now: () => NOW });
    assert.equal(result.outcome, 'pass');
    assert.equal(result.steps.every((step) => step.outcome === 'pass'), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].opts.body, /memory_read/);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|content/);
  });

  it('classifies Munin auth denial as dependency failure and skips read', async () => {
    const result = await runMuninReadJourney({
      apiKey: 'wrong', fetchFn: async () => response(401, '{"error":"denied"}'), now: () => NOW,
    });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.runner_outcome, 'ok');
    assert.equal(result.error_class, 'auth-denied');
    assert.equal(result.steps.find((step) => step.id === 'read').outcome, 'skipped');
  });

  it('uses a fixed missing Mimir path so no filenames or file content are read', async () => {
    const calls = [];
    const result = await runMimirMetadataJourney({
      baseUrl: 'http://nas:3031/health', apiKey: 'mimir-token', now: () => NOW,
      fetchFn: async (url, opts) => { calls.push({ url, opts }); return response(404, '{"error":"Directory not found: /__heimdall_content_free_probe__"}'); },
    });
    assert.equal(result.outcome, 'pass');
    assert.equal(calls[0].url, 'http://nas:3031/list/__heimdall_content_free_probe__');
    assert.equal(calls[0].opts.method, 'GET');
    assert.doesNotMatch(JSON.stringify(result), /mimir-token|Directory not found/);
  });

  it('classifies a timeout without copying exception or response content', async () => {
    const result = await runMimirMetadataJourney({
      baseUrl: 'http://nas:3031/health', apiKey: 'secret', now: () => NOW,
      fetchFn: async () => { const error = new Error('private host detail'); error.name = 'AbortError'; throw error; },
    });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.error_class, 'timeout');
    assert.doesNotMatch(JSON.stringify(result), /private host detail|secret/);
  });
});

describe('journey history, objectives, alerts, and rendering', () => {
  it('stores bounded outcomes and reads latest/history in deterministic order', () => {
    const db = tmpDb();
    const first = outcome(undefined, { attempt_id: 'attempt-001', observed_at: '2026-09-03T07:57:00Z' });
    insertSyntheticJourney(db, first);
    assert.equal(insertSyntheticJourney(db, first).replay, true);
    assert.equal(insertSyntheticJourney(db, { ...first, latency_ms: 99 }).code, 'attempt_conflict');
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'attempt-002', observed_at: '2026-09-03T07:58:00Z' }));
    assert.deepEqual(getSyntheticJourneyHistory(db, 'heimdall-munin-read', 10).map((row) => row.attempt_id), ['attempt-002', 'attempt-001']);
    assert.equal(getLatestSyntheticJourneys(db)[0].attempt_id, 'attempt-002');
    for (let i = 0; i < 580; i++) {
      insertSyntheticJourney(db, outcome(undefined, { attempt_id: `bounded-${String(i).padStart(4, '0')}` }));
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM synthetic_journeys WHERE journey_id = 'heimdall-munin-read'").get().n, 582);
    db.close();
  });

  it('computes deterministic success rate/p95 and keeps low samples unknown', () => {
    const rows = [10, 20].map((latency, i) => outcome(undefined, { attempt_id: `attempt-low-${i}`, latency_ms: latency }));
    assert.equal(computeJourneyObjectives(rows, { minSamples: 3, now: NOW }).state, 'unknown');
    rows.push(outcome(undefined, { attempt_id: 'attempt-3', latency_ms: 30 }));
    const good = computeJourneyObjectives(rows, { minSamples: 3, successTarget: 1, latencyTargetMs: 30, now: NOW });
    assert.equal(good.state, 'pass');
    assert.equal(good.successRate, 1);
    assert.equal(good.p95LatencyMs, 30);
    const failed = { ...outcome(), attempt_id: 'attempt-4', outcome: 'fail', error_class: 'dependency-down', steps: outcome().steps.map((step, i) => i === 2 ? { ...step, outcome: 'fail', error_class: 'dependency-down' } : step) };
    assert.equal(computeJourneyObjectives([...rows, failed], { minSamples: 3, successTarget: 1, latencyTargetMs: 30, now: NOW }).state, 'fail');
    const runnerFailures = Array.from({ length: 20 }, (_, i) => outcome(undefined, {
      attempt_id: `runner-${i}`, outcome: 'unknown', runner_outcome: 'failed', error_class: 'runner-config',
      steps: STEPS['heimdall-munin-read'].map((id) => ({ id, outcome: 'skipped', latency_ms: null, error_class: 'runner-unavailable' })),
    }));
    const runnerObjective = computeJourneyObjectives(runnerFailures, { minSamples: 3, now: NOW });
    assert.equal(runnerObjective.state, 'unknown');
    assert.equal(runnerObjective.sampleCount, 0);
    assert.equal(runnerObjective.observationCount, 20);
  });

  it('alerts on a complete failure/objective breach and resolves after recovery', () => {
    const db = tmpDb();
    const failed = outcome(undefined, { outcome: 'fail', error_class: 'dependency-down', steps: outcome().steps.map((step, i) => i === 2 ? { ...step, outcome: 'fail', error_class: 'dependency-down' } : step) });
    insertSyntheticJourney(db, failed);
    evaluateJourneyAlerts(db, 'heimdall-munin-read', { minSamples: 3, now: NOW });
    assert.equal(getActiveAlerts(db).some((alert) => alert.dedup_key === 'journey:heimdall-munin-read:complete-failure'), true);
    evaluateJourneyAlerts(db, 'heimdall-munin-read', { minSamples: 3, now: NOW + 20 * 60_000 });
    assert.equal(getActiveAlerts(db).some((alert) => alert.dedup_key === 'journey:heimdall-munin-read:complete-failure'), true);
    for (let i = 1; i <= 3; i++) insertSyntheticJourney(db, outcome(undefined, { attempt_id: `recovery-${i}`, observed_at: `2026-09-03T08:0${i}:00Z` }));
    evaluateJourneyAlerts(db, 'heimdall-munin-read', { minSamples: 3, now: NOW + 4 * 60_000 });
    assert.equal(getActiveAlerts(db).some((alert) => alert.dedup_key === 'journey:heimdall-munin-read:complete-failure'), false);
    db.close();
  });

  it('deduplicates a windowed objective breach and resolves it after the bad window expires', () => {
    const db = tmpDb();
    const failedSteps = outcome().steps.map((step, i) => i === 2
      ? { ...step, outcome: 'fail', error_class: 'dependency-down' } : step);
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'old-a' }));
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'old-b' }));
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'old-c', outcome: 'fail', error_class: 'dependency-down', steps: failedSteps }));
    evaluateJourneyAlerts(db, 'heimdall-munin-read', { minSamples: 3, successTarget: 1, now: NOW });
    evaluateJourneyAlerts(db, 'heimdall-munin-read', { minSamples: 3, successTarget: 1, now: NOW });
    assert.equal(getActiveAlerts(db).filter((alert) => alert.dedup_key === 'journey:heimdall-munin-read:objective').length, 1);

    for (let i = 0; i < 3; i++) {
      const minute = 10 + i;
      insertSyntheticJourney(db, outcome(undefined, {
        attempt_id: `fresh-${i}`,
        started_at: `2026-09-03T08:${String(minute - 1).padStart(2, '0')}:59Z`,
        observed_at: `2026-09-03T08:${String(minute).padStart(2, '0')}:00Z`,
      }));
    }
    evaluateJourneyAlerts(db, 'heimdall-munin-read', {
      minSamples: 3, successTarget: 1, windowMs: 5 * 60_000, now: NOW + 14 * 60_000,
    });
    assert.equal(getActiveAlerts(db).some((alert) => alert.dedup_key === 'journey:heimdall-munin-read:objective'), false);
    db.close();
  });

  it('ingests only an authenticated producer-owned journey identity', () => {
    const db = tmpDb();
    assert.equal(ingestSyntheticJourney(db, { body: outcome('hugin-gateway-preflight') }).status, 401);
    const tokens = { hugin: 'right', 'gille-inference': 'gateway-only' };
    assert.equal(ingestSyntheticJourney(db, { body: outcome('hugin-gateway-preflight'), tokens, authHeader: 'Bearer right' }).status, 200);
    assert.equal(ingestSyntheticJourney(db, { body: outcome('gateway-model-readiness'), tokens, authHeader: 'Bearer right' }).status, 401);
    assert.equal(ingestSyntheticJourney(db, { body: { ...outcome('hugin-gateway-preflight'), producer: 'heimdall' }, tokens, authHeader: 'Bearer right' }).status, 403);
    db.close();
  });

  it('exposes authenticated producer ingest and the read-only reliability page', async () => {
    const db = tmpDb();
    const previous = process.env.HEIMDALL_HUGIN_JOURNEY_TOKEN;
    process.env.HEIMDALL_HUGIN_JOURNEY_TOKEN = 'journey-token';
    const { app } = buildApp(db, { now: () => NOW });
    await app.ready();
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/synthetic-journeys', payload: outcome('hugin-gateway-preflight') });
      assert.equal(denied.statusCode, 401);
      const accepted = await app.inject({
        method: 'POST', url: '/api/synthetic-journeys',
        headers: { authorization: 'Bearer journey-token' }, payload: outcome('hugin-gateway-preflight'),
      });
      assert.equal(accepted.statusCode, 200);
      const page = await app.inject({ method: 'GET', url: '/reliability' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Hugin → gateway preflight/);
      assert.match(page.body, /Gateway → model readiness/);
      assert.match(page.body, /href="\/reliability" class="active"/);
    } finally {
      await app.close(); db.close();
      if (previous === undefined) delete process.env.HEIMDALL_HUGIN_JOURNEY_TOKEN;
      else process.env.HEIMDALL_HUGIN_JOURNEY_TOKEN = previous;
    }
  });

  it('renders missing producer journeys and objectives as unknown, never healthy', () => {
    const html = reliabilityPage('abc1234', [], { now: NOW });
    assert.match(html, /Hugin → gateway/);
    assert.match(html, /Gateway → model/);
    assert.match(html, /Unknown/);
    assert.doesNotMatch(html, /All journeys healthy/);
    const hinted = reliabilityPage('abc1234', [], {
      now: NOW, producerHints: { 'hugin-gateway-preflight': { freshness: 'fresh' } },
    });
    assert.match(hinted, /Legacy producer status received/);
    assert.match(hinted, /Partial/);
  });
});

module.exports = { outcome, NOW };
