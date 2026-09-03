'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {
  openDatabase, insertSyntheticJourney, pruneSyntheticJourneys,
  insertServiceVersion, createAlert,
} = require('../src/db');
const { buildIncidentTimeline, loadIncidentTimeline } = require('../src/incident-timeline');
const { incidentTimelinePage } = require('../src/render/incident-timeline');
const { buildApp } = require('../src/server');

const NOW = Date.parse('2026-09-03T10:30:00Z');
const STEPS = {
  'heimdall-munin-read': ['connect', 'authenticate', 'read'],
  'hugin-gateway-preflight': ['preflight', 'gateway-admission'],
  'gateway-model-readiness': ['gateway-readiness', 'model-readiness'],
};

function outcome(journeyId = 'heimdall-munin-read', overrides = {}) {
  const steps = STEPS[journeyId].map((id) => ({ id, outcome: 'pass', latency_ms: 10, error_class: null }));
  return {
    kind: 'synthetic-journey-outcome', schema_version: 'v1', journey_id: journeyId,
    producer: journeyId.startsWith('heimdall-') ? 'heimdall' : (journeyId.startsWith('hugin-') ? 'hugin' : 'gille-inference'),
    attempt_id: `attempt-${journeyId}-001`, version: 'producer@abc1234',
    started_at: '2026-09-03T09:59:59Z', observed_at: '2026-09-03T10:00:00Z',
    max_age_seconds: 3600, outcome: 'pass', runner_outcome: 'ok', latency_ms: 30,
    error_class: null, trace_id: '0123456789abcdef0123456789abcdef', steps, extensions: [],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    unit_result: { active_state: 'active', sub_state: 'running', result: 'success' },
    restart: { count: 0, window_start: '2026-09-03T10:00:00Z', window_end: '2026-09-03T10:05:00Z' },
    watchdog: { result: 'ok' }, oom: { result: 'none' }, timer: null, ...overrides,
  };
}

function unit(name, overrides = {}) {
  return {
    target_node_id: 'node-core', unit: name, owner: 'heimdall', scope: 'system',
    workload_shape: 'long-running', timer_class: null, status: 'pass', findings: [],
    evidence: evidence(), ...overrides,
  };
}

function audit(overrides = {}) {
  const units = overrides.units || [unit('heimdall.service')];
  return {
    kind: 'systemd-supervision-audit', schema_version: 'v1',
    baseline_id: 'fleet-systemd-supervision', baseline_digest: `sha256:${'a'.repeat(64)}`,
    topology_authority: 'grimnir-service-registry', observed_at: '2026-09-03T10:05:00Z',
    evaluated_at: '2026-09-03T10:05:01Z', evaluated_at_source: 'fixture-override',
    freshness: { status: 'fresh', age_seconds: 1, max_age_seconds: 900 },
    notifiers: [{ target_node_id: 'node-core', status: 'available' }],
    summary: { status: 'fail', unit_count: units.length, compliant_unit_count: 0, finding_count: 1 },
    findings: [], extensions: [], ...overrides, units,
  };
}

function tmpDb() {
  return openDatabase(path.join(os.tmpdir(), `heimdall-timeline-${process.pid}-${Date.now()}-${Math.random()}.db`));
}

function sources(overrides = {}) {
  return { alerts: [], events: [], deployments: [], metrics: [], journeys: [], supervision: null, ...overrides };
}

