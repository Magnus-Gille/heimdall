'use strict';

/**
 * Regression tests for defect 2: zombie alerts bound to dead host identities and
 * retired metrics.
 *
 * Live evidence (2026-07-25):
 *   - "mem_used_pct % threshold on huginmunin", open since 2026-07-23T05:05.
 *     Host identity `huginmunin` stopped producing metrics at 2026-07-23T08:58;
 *     the same physical machine now reports as `control-node`. `checkThresholds`
 *     is only ever called with a host that just reported, so nothing can ever
 *     resolve the orphaned row.
 *   - "disk_used_pct_nas % threshold on nas", open since 2026-07-02. That metric
 *     last appeared 2026-07-22T18:40 — the NAS SSH probe stopped delivering it,
 *     and `checkThresholds` skips absent metrics with `continue`, so the resolve
 *     branch is never reached.
 *   - "Backup stale: TM Backup" has the same shape (its evidence comes from the
 *     same dead NAS probe).
 *
 * The class fix: every alert carries `last_observed_at`, refreshed each time its
 * condition is re-asserted. An active alert nobody has re-asserted for longer
 * than the staleness window is unobservable and is auto-closed as "stale — no
 * data" rather than left firing forever.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, createAlert, getActiveAlerts } = require('../src/db');
const { reapStaleAlerts, DEFAULT_STALE_MS } = require('../src/alert-reaper');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-reaper-'));
  return openDatabase(path.join(dir, 'test.db'));
}

/** Force an alert row's observation bookkeeping into the past. */
function ageAlert(db, id, iso) {
  db.prepare('UPDATE alerts SET created_at = ?, last_observed_at = ? WHERE id = ?').run(iso, iso, id);
}

const NOW = Date.parse('2026-07-25T18:40:00Z');

describe('createAlert observation bookkeeping', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('stamps last_observed_at when an alert is raised', () => {
    const id = createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
    const row = db.prepare('SELECT last_observed_at FROM alerts WHERE id = ?').get(id);
    assert.ok(row.last_observed_at, 'last_observed_at must be set on insert');
  });

  it('refreshes last_observed_at when the same condition is re-asserted', () => {
    const id = createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
    ageAlert(db, id, '2026-07-01T00:00:00Z');
    createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
    const row = db.prepare('SELECT last_observed_at FROM alerts WHERE id = ?').get(id);
    assert.notStrictEqual(row.last_observed_at, '2026-07-01T00:00:00Z');
  });
});

describe('reapStaleAlerts', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('closes an alert bound to a host identity that stopped reporting', () => {
    const id = createAlert(db, 'huginmunin', 'anomaly', 'warning',
      'mem_used_pct % threshold on huginmunin', '84.2% >= 80%');
    ageAlert(db, id, '2026-07-23T05:05:34.142Z');
    const out = reapStaleAlerts(db, { now: NOW });
    assert.strictEqual(out.resolved.length, 1);
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
  });

  it('closes an alert whose underlying metric was retired', () => {
    const id = createAlert(db, 'nas', 'anomaly', 'warning',
      'disk_used_pct_nas % threshold on nas', '80% >= 80%');
    ageAlert(db, id, '2026-07-02T04:10:21.080Z');
    reapStaleAlerts(db, { now: NOW });
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
  });

  it('records WHY it closed, so a stale close is not confused with a recovery', () => {
    const id = createAlert(db, 'nas', 'backup', 'critical', 'Backup stale: TM Backup', 'last seen 23h ago');
    ageAlert(db, id, '2026-07-21T21:20:35.457Z');
    reapStaleAlerts(db, { now: NOW });
    const row = db.prepare('SELECT detail, resolved_at FROM alerts WHERE id = ?').get(id);
    assert.ok(row.resolved_at);
    assert.match(row.detail, /stale — no data/);
  });

  it('leaves a freshly re-asserted alert alone', () => {
    createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: hugin', '4 commits behind');
    const out = reapStaleAlerts(db, { now: NOW });
    assert.deepStrictEqual(out.resolved, []);
    assert.strictEqual(getActiveAlerts(db).length, 1);
  });

  it('does not reap an alert that is merely old but still being observed', () => {
    const id = createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: hugin', '4 commits behind');
    // created long ago, but re-asserted seconds ago — this is a real, live alert
    db.prepare('UPDATE alerts SET created_at = ? WHERE id = ?').run('2026-06-01T00:00:00Z', id);
    reapStaleAlerts(db, { now: NOW });
    assert.strictEqual(getActiveAlerts(db).length, 1);
  });

  it('treats a legacy row with no last_observed_at as observed at creation time', () => {
    const id = createAlert(db, 'huginmunin', 'anomaly', 'warning', 'legacy', 'x');
    db.prepare('UPDATE alerts SET created_at = ?, last_observed_at = NULL WHERE id = ?')
      .run('2026-07-01T00:00:00Z', id);
    reapStaleAlerts(db, { now: NOW });
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
  });

  it('honours a caller-supplied staleness window', () => {
    const id = createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
    ageAlert(db, id, new Date(NOW - 3600_000).toISOString()); // 1h ago
    reapStaleAlerts(db, { now: NOW, maxAgeMs: 30 * 60_000 });
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
  });

  it('defaults to a window generous enough not to reap a slow-cycling alert', () => {
    assert.ok(DEFAULT_STALE_MS >= 2 * 3600_000, 'default staleness window should be hours, not minutes');
  });

  it('logs an event so the auto-close is auditable', () => {
    const id = createAlert(db, 'huginmunin', 'anomaly', 'warning', 'mem_used_pct % threshold on huginmunin', 'x');
    ageAlert(db, id, '2026-07-23T05:05:34.142Z');
    reapStaleAlerts(db, { now: NOW });
    const ev = db.prepare("SELECT * FROM events WHERE category = 'alert' ORDER BY id DESC LIMIT 1").get();
    assert.ok(ev, 'expected an audit event for the auto-close');
    assert.match(ev.title, /stale/i);
  });
});

