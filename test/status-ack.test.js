'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDatabase, createAlert, acknowledgeAlert, getActiveAlerts, getUnacknowledgedAlerts, insertMetric } = require('../src/db');
const { computeOverallStatus } = require('../src/status');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-status-ack-'));
  return openDatabase(path.join(dir, 'test.db'));
}

// Design choice: dismissing an alert hides it from the Alerts tab + nav badge
// (getUnacknowledgedAlerts), but the overall-status banner reflects ALL active
// alerts (getActiveAlerts) — ack means "I've seen it", not "it's fine".
describe('acknowledgement vs overall status', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('a critical alert degrades status while active', () => {
    createAlert(db, 'h', 'engine', 'critical', 'Boom', 'detail');
    const { state, reasons } = computeOverallStatus(db);
    assert.equal(state, 'degraded');
    assert.ok(reasons.some((r) => r.includes('critical alert')));
  });

  it('acknowledging hides the alert from the tab/badge but NOT from overall status', () => {
    const id = createAlert(db, 'h', 'engine', 'critical', 'Boom', 'detail');
    acknowledgeAlert(db, id);
    // Hidden from the user-facing list (Alerts tab + badge)...
    assert.equal(getUnacknowledgedAlerts(db).length, 0);
    // ...but still active and still degrading overall status (true-health signal).
    assert.equal(getActiveAlerts(db).length, 1);
    assert.equal(computeOverallStatus(db).state, 'degraded');
  });

  it('a warning alert still raises a warning reason after acknowledgement', () => {
    const id = createAlert(db, 'h', 'engine', 'warning', 'Drift', 'detail');
    acknowledgeAlert(db, id);
    const { reasons } = computeOverallStatus(db);
    assert.ok(reasons.some((r) => r.includes('warning alert')), 'warning-alert reason persists after ack');
  });

  it('does not treat absent collector health evidence as healthy', () => {
    const result = computeOverallStatus(db);
    assert.notEqual(result.state, 'healthy');
  });

  it('rejects collector health assembled from different cycles', () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const current = new Date().toISOString();
    insertMetric(db, old, 'control-node', 'collector_success', 1, 'boolean', null);
    insertMetric(db, old, 'control-node', 'collector_last_run', Math.floor(Date.now() / 1000) - 60, 'epoch', null);
    // A sibling/current run marker cannot borrow an older success flag.
    insertMetric(db, current, 'control-node', 'collector_last_run', Math.floor(Date.now() / 1000), 'epoch', null);
    const result = computeOverallStatus(db);
    assert.ok(result.reasons.some((r) => r.includes('Collector health evidence incomplete')));
  });

  it('rejects future collector run evidence', () => {
    const current = new Date().toISOString();
    insertMetric(db, current, 'control-node', 'collector_success', 1, 'boolean', null);
    insertMetric(db, current, 'control-node', 'collector_last_run', Math.floor(Date.now() / 1000) + 60, 'epoch', null);
    const result = computeOverallStatus(db);
    assert.notEqual(result.state, 'healthy');
    assert.ok(result.reasons.some((r) => r.includes('Collector run evidence invalid')));
  });
});