describe('incident timeline correlations', () => {
  it('labels deploy-before-failure as bounded inference, never causation or audit truth', () => {
    const timeline = buildIncidentTimeline(sources({
      deployments: [
        { id: 1, checked_at: '2026-09-03T09:55:00Z', service: 'heimdall', host: 'control-node', deployed_commit: 'a'.repeat(40) },
        { id: 2, checked_at: '2026-09-03T10:00:00Z', service: 'heimdall', host: 'control-node', deployed_commit: 'b'.repeat(40) },
      ],
      alerts: [{ id: 7, created_at: '2026-09-03T10:05:00Z', last_observed_at: '2026-09-03T10:06:00Z', resolved_at: null, host: 'control-node', category: 'service', severity: 'critical', title: 'heimdall.service failed', source: 'collector' }],
    }), { now: NOW, maxSkewMs: 10 * 60_000 });
    const inferred = timeline.correlations.find((row) => row.mode === 'inferred');
    assert.ok(inferred);
    assert.equal(inferred.clockSource, 'observed_at');
    assert.equal(inferred.maxSkewMs, 10 * 60_000);
    assert.equal(inferred.authoritative, false);
    assert.equal(inferred.causal, false);
    assert.match(inferred.uncertainty, /coincidental/i);
  });

  it('prefers an exact producer trace ID over a time-window inference', () => {
    const trace = 'a'.repeat(32);
    const hugin = outcome('hugin-gateway-preflight', { trace_id: trace, observed_at: '2026-09-03T10:00:00Z', started_at: '2026-09-03T09:59:59Z' });
    const gateway = outcome('gateway-model-readiness', { trace_id: trace, observed_at: '2026-09-03T10:00:01Z', started_at: '2026-09-03T10:00:00Z' });
    const timeline = buildIncidentTimeline(sources({ journeys: [
      { outcome: hugin, collected_at: '2026-09-03T10:00:02Z' },
      { outcome: gateway, collected_at: '2026-09-03T10:00:03Z' },
    ] }), { now: NOW });
    assert.equal(timeline.correlations.length, 1);
    assert.equal(timeline.correlations[0].mode, 'producer-authored');
    assert.equal(timeline.correlations[0].diagnosticRef, `trace:${trace}`);
    assert.equal(timeline.correlations[0].authoritative, true);
    assert.equal(timeline.correlations[0].causal, false);
  });

  it('projects restart storm, watchdog, and OOM facts without raw audit payloads', () => {
    const units = [
      unit('storm.service', { status: 'fail', findings: [{ code: 'restart_storm', severity: 'error', route: 'component-owner' }], evidence: evidence({ restart: { count: 7, window_start: '2026-09-03T10:00:00Z', window_end: '2026-09-03T10:05:00Z' } }) }),
      unit('watchdog.service', { status: 'fail', evidence: evidence({ watchdog: { result: 'timeout' } }) }),
      unit('oom.service', { status: 'fail', evidence: evidence({ oom: { result: 'killed' } }) }),
    ];
    const body = audit({ observed_at: '2026-09-03T10:05:00Z', evaluated_at: '2026-09-03T10:05:01Z', units });
    const timeline = buildIncidentTimeline(sources({ supervision: { state: 'valid', audit: body, received_at: '2026-09-03T10:05:02Z' } }), { now: NOW });
    assert.equal(timeline.items.some((item) => item.kind === 'restart-storm' && item.unit === 'storm.service'), true);
    assert.equal(timeline.items.some((item) => item.kind === 'watchdog-timeout'), true);
    assert.equal(timeline.items.some((item) => item.kind === 'oom-kill'), true);
    assert.doesNotMatch(JSON.stringify(timeline), /baseline_digest|window_start|findingCodes/);
  });

  it('marks a stopped collector observation stale using the single observed_at clock', () => {
    const timeline = buildIncidentTimeline(sources({ metrics: [
      { id: 1, timestamp: '2026-09-03T09:00:00Z', host: 'control-node', metric: 'collector_success', value: 0 },
    ] }), { now: NOW });
    const collector = timeline.items.find((item) => item.kind === 'collector-failure');
    assert.equal(collector.freshness, 'stale');
    assert.equal(collector.observedAt, '2026-09-03T09:00:00Z');
  });

  it('records an explicit collector recovery transition after a failed cycle', () => {
    const timeline = buildIncidentTimeline(sources({ metrics: [
      { id: 1, timestamp: '2026-09-03T10:00:00Z', host: 'control-node', metric: 'collector_success', value: 0 },
      { id: 2, timestamp: '2026-09-03T10:05:00Z', host: 'control-node', metric: 'collector_success', value: 1 },
    ] }), { now: NOW });
    const recovery = timeline.items.find((item) => item.kind === 'collector-recovery');
    assert.ok(recovery);
    assert.equal(recovery.resolutionReason, 'observed-recovery');
    assert.equal(recovery.outcome, 'pass');
  });

  it('keeps trace-unavailable explicit and never invents a diagnostic link', () => {
    const direct = outcome(undefined, { trace_id: null, observed_at: '2026-09-03T10:00:00Z', started_at: '2026-09-03T09:59:59Z' });
    const timeline = buildIncidentTimeline(sources({ journeys: [{ outcome: direct, collected_at: '2026-09-03T10:00:01Z' }] }), { now: NOW });
    assert.equal(timeline.items[0].diagnosticRef, null);
    assert.equal(timeline.items[0].localHref, '/reliability');
    assert.equal(timeline.correlations.length, 0);
  });

  it('does not correlate unrelated coincident units on the same host', () => {
    const timeline = buildIncidentTimeline(sources({
      events: [{ id: 1, timestamp: '2026-09-03T10:00:00Z', host: 'control-node', category: 'system', severity: 'error', title: 'Service event: alpha.service', source: 'journald', detail: 'private detail' }],
      alerts: [{ id: 2, created_at: '2026-09-03T10:00:01Z', host: 'control-node', category: 'service', severity: 'critical', title: 'beta.service failed', detail: 'private alert', source: 'collector' }],
    }), { now: NOW });
    assert.equal(timeline.correlations.length, 0);
    assert.doesNotMatch(JSON.stringify(timeline), /private detail|private alert/);
  });

  it('shows alert recovery while preserving acknowledgement and authority semantics', () => {
    const timeline = buildIncidentTimeline(sources({ alerts: [{
      id: 3, created_at: '2026-09-03T10:00:00Z', last_observed_at: '2026-09-03T10:04:00Z',
      resolved_at: '2026-09-03T10:05:00Z', acknowledged: 1, host: 'control-node',
      category: 'journey', severity: 'critical', title: 'journey failed', source: 'synthetic-journey', detail: null,
    }] }), { now: NOW });
    const recovery = timeline.items.find((item) => item.kind === 'alert-resolved');
    assert.equal(recovery.resolutionReason, 'not-recorded');
    assert.equal(recovery.acknowledged, true);
    assert.equal(recovery.evidenceAuthority, 'Heimdall alert lifecycle');
  });
});

