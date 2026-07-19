'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  openDatabase,
  insertMetric,
  insertMetrics,
  getLatestMetrics,
  getMetricHistory,
  getMetricHistoryWithRollup,
  insertEvent,
  getRecentEvents,
  searchEvents,
  getActiveAlerts,
  createAlert,
  resolveAlert,
  acknowledgeAlert,
  insertServiceVersion,
  getLatestServiceVersions,
  getLastCollectionTime,
  saveProcessSnapshot,
  getProcessSnapshot,
  isValidMetricHost,
  upsertServiceSnapshot,
  getServiceSnapshots,
  getServiceSnapshot,
  pruneServiceSnapshots,
  getLatestTimerRun,
} = require('../src/db');
const { handlePush } = require('../src/fleet/ingest');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
  const dbPath = path.join(dir, 'test.db');
  return openDatabase(dbPath);
}

describe('openDatabase', () => {
  it('creates database with all tables', () => {
    const db = tmpDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = tables.map(t => t.name);
    assert.ok(names.includes('metrics'));
    assert.ok(names.includes('metrics_rollup'));
    assert.ok(names.includes('events'));
    assert.ok(names.includes('alerts'));
    assert.ok(names.includes('service_versions'));
    assert.ok(names.includes('process_snapshots'));
    assert.ok(names.includes('fleet_hosts'));
    assert.ok(names.includes('fleet_metrics'));
    assert.ok(names.includes('service_snapshots'));
    db.close();
  });

  it('runs migrations idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
    const dbPath = path.join(dir, 'test.db');
    const db1 = openDatabase(dbPath);
    db1.close();
    // Open again — should not throw
    const db2 = openDatabase(dbPath);
    const version = db2.pragma('user_version', { simple: true });
    assert.strictEqual(version, 6); // bump when MIGRATIONS grows (v3 fleet, v4 service_snapshots, v5 alerts dedup_key/source, v6 panels)
    db2.close();
  });
});

describe('metrics', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('insertMetric and getLatestMetrics', () => {
    const ts = new Date().toISOString();
    insertMetric(db, ts, 'control-node', 'cpu_temp', 45.2, '°C', null);
    insertMetric(db, ts, 'control-node', 'mem_used_pct', 62, '%', null);

    const metrics = getLatestMetrics(db, 'control-node');
    assert.strictEqual(metrics.length, 2);
    assert.ok(metrics.some(m => m.metric === 'cpu_temp' && m.value === 45.2));
    assert.ok(metrics.some(m => m.metric === 'mem_used_pct' && m.value === 62));
    db.close();
  });

  it('insertMetric uses INSERT OR REPLACE (idempotent)', () => {
    const ts = '2025-01-01T12:00:00Z';
    insertMetric(db, ts, 'control-node', 'cpu_temp', 45, '°C', null);
    insertMetric(db, ts, 'control-node', 'cpu_temp', 46, '°C', null);

    const rows = db.prepare('SELECT * FROM metrics WHERE metric = ?').all('cpu_temp');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value, 46);
    db.close();
  });

  it('insertMetrics batch insert', () => {
    const ts = new Date().toISOString();
    insertMetrics(db, [
      { timestamp: ts, host: 'nas', metric: 'disk_used_pct', value: 55, unit: '%' },
      { timestamp: ts, host: 'nas', metric: 'mem_used_pct', value: 70, unit: '%' },
    ]);

    const metrics = getLatestMetrics(db, 'nas');
    assert.strictEqual(metrics.length, 2);
    db.close();
  });

  it('getMetricHistory returns ordered results', () => {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.now() - (4 - i) * 60000).toISOString();
      insertMetric(db, ts, 'control-node', 'cpu_temp', 40 + i, '°C', null);
    }

    const from = new Date(Date.now() - 300000).toISOString();
    const to = new Date().toISOString();
    const history = getMetricHistory(db, 'control-node', 'cpu_temp', from, to);
    assert.strictEqual(history.length, 5);
    // Verify ascending order
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].timestamp >= history[i - 1].timestamp);
    }
    db.close();
  });

  it('getLastCollectionTime returns most recent timestamp', () => {
    insertMetric(db, '2025-01-01T10:00:00Z', 'control-node', 'cpu_temp', 40, '°C', null);
    insertMetric(db, '2025-01-01T12:00:00Z', 'control-node', 'load_1m', 1, '', null);
    const last = getLastCollectionTime(db, 'control-node');
    assert.strictEqual(last, '2025-01-01T12:00:00Z');
    db.close();
  });

  it('getLastCollectionTime returns null for unknown host', () => {
    const last = getLastCollectionTime(db, 'nonexistent');
    assert.strictEqual(last, null);
    db.close();
  });

  it('stores and retrieves metadata as JSON', () => {
    const ts = new Date().toISOString();
    insertMetric(db, ts, 'control-node', 'cpu_temp', 45, '°C', { source: 'proc' });
    const metrics = getLatestMetrics(db, 'control-node');
    assert.strictEqual(JSON.parse(metrics[0].metadata).source, 'proc');
    db.close();
  });
});

