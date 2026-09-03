'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openDatabase, getSystemdSupervisionAudit } = require('../src/db');
const { handleSystemdSupervisionIngest } = require('../src/systemd-supervision-ingest');
const { renderSystemdSupervision, systemdSupervisionPage } = require('../src/render/systemd-supervision');
const { buildApp } = require('../src/server');

const NOW = Date.parse('2026-08-02T12:00:00Z');

function validAudit(observedAt = '2026-08-02T11:55:00Z') {
  return {
    kind: 'systemd-supervision-audit', schema_version: 'v1',
    baseline_id: 'fleet-systemd-supervision', baseline_digest: `sha256:${'a'.repeat(64)}`,
    topology_authority: 'grimnir-service-registry', observed_at: observedAt,
    evaluated_at: '2026-08-02T12:00:00Z', evaluated_at_source: 'clock',
    freshness: { status: 'fresh', age_seconds: 300, max_age_seconds: 900 },
    notifiers: [{ target_node_id: 'node-core', status: 'available' }],
    summary: { status: 'fail', unit_count: 2, compliant_unit_count: 1, finding_count: 1 },
    units: [
      {
        target_node_id: 'node-core', unit: 'heimdall.service', owner: 'heimdall', scope: 'system',
        workload_shape: 'long-running', timer_class: null, status: 'pass', findings: [],
        evidence: {
          unit_result: { active_state: 'active', sub_state: 'running', result: 'success' },
          restart: { count: 0, window_start: '2026-08-02T11:54:00Z', window_end: '2026-08-02T11:55:00Z' },
          watchdog: { result: 'ok' }, oom: { result: 'none' }, timer: null,
        },
      },
      {
        target_node_id: 'node-core', unit: 'heimdall-collect.timer', owner: 'heimdall', scope: 'system',
        workload_shape: 'timer', timer_class: 'calendar', status: 'fail',
        findings: [{ code: 'timer_overdue', severity: 'error', route: 'component-owner' }],
        evidence: {
          unit_result: { active_state: 'active', sub_state: 'waiting', result: 'success' },
          restart: null, watchdog: { result: 'not-requested' }, oom: { result: 'not-applicable' },
          timer: { last_run_at: '2026-08-02T10:00:00Z', next_run_at: '2026-08-02T11:54:00Z', last_result: 'success', missed_runs: 1, persistent: true },
        },
      },
    ],
    findings: [{ code: 'timer_overdue', severity: 'error', route: 'component-owner', target_node_id: 'node-core', scope: 'system', unit: 'heimdall-collect.timer', owner: 'heimdall' }],
    extensions: [],
  };
}

function tmpDb() {
  return openDatabase(path.join(os.tmpdir(), `heimdall-supervision-${process.pid}-${Date.now()}-${Math.random()}.db`));
}

