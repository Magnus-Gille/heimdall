'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSupervisionAudit,
  projectSupervisionAudit,
  enrichSupervisionProjection,
} = require('../src/systemd-supervision');

const NOW = Date.parse('2026-08-02T12:00:00Z');

function evidence(overrides = {}) {
  return {
    unit_result: { active_state: 'active', sub_state: 'running', result: 'success' },
    restart: { count: 0, window_start: '2026-08-02T11:54:00Z', window_end: '2026-08-02T11:55:00Z' },
    watchdog: { result: 'ok' },
    oom: { result: 'none' },
    timer: null,
    ...overrides,
  };
}

function unit(name, overrides = {}) {
  return {
    target_node_id: 'node-core', unit: name, owner: 'heimdall', scope: 'system',
    workload_shape: 'long-running', timer_class: null, status: 'pass', findings: [],
    evidence: evidence(),
    ...overrides,
  };
}

function audit(overrides = {}) {
  const units = overrides.units || [unit('heimdall.service')];
  return {
    kind: 'systemd-supervision-audit', schema_version: 'v1',
    baseline_id: 'fleet-systemd-supervision', baseline_digest: `sha256:${'a'.repeat(64)}`,
    topology_authority: 'grimnir-service-registry',
    observed_at: '2026-08-02T11:55:00Z', evaluated_at: '2026-08-02T12:00:00Z',
    evaluated_at_source: 'fixture-override',
    freshness: { status: 'fresh', age_seconds: 300, max_age_seconds: 900 },
    notifiers: [{ target_node_id: 'node-core', status: 'available' }],
    summary: { status: 'pass', unit_count: units.length, compliant_unit_count: units.length, finding_count: 0 },
    findings: [], extensions: [],
    ...overrides,
    units,
  };
}