describe('events', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('insertEvent and getRecentEvents', () => {
    const ts = new Date().toISOString();
    insertEvent(db, ts, 'control-node', 'security', 'info', 'SSH login', 'user root', 'collector');
    const events = getRecentEvents(db);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].title, 'SSH login');
    assert.strictEqual(events[0].source, 'collector');
    db.close();
  });

  it('getRecentEvents respects limit', () => {
    for (let i = 0; i < 30; i++) {
      insertEvent(db, new Date().toISOString(), 'h', 'system', 'info', `Event ${i}`, null, null);
    }
    const events = getRecentEvents(db, 5);
    assert.strictEqual(events.length, 5);
    db.close();
  });

  it('searchEvents filters by category and severity', () => {
    const ts = new Date().toISOString();
    insertEvent(db, ts, 'h', 'security', 'warning', 'Suspicious', null, null);
    insertEvent(db, ts, 'h', 'system', 'info', 'Normal', null, null);

    const security = searchEvents(db, { category: 'security' });
    assert.strictEqual(security.length, 1);
    assert.strictEqual(security[0].title, 'Suspicious');

    const warnings = searchEvents(db, { severity: 'warning' });
    assert.strictEqual(warnings.length, 1);
    db.close();
  });
});

describe('alerts', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('createAlert and getActiveAlerts', () => {
    createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', 'TM > 3h');
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].title, 'Backup stale');
    assert.strictEqual(alerts[0].severity, 'warning');
    db.close();
  });

  it('createAlert deduplicates active alerts', () => {
    const id1 = createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', 'detail');
    const id2 = createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', 'detail 2');
    assert.strictEqual(id1, id2);
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    db.close();
  });

  it('resolveAlert marks alert as resolved', () => {
    createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', null);
    resolveAlert(db, 'nas', 'Backup stale');
    const active = getActiveAlerts(db);
    assert.strictEqual(active.length, 0);
    db.close();
  });

  it('acknowledgeAlert sets acknowledged flag', () => {
    const id = createAlert(db, 'nas', 'backup', 'warning', 'Test', null);
    acknowledgeAlert(db, id);
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts[0].acknowledged, 1);
    db.close();
  });

  it('resolved alerts can be recreated', () => {
    createAlert(db, 'nas', 'backup', 'warning', 'Test', null);
    resolveAlert(db, 'nas', 'Test');
    createAlert(db, 'nas', 'backup', 'critical', 'Test', 'new detail');
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    db.close();
  });
});

