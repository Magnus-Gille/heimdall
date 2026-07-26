'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, getActiveAlerts } = require('../src/db');
const { checkThresholds, detectReboot, THRESHOLDS } = require('../src/events');
const { validateDiskThresholds } = require('../src/config/disk-thresholds');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('THRESHOLDS', () => {
  it('defines expected metrics', () => {
    assert.ok(THRESHOLDS.cpu_temp);
    assert.ok(THRESHOLDS.mem_used_pct);
    assert.ok(THRESHOLDS.disk_used_pct_sd);
    assert.ok(THRESHOLDS.load_1m);
  });

  it('warning < critical for all thresholds', () => {
    for (const [metric, t] of Object.entries(THRESHOLDS)) {
      assert.ok(t.warning < t.critical, `${metric}: warning should be < critical`);
    }
  });
});

describe('quota-governed backup volume thresholds (#29)', () => {
  const volumes = validateDiskThresholds({
    disk_used_pct_nas: {
      purpose: 'quota_backup',
      total_bytes: 1_800_000_000_000,
      quota_bytes: 1_500_000_000_000,
      warning_reserve_fraction: 0.5,
      critical_reserve_fraction: 0.25,
    },
    disk_used_pct_m5: {
      purpose: 'quota_backup',
      total_bytes: 3_600_000_000_000,
      quota_bytes: 3_000_000_000_000,
      warning_reserve_fraction: 0.5,
      critical_reserve_fraction: 0.25,
    },
  });

  it('keeps mature NAS and M5 Time Machine quotas quiet', () => {
    const db = tmpDb();
    checkThresholds(db, 'nas', { disk_used_pct_nas: 87 }, volumes);
    checkThresholds(db, 'm5', { disk_used_pct_m5: 83 }, volumes);
    assert.deepStrictEqual(getActiveAlerts(db), []);
    db.close();
  });

  it('alerts when use consumes a material part of reserved non-quota slack', () => {
    const db = tmpDb();
    checkThresholds(db, 'nas', { disk_used_pct_nas: 92 }, volumes);
    let alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');

    checkThresholds(db, 'm5', { disk_used_pct_m5: 96 }, volumes);
    alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.find((a) => a.host === 'm5').severity, 'critical');
    db.close();
  });

  it('rejects quota policies that cannot leave an escalating reserve', () => {
    assert.throws(() => validateDiskThresholds({
      bad: {
        purpose: 'quota_backup', total_bytes: 100, quota_bytes: 100,
        warning_reserve_fraction: 0.5, critical_reserve_fraction: 0.25,
      },
    }), /quota_bytes.*less than total_bytes/u);
  });
});

describe('checkThresholds', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('creates critical alert when value exceeds critical threshold', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 80 });
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    db.close();
  });

  it('creates warning alert when value exceeds warning but not critical', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 68 });
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');
    db.close();
  });

  it('updates an active warning to critical so the critical transition can notify', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 68 });
    checkThresholds(db, 'control-node', { cpu_temp: 80 });
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].notification_sent_at, null);
    db.close();
  });

  it('resolves alert when value returns to normal', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 80 });
    assert.strictEqual(getActiveAlerts(db).length, 1);

    checkThresholds(db, 'control-node', { cpu_temp: 50 });
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('does not create alert for normal values', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 45, mem_used_pct: 50 });
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('handles multiple metrics in one call', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 80, mem_used_pct: 95 });
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 2);
    db.close();
  });

  it('skips null metric values', () => {
    checkThresholds(db, 'control-node', { cpu_temp: null, mem_used_pct: undefined });
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('logs events alongside alerts', () => {
    checkThresholds(db, 'control-node', { cpu_temp: 80 });
    const events = db.prepare('SELECT * FROM events').all();
    assert.ok(events.length >= 1);
    assert.ok(events[0].title.includes('cpu_temp'));
    db.close();
  });
});

describe('detectReboot', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('logs reboot when uptime drops', () => {
    detectReboot(db, 'control-node', 300, 86400);
    const events = db.prepare('SELECT * FROM events').all();
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].title.includes('rebooted'));
    db.close();
  });

  it('does not log when uptime increases', () => {
    detectReboot(db, 'control-node', 86400, 300);
    const events = db.prepare('SELECT * FROM events').all();
    assert.strictEqual(events.length, 0);
    db.close();
  });

  it('does not log when previous uptime is null', () => {
    detectReboot(db, 'control-node', 300, null);
    const events = db.prepare('SELECT * FROM events').all();
    assert.strictEqual(events.length, 0);
    db.close();
  });
});

describe('checkThresholds — retired metrics (regression)', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('resolves an alert when its metric disappears from the payload', () => {
    // Live defect: "disk_used_pct_nas % threshold on nas" was open from
    // 2026-07-02. The NAS probe stopped delivering that series on 2026-07-22,
    // and the `if (value == null) continue;` guard made the resolve branch dead
    // code — so the breach could never be un-asserted.
    checkThresholds(db, 'nas', { disk_used_pct_nas: 92 });
    assert.strictEqual(getActiveAlerts(db).length, 1);

    checkThresholds(db, 'nas', { mem_used_pct: 10 }); // series retired
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
    db.close();
  });

  it('does not invent alerts for metrics a host never reports', () => {
    checkThresholds(db, 'm5', {});
    assert.deepStrictEqual(getActiveAlerts(db).map((a) => a.title), []);
    db.close();
  });
});