describe('reconcileAlertHosts', () => {
  const { reconcileAlertHosts } = require('../src/alert-reaper');
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('moves an alert off a retired host identity onto the canonical one', () => {
    const id = createAlert(db, 'huginmunin', 'deploy', 'warning', 'Deploy drift: hugin', 'x');
    const out = reconcileAlertHosts(db, { huginmunin: 'control-node' });
    assert.strictEqual(out.migrated, 1);
    assert.strictEqual(db.prepare('SELECT host FROM alerts WHERE id = ?').get(id).host, 'control-node');
  });

  it('merges rather than duplicating when the canonical host already has that alert', () => {
    createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: hugin', 'live');
    const stale = createAlert(db, 'huginmunin', 'deploy', 'warning', 'Deploy drift: hugin', 'legacy');
    const out = reconcileAlertHosts(db, { huginmunin: 'control-node' });
    assert.strictEqual(out.merged, 1);
    assert.ok(db.prepare('SELECT resolved_at FROM alerts WHERE id = ?').get(stale).resolved_at);
    assert.strictEqual(getActiveAlerts(db).length, 1);
  });

  it('is idempotent and a no-op without aliases', () => {
    createAlert(db, 'huginmunin', 'deploy', 'warning', 'Deploy drift: hugin', 'x');
    assert.deepStrictEqual(reconcileAlertHosts(db, {}), { migrated: 0, merged: 0 });
    reconcileAlertHosts(db, { huginmunin: 'control-node' });
    assert.deepStrictEqual(reconcileAlertHosts(db, { huginmunin: 'control-node' }), { migrated: 0, merged: 0 });
  });

  it('leaves unaliased hosts alone', () => {
    createAlert(db, 'nas', 'backup', 'critical', 'Backup stale: TM Backup', 'x');
    reconcileAlertHosts(db, { huginmunin: 'control-node' });
    assert.strictEqual(getActiveAlerts(db)[0].host, 'nas');
  });
});

describe('reapStaleAlerts — HEIMDALL_ALERT_STALE_HOURS override', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('honours the documented env override', () => {
    const prev = process.env.HEIMDALL_ALERT_STALE_HOURS;
    process.env.HEIMDALL_ALERT_STALE_HOURS = '1';
    try {
      const id = createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
      ageAlert(db, id, new Date(NOW - 2 * 3600_000).toISOString());
      reapStaleAlerts(db, { now: NOW });
      assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
    } finally {
      if (prev == null) delete process.env.HEIMDALL_ALERT_STALE_HOURS;
      else process.env.HEIMDALL_ALERT_STALE_HOURS = prev;
    }
  });

  it('ignores a malformed override and falls back to the default window', () => {
    const prev = process.env.HEIMDALL_ALERT_STALE_HOURS;
    process.env.HEIMDALL_ALERT_STALE_HOURS = 'not-a-number';
    try {
      const id = createAlert(db, 'control-node', 'anomaly', 'warning', 'x', 'y');
      ageAlert(db, id, new Date(NOW - 3600_000).toISOString());
      reapStaleAlerts(db, { now: NOW });
      assert.strictEqual(getActiveAlerts(db).length, 1);
    } finally {
      if (prev == null) delete process.env.HEIMDALL_ALERT_STALE_HOURS;
      else process.env.HEIMDALL_ALERT_STALE_HOURS = prev;
    }
  });
});