describe('systemd supervision v1 projection', () => {
  it('accepts a closed canonical audit and sorts by node, scope, and unit', () => {
    const value = audit({ units: [
      unit('skuld.timer', {
        target_node_id: 'node-workshop', scope: 'user', workload_shape: 'timer', timer_class: 'calendar',
        evidence: evidence({ restart: null, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' }, timer: { last_run_at: '2026-08-02T11:50:00Z', next_run_at: '2026-08-02T12:10:00Z', last_result: 'success', missed_runs: null, persistent: null } }),
      }),
      unit('heimdall.service'),
    ] });
    assert.equal(validateSupervisionAudit(value).ok, true);
    const projected = projectSupervisionAudit(value, { now: NOW });
    assert.deepEqual(projected.units.map((row) => `${row.targetNodeId}:${row.scope}:${row.unit}`), [
      'node-core:system:heimdall.service',
      'node-workshop:user:skuld.timer',
    ]);
    assert.equal(projected.state, 'pass');
    assert.equal(projected.units[1].timer.lastDuration, null);
  });

  it('keeps successful inactive oneshots distinct from never-run timers', () => {
    const projected = projectSupervisionAudit(audit({ units: [
      unit('done.service', {
        workload_shape: 'oneshot',
        evidence: evidence({ unit_result: { active_state: 'inactive', sub_state: 'dead', result: 'success' }, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' } }),
      }),
      unit('new.timer', {
        workload_shape: 'timer', timer_class: 'calendar', status: 'fail',
        evidence: evidence({ restart: null, unit_result: { active_state: 'active', sub_state: 'waiting', result: 'success' }, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' }, timer: { last_run_at: null, next_run_at: '2026-08-02T12:10:00Z', last_result: 'not-run', missed_runs: 0, persistent: true } }),
      }),
    ] }), { now: NOW });
    assert.equal(projected.units[0].classification, 'inactive-success');
    assert.equal(projected.units[0].state, 'pass');
    assert.equal(projected.units[1].classification, 'never-run');
    assert.equal(projected.units[1].state, 'unknown');
  });

  it('distinguishes unavailable manager scope and absent units', () => {
    const unavailable = unit('down.service', { status: 'fail', findings: [{ code: 'failure_delivery_unavailable', severity: 'error', route: 'substrate' }] });
    const unavailableProjection = projectSupervisionAudit(audit({
      units: [unavailable],
      notifiers: [{ target_node_id: 'node-core', status: 'absent' }],
    }), { now: NOW });
    assert.equal(unavailableProjection.units[0].classification, 'manager-unavailable');

    const absent = unit('absent.service', { status: 'fail', evidence: null, findings: [{ code: 'observation_missing', severity: 'error', route: 'substrate' }] });
    const absentProjection = projectSupervisionAudit(audit({ units: [absent] }), { now: NOW });
    assert.equal(absentProjection.units[0].classification, 'unit-absent');
    assert.equal(absentProjection.units[0].state, 'unknown');
    assert.notEqual(absentProjection.state, 'pass');
  });

  it('does not infer a user-manager unit missing from system enumeration', () => {
    const user = unit('skuld.timer', {
      target_node_id: 'node-workshop', scope: 'user', workload_shape: 'timer', timer_class: 'calendar',
      evidence: evidence({ restart: null, unit_result: { active_state: 'active', sub_state: 'waiting', result: 'success' }, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' }, timer: { last_run_at: '2026-08-02T11:50:00Z', next_run_at: '2026-08-02T12:10:00Z', last_result: 'success', missed_runs: null, persistent: null } }),
    });
    const projected = projectSupervisionAudit(audit({ units: [user], notifiers: [] }), { now: NOW });
    assert.equal(projected.units[0].state, 'pass');
  });

  it('fails restart storms, watchdog timeouts, OOM kills, and overdue timers', () => {
    const cases = [
      unit('storm.service', { status: 'fail', findings: [{ code: 'restart_storm', severity: 'error', route: 'component-owner' }], evidence: evidence({ restart: { count: 5, window_start: '2026-08-02T11:54:00Z', window_end: '2026-08-02T11:55:00Z' } }) }),
      unit('watchdog.service', { status: 'fail', evidence: evidence({ watchdog: { result: 'timeout' } }) }),
      unit('oom.service', { status: 'fail', evidence: evidence({ oom: { result: 'killed' } }) }),
      unit('late.timer', { status: 'fail', workload_shape: 'timer', timer_class: 'calendar', findings: [{ code: 'timer_overdue', severity: 'error', route: 'component-owner' }], evidence: evidence({ restart: null, unit_result: { active_state: 'active', sub_state: 'waiting', result: 'success' }, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' }, timer: { last_run_at: '2026-08-02T10:00:00Z', next_run_at: '2026-08-02T11:54:00Z', last_result: 'success', missed_runs: 1, persistent: true } }) }),
    ];
    const projected = projectSupervisionAudit(audit({ units: cases }), { now: NOW });
    assert.equal(projected.units.every((row) => row.state === 'fail'), true);
    assert.equal(projected.units.find((row) => row.unit === 'late.timer').classification, 'overdue');
  });

  it('recomputes stale and future evidence with the trusted local clock', () => {
    const stale = projectSupervisionAudit(audit({ observed_at: '2026-08-02T11:00:00Z' }), { now: NOW });
    assert.equal(stale.freshness, 'stale');
    assert.equal(stale.units[0].state, 'stale');
    const future = projectSupervisionAudit(audit({ observed_at: '2026-08-02T12:00:06Z' }), { now: NOW });
    assert.equal(future.freshness, 'future');
    assert.equal(future.state, 'stale');
  });

  it('keeps v1-unavailable fields explicit and never promotes partial evidence', () => {
    const partial = audit({ units: [unit('partial.service', { evidence: null, status: 'fail' })] });
    const row = projectSupervisionAudit(partial, { now: NOW }).units[0];
    assert.equal(row.state, 'unknown');
    assert.equal(row.enabledState, null);
    assert.equal(row.processStartedAt, null);
    assert.equal(row.loadedRelease, null);
    assert.equal(row.timer, null);
  });

  it('joins only bounded local release and last-failure metadata when available', () => {
    const projected = projectSupervisionAudit(audit(), { now: NOW });
    const enriched = enrichSupervisionProjection(projected, {
      versions: [{ service: 'heimdall', deployed_commit: 'abc1234' }],
      events: [{ title: 'Service event: heimdall.service', severity: 'error', timestamp: '2026-08-02T11:50:00Z', detail: 'must not be copied' }],
    });
    assert.equal(enriched.units[0].loadedRelease, 'abc1234');
    assert.equal(enriched.units[0].lastFailureAt, '2026-08-02T11:50:00Z');
    assert.doesNotMatch(JSON.stringify(enriched), /must not be copied/);
  });

  it('rejects unknown fields, unsupported versions, and malformed nested data without echoing values', () => {
    const secret = 'never-echo-this';
    const unknown = audit({ [secret]: true });
    const checked = validateSupervisionAudit(unknown);
    assert.equal(checked.ok, false);
    assert.doesNotMatch(JSON.stringify(checked.errors), /never-echo-this/);
    assert.equal(validateSupervisionAudit({ ...audit(), schema_version: 'v2' }).ok, false);
    assert.equal(validateSupervisionAudit({ ...audit(), units: [{ ...unit('x.service'), evidence: { secret } }] }).ok, false);
    assert.equal(validateSupervisionAudit({ ...audit(), observed_at: '2026-02-30T12:00:00Z' }).ok, false);
    const duplicate = { code: 'timer_overdue', severity: 'error', route: 'component-owner' };
    assert.equal(validateSupervisionAudit(audit({ units: [unit('x.service', { findings: [duplicate, duplicate] })] })).ok, false);
    assert.equal(validateSupervisionAudit({ ...audit(), summary: { status: 'pass', unit_count: 513, compliant_unit_count: 513, finding_count: 0 } }).ok, false);
    assert.equal(projectSupervisionAudit(null).state, 'unknown');
    assert.equal(projectSupervisionAudit(audit(), { now: Number.NaN }).state, 'unknown');
  });
});

module.exports = { audit, unit, evidence, NOW };
