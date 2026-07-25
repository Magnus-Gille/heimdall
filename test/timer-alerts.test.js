'use strict';

/**
 * Regression test for defect 3: "a real failure is silent while false ones are loud".
 *
 * `service_snapshots` carried brokkr-maintenance-os with status "fail" and
 * timer.lastResult "exit 1" since 2026-07-25T05:02 and there was NO alert for it,
 * because the alert engine only evaluates `descriptor.alerts.rules` /
 * `descriptor.metrics[].warn|crit` — a config-only timer descriptor has neither.
 *
 * The counterpart requirement (see timer-outcome.test.js): a job that ran and
 * reported findings must NOT raise a failure alert.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, getActiveAlerts } = require('../src/db');
const { evaluateTimerAlerts } = require('../src/timer-alerts');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-timer-alerts-'));
  return openDatabase(path.join(dir, 'test.db'));
}

const active = (db) => getActiveAlerts(db);

describe('evaluateTimerAlerts', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('raises an alert for a timer that could not complete', () => {
    evaluateTimerAlerts(db, [{
      service: 'brokkr-maintenance-os', host: 'control-node', type: 'timer',
      timer_status: { lastRun: '2026-07-25T05:02:28Z', lastResult: 'exit 1', exitOk: false, nextRun: '2026-07-26T05:00:00Z' },
    }]);
    const a = active(db);
    assert.strictEqual(a.length, 1, 'a failing timer must reach the owner');
    assert.match(a[0].title, /brokkr-maintenance-os/);
    assert.match(a[0].detail, /exit 1/);
    assert.strictEqual(a[0].category, 'timer');
  });

  it('does NOT raise a failure alert for a job that ran and reported findings', () => {
    evaluateTimerAlerts(db, [{
      service: 'grimnir-validate', host: 'control-node', type: 'timer',
      findings_exit_codes: [1],
      timer_status: { lastRun: '2026-07-25T04:31:00Z', lastResult: 'exit 1', exitOk: false, nextRun: '2026-07-26T04:30:00Z' },
    }]);
    assert.deepStrictEqual(active(db).map((x) => x.title), []);
  });

  it('reports findings as a first-class result rather than swallowing them', () => {
    const out = evaluateTimerAlerts(db, [{
      service: 'grimnir-validate', host: 'control-node', type: 'timer',
      findings_exit_codes: [1],
      timer_status: { lastRun: '2026-07-25T04:31:00Z', lastResult: 'exit 1', exitOk: false, findings: 2 },
    }]);
    assert.strictEqual(out.findings.length, 1);
    assert.strictEqual(out.findings[0].service, 'grimnir-validate');
    assert.strictEqual(out.findings[0].count, 2);
  });

  it('resolves the alert once the timer runs clean again', () => {
    const failing = {
      service: 'brokkr-maintenance-os', host: 'control-node', type: 'timer',
      timer_status: { lastRun: '2026-07-25T05:02:28Z', lastResult: 'exit 1', exitOk: false },
    };
    evaluateTimerAlerts(db, [failing]);
    assert.strictEqual(active(db).length, 1);
    evaluateTimerAlerts(db, [{
      ...failing,
      timer_status: { lastRun: '2026-07-26T05:02:28Z', lastResult: 'ok', exitOk: true },
    }]);
    assert.deepStrictEqual(active(db).map((x) => x.title), []);
  });

  it('stays silent for healthy and never-run timers', () => {
    evaluateTimerAlerts(db, [
      { service: 'heimdall-collect', host: 'control-node', type: 'timer', timer_status: { lastRun: '2026-07-25T17:55:00Z', lastResult: 'ok', exitOk: true } },
      { service: 'skuld', host: 'control-node', type: 'timer', timer_status: null },
    ]);
    assert.deepStrictEqual(active(db).map((x) => x.title), []);
  });

  it('ignores non-timer services', () => {
    evaluateTimerAlerts(db, [{ service: 'hugin', host: 'control-node', deployed_commit: 'abc1234' }]);
    assert.deepStrictEqual(active(db).map((x) => x.title), []);
  });
});
