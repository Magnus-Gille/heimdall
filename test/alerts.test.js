'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, getActiveAlerts } = require('../src/db');
const { createAlert, resolveAlert, checkBackupStaleness } = require('../src/alerts');
const { loadBackupDefinitions } = require('../src/backup-config');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('checkBackupStaleness', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('creates critical alert when TM Backup misses two weekly cycles', () => {
    const staleTs = new Date(Date.now() - 337 * 3600000).toISOString();
    checkBackupStaleness(db, 'TM Backup', staleTs);

    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.ok(alerts[0].title.includes('TM Backup'));
    db.close();
  });

  it('creates warning alert when TM Backup exceeds its weekly warning multiplier', () => {
    const staleTs = new Date(Date.now() - 253 * 3600000).toISOString();
    checkBackupStaleness(db, 'TM Backup', staleTs);

    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'warning');
    db.close();
  });

  it('treats a same-day Munin DB backup as fresh (daily schedule)', () => {
    // 14h old — well within a daily cadence; the old 6h threshold falsely
    // flagged this every afternoon. Must not alert now.
    const ts = new Date(Date.now() - 14 * 3600000).toISOString();
    checkBackupStaleness(db, 'Munin DB', ts);
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('flags Munin DB critical only after a full missed day (>30h)', () => {
    const ts = new Date(Date.now() - 31 * 3600000).toISOString();
    checkBackupStaleness(db, 'Munin DB', ts);
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    db.close();
  });

  it('resolves alert when backup is fresh', () => {
    // First create a stale alert
    const staleTs = new Date(Date.now() - 337 * 3600000).toISOString();
    checkBackupStaleness(db, 'TM Backup', staleTs);
    assert.strictEqual(getActiveAlerts(db).length, 1);

    // Now report fresh
    const freshTs = new Date(Date.now() - 30 * 60000).toISOString();
    checkBackupStaleness(db, 'TM Backup', freshTs);
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('does nothing for null timestamp', () => {
    checkBackupStaleness(db, 'TM Backup', null);
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });

  it('does not apply a global threshold to an undeclared backup source', () => {
    assert.throws(
      () => checkBackupStaleness(db, 'Unknown Backup', new Date().toISOString()),
      /No backup freshness configuration/,
    );
    db.close();
  });

  it('keeps the configured weekly TM Backup healthy at 45h but alerts after two missed cycles', () => {
    const backups = loadBackupDefinitions();
    assert.equal(backups['TM Backup'].expectedIntervalHours, 168);

    checkBackupStaleness(db, 'TM Backup', new Date(Date.now() - 45 * 3600000).toISOString(), backups);
    assert.strictEqual(getActiveAlerts(db).length, 0);

    checkBackupStaleness(db, 'TM Backup', new Date(Date.now() - 337 * 3600000).toISOString(), backups);
    const alerts = getActiveAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.match(alerts[0].detail, /2× expected interval/);
    db.close();
  });
});

describe('createAlert / resolveAlert (module-level)', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('creates and resolves alerts', () => {
    createAlert(db, 'control-node', 'anomaly', 'critical', 'High temp', 'cpu_temp=80');
    assert.strictEqual(getActiveAlerts(db).length, 1);

    resolveAlert(db, 'control-node', 'High temp');
    assert.strictEqual(getActiveAlerts(db).length, 0);
    db.close();
  });
});