describe('incident timeline retention, loading, and rendering', () => {
  it('expires trace-bearing synthetic observations after six months', () => {
    const db = tmpDb();
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'expired', started_at: '2026-02-01T00:00:00Z', observed_at: '2026-02-01T00:00:01Z' }), '2026-02-01T00:00:02Z');
    insertSyntheticJourney(db, outcome(undefined, { attempt_id: 'retained', started_at: '2026-08-01T00:00:00Z', observed_at: '2026-08-01T00:00:01Z' }), '2026-08-01T00:00:02Z');
    assert.equal(pruneSyntheticJourneys(db, '2026-03-07T10:30:00Z'), 1);
    assert.deepEqual(db.prepare('SELECT attempt_id FROM synthetic_journeys').all().map((row) => row.attempt_id), ['retained']);
    db.close();
  });

  it('loads bounded local sources and renders visible uncertainty without raw details', async () => {
    const db = tmpDb();
    insertServiceVersion(db, '2026-09-03T10:00:00Z', 'heimdall', 'control-node', 'a'.repeat(40), 'a'.repeat(40), 0, 'up-to-date', null, 'pass', null);
    insertServiceVersion(db, '2026-09-03T10:01:00Z', 'heimdall', 'control-node', 'b'.repeat(40), 'b'.repeat(40), 0, 'up-to-date', null, 'pass', null);
    const alertId = createAlert(db, 'control-node', 'service', 'critical', 'heimdall.service failed', 'secret detail', { source: 'collector' });
    db.prepare('UPDATE alerts SET created_at = ?, last_observed_at = ? WHERE id = ?').run('2026-09-03T10:02:00Z', '2026-09-03T10:02:00Z', alertId);
    const timeline = loadIncidentTimeline(db, { now: NOW, from: '2026-09-03T09:00:00Z', to: '2026-09-03T10:30:00Z' });
    assert.ok(timeline.items.length >= 2);
    assert.ok(timeline.correlations.some((row) => row.mode === 'inferred'));
    const html = incidentTimelinePage('abc1234', timeline);
    assert.match(html, /Temporal correlation, not causation/);
    assert.match(html, /Inferred/);
    assert.doesNotMatch(html, /secret detail/);

    const { app } = buildApp(db, { now: () => NOW });
    await app.ready();
    try {
      const page = await app.inject({ method: 'GET', url: '/timeline?days=1' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Incident timeline/);
      assert.match(page.body, /href="\/timeline" class="active"/);
    } finally { await app.close(); db.close(); }
  });
});