describe('service versions', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('insertServiceVersion and getLatestServiceVersions', () => {
    insertServiceVersion(db, '2025-01-01T10:00:00Z', 'heimdall', 'control-node', 'abc123', 'def456', 3);
    insertServiceVersion(db, '2025-01-01T12:00:00Z', 'heimdall', 'control-node', 'def456', 'def456', 0);

    const versions = getLatestServiceVersions(db);
    assert.strictEqual(versions.length, 1);
    assert.strictEqual(versions[0].deployed_commit, 'def456');
    assert.strictEqual(versions[0].commits_behind, 0);
    db.close();
  });
});

describe('process snapshots', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('saveProcessSnapshot and getProcessSnapshot', () => {
    const procs = [{ user: 'root', cpu: 50, command: 'node' }];
    saveProcessSnapshot(db, 'control-node', 'cpu', procs);

    const snap = getProcessSnapshot(db, 'control-node', 'cpu');
    assert.ok(snap);
    assert.deepStrictEqual(JSON.parse(snap.processes), procs);
    db.close();
  });

  it('saveProcessSnapshot replaces previous for same host+sortBy', () => {
    saveProcessSnapshot(db, 'h', 'cpu', [{ cpu: 10 }]);
    saveProcessSnapshot(db, 'h', 'cpu', [{ cpu: 90 }]);

    const count = db.prepare('SELECT COUNT(*) as c FROM process_snapshots WHERE host = ? AND sort_by = ?').get('h', 'cpu');
    assert.strictEqual(count.c, 1);

    const snap = getProcessSnapshot(db, 'h', 'cpu');
    assert.deepStrictEqual(JSON.parse(snap.processes), [{ cpu: 90 }]);
    db.close();
  });
});

describe('isValidMetricHost', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('accepts the SSH-collected hosts', () => {
    assert.ok(isValidMetricHost(db, 'control-node'));
    assert.ok(isValidMetricHost(db, 'nas'));
  });

  it('rejects an unknown host', () => {
    assert.ok(!isValidMetricHost(db, 'bogus'));
  });

  it('accepts a fleet host once it has pushed telemetry', () => {
    handlePush(db, { body: { hostname: 'm5', temp_cpu_c: 40 }, allowInsecureLoopback: true, now: Date.now() });
    assert.ok(isValidMetricHost(db, 'm5'));
  });

  it('rejects malformed host strings', () => {
    assert.ok(!isValidMetricHost(db, '../etc'));
    assert.ok(!isValidMetricHost(db, 'Robert; DROP'));
    assert.ok(!isValidMetricHost(db, ''));
    assert.ok(!isValidMetricHost(db, 'A'));
    assert.ok(!isValidMetricHost(db, 'a'.repeat(100)));
  });
});

// #93 — reconcile snapshots to the current config so renamed/removed services
// stop rendering as stale cards without manual DB surgery.
describe('pruneServiceSnapshots', () => {
  const snap = (service) => ({
    service, kind: 'http-service', status: 'pass', descriptor: null,
    fetchedAt: '2026-07-02T00:00:00Z', reachable: true, schemaVersion: null,
    source: 'health', error: null,
  });

  it('deletes rows whose service is not in the keep list', () => {
    const db = tmpDb();
    for (const s of ['a', 'b', 'c']) upsertServiceSnapshot(db, snap(s));
    const removed = pruneServiceSnapshots(db, ['a', 'b']);
    assert.equal(removed, 1);
    assert.deepEqual(getServiceSnapshots(db).map((r) => r.service), ['a', 'b']);
    db.close();
  });

  it('is a no-op when the keep list is empty (never nukes the table)', () => {
    const db = tmpDb();
    for (const s of ['a', 'b']) upsertServiceSnapshot(db, snap(s));
    const removed = pruneServiceSnapshots(db, []);
    assert.equal(removed, 0);
    assert.equal(getServiceSnapshots(db).length, 2);
    db.close();
  });

  it('tolerates keep names that are absent from the table', () => {
    const db = tmpDb();
    upsertServiceSnapshot(db, snap('a'));
    const removed = pruneServiceSnapshots(db, ['a', 'ghost']);
    assert.equal(removed, 0);
    assert.deepEqual(getServiceSnapshots(db).map((r) => r.service), ['a']);
    db.close();
  });

  it('ignores non-string / empty keep entries without wiping everything', () => {
    const db = tmpDb();
    for (const s of ['a', 'b']) upsertServiceSnapshot(db, snap(s));
    // A keep list that degenerates to empty after filtering must be a no-op.
    const removed = pruneServiceSnapshots(db, [null, '', undefined]);
    assert.equal(removed, 0);
    assert.equal(getServiceSnapshots(db).length, 2);
    db.close();
  });

  // #97 secondary bug: a snapshot read back from the DB must expose fetchedAt
  // (camelCase) so the renderer's formatAge(v.fetchedAt) doesn't say "never".
  it('hydrates fetchedAt (camelCase) from the fetched_at column', () => {
    const db = tmpDb();
    upsertServiceSnapshot(db, snap('munin-memory'));
    const row = getServiceSnapshot(db, 'munin-memory');
    assert.equal(row.fetchedAt, '2026-07-02T00:00:00Z');
    db.close();
  });
});