describe('systemd supervision ingest and view', () => {
  it('uses dedicated fail-closed auth and monotonic observation storage', () => {
    const db = tmpDb();
    const body = validAudit();
    assert.equal(handleSystemdSupervisionIngest(db, { body }).status, 401);
    assert.equal(handleSystemdSupervisionIngest(db, { body, token: 'right', authHeader: 'Bearer wrong' }).status, 401);
    assert.equal(handleSystemdSupervisionIngest(db, { body, token: 'right', authHeader: 'Bearer right', now: NOW }).status, 200);
    assert.equal(handleSystemdSupervisionIngest(db, { body, token: 'right', authHeader: 'Bearer right', now: NOW }).body.replay, true);
    const reordered = {
      extensions: body.extensions, findings: body.findings, units: body.units,
      summary: body.summary, notifiers: body.notifiers, freshness: body.freshness,
      evaluated_at_source: body.evaluated_at_source, evaluated_at: body.evaluated_at,
      observed_at: body.observed_at, topology_authority: body.topology_authority,
      baseline_digest: body.baseline_digest, baseline_id: body.baseline_id,
      schema_version: body.schema_version, kind: body.kind,
    };
    const semanticReplay = handleSystemdSupervisionIngest(db, {
      body: reordered, token: 'right', authHeader: 'Bearer right', now: NOW,
    });
    assert.equal(semanticReplay.status, 200);
    assert.equal(semanticReplay.body.replay, true);
    assert.equal(getSystemdSupervisionAudit(db).audit.observed_at, body.observed_at);
    assert.equal(handleSystemdSupervisionIngest(db, { body: validAudit('2026-08-02T11:54:00Z'), token: 'right', authHeader: 'Bearer right', now: NOW }).status, 409);
    assert.equal(handleSystemdSupervisionIngest(db, { body: { ...body, schema_version: 'v2' }, token: 'right', authHeader: 'Bearer right', now: NOW }).status, 422);
    db.close();
  });

  it('preserves persistence diagnostics without exposing them to the caller', () => {
    const seen = [];
    const result = handleSystemdSupervisionIngest({}, {
      body: validAudit(), token: 'right', authHeader: 'Bearer right', now: NOW,
      logger: { error: (...args) => seen.push(args) },
    });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'persist failed' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][1], 'systemd supervision persistence failed');
  });

  it('renders outcome distinctions without inventing unavailable v1 fields or controls', () => {
    const row = { state: 'valid', audit: validAudit() };
    const html = renderSystemdSupervision(row, NOW);
    assert.match(html, /heimdall\.service/);
    assert.match(html, /heimdall-collect\.timer/);
    assert.match(html, /Overdue/);
    assert.match(html, /not reported by v1/);
    assert.doesNotMatch(html, /Restart unit|Enable unit|Disable unit/);
    const page = systemdSupervisionPage('abc1234', row, NOW);
    assert.match(page, /Systemd supervision/);
    assert.match(page, /href="\/supervision" class="active"/);
  });

  it('never renders missing, malformed, or stale evidence as healthy', () => {
    assert.doesNotMatch(renderSystemdSupervision({ state: 'missing' }, NOW), /All units healthy/);
    assert.match(renderSystemdSupervision({ state: 'malformed' }, NOW), /Unknown/);
    assert.match(renderSystemdSupervision({ state: 'valid', audit: validAudit('2026-08-02T11:00:00Z') }, NOW), /Stale/);
    const replay = { ...validAudit(), evaluated_at_source: 'fixture-override' };
    const replayHtml = renderSystemdSupervision({ state: 'valid', audit: replay }, NOW);
    assert.match(replayHtml, /Fixture replay/);
    assert.doesNotMatch(replayHtml, /All units healthy|>Healthy</);
  });

  it('enforces the route token and body limit, then exposes the read-only page', async () => {
    const db = tmpDb();
    const previous = process.env.HEIMDALL_SUPERVISION_TOKEN;
    process.env.HEIMDALL_SUPERVISION_TOKEN = 'route-token';
    const { app } = buildApp(db, { now: () => NOW });
    await app.ready();
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/systemd-supervision', payload: validAudit() });
      assert.equal(denied.statusCode, 401);
      const accepted = await app.inject({ method: 'POST', url: '/api/systemd-supervision', headers: { authorization: 'Bearer route-token' }, payload: validAudit() });
      assert.equal(accepted.statusCode, 200);
      const page = await app.inject({ method: 'GET', url: '/supervision' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /heimdall-collect\.timer/);
      const tooLarge = await app.inject({ method: 'POST', url: '/api/systemd-supervision', headers: { authorization: 'Bearer route-token' }, payload: { kind: 'systemd-supervision-audit', padding: 'x'.repeat(300 * 1024) } });
      assert.equal(tooLarge.statusCode, 413);
    } finally {
      await app.close(); db.close();
      if (previous === undefined) delete process.env.HEIMDALL_SUPERVISION_TOKEN;
      else process.env.HEIMDALL_SUPERVISION_TOKEN = previous;
    }
  });
});