// #97 — timer last-run state, read from the timer_* metrics drift.js persists.
describe('getLatestTimerRun', () => {
  const { insertMetrics } = require('../src/db');
  const seed = (db, service, { result, resultMeta, lastRun, nextRun, ts = '2026-07-02T00:00:00Z' }) => {
    const rows = [];
    if (result != null) rows.push({ timestamp: ts, host: 'control-node', metric: `timer_last_result_${service}`, value: result, unit: 'status', metadata: resultMeta });
    if (lastRun != null) rows.push({ timestamp: ts, host: 'control-node', metric: `timer_last_run_${service}`, value: 0, unit: 'timestamp', metadata: lastRun });
    if (nextRun != null) rows.push({ timestamp: ts, host: 'control-node', metric: `timer_next_run_${service}`, value: 0, unit: 'timestamp', metadata: nextRun });
    insertMetrics(db, rows);
  };

  it('returns null when no timer metrics exist for the service', () => {
    const db = tmpDb();
    assert.equal(getLatestTimerRun(db, 'nope'), null);
    db.close();
  });

  it('reads exit result, last-run and next-run for a service with hyphens', () => {
    const db = tmpDb();
    seed(db, 'brokkr-maintenance-os', { result: 1, resultMeta: 'ok', lastRun: '2026-07-02T03:00:00Z', nextRun: '2026-07-03T03:00:00Z' });
    const r = getLatestTimerRun(db, 'brokkr-maintenance-os');
    assert.equal(r.exitOk, true);
    assert.equal(r.lastResult, 'ok');
    assert.equal(r.lastRun, '2026-07-02T03:00:00Z');
    assert.equal(r.nextRun, '2026-07-03T03:00:00Z');
    db.close();
  });

  it('surfaces a non-zero exit as exitOk:false', () => {
    const db = tmpDb();
    seed(db, 'grimnir-validate', { result: 0, resultMeta: 'exit 1', lastRun: '2026-07-02T03:00:00Z' });
    const r = getLatestTimerRun(db, 'grimnir-validate');
    assert.equal(r.exitOk, false);
    assert.equal(r.lastResult, 'exit 1');
    db.close();
  });

  it('returns the most recent row when metrics accumulate over time', () => {
    const db = tmpDb();
    seed(db, 'skuld', { result: 0, resultMeta: 'exit 2', lastRun: '2026-07-01T06:00:00Z', ts: '2026-07-01T06:00:00Z' });
    seed(db, 'skuld', { result: 1, resultMeta: 'ok', lastRun: '2026-07-02T06:00:00Z', ts: '2026-07-02T06:00:00Z' });
    const r = getLatestTimerRun(db, 'skuld');
    assert.equal(r.exitOk, true);
    assert.equal(r.lastRun, '2026-07-02T06:00:00Z');
    db.close();
  });
});
