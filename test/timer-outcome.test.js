'use strict';

/**
 * Regression tests for systemd-timer outcome modelling.
 *
 * Two live defects meet here:
 *
 *  (a) `brokkr-maintenance-os` had `status: "fail"`, `timer.lastResult: "exit 1"`
 *      in `service_snapshots` and NO alert. A job that could not run must reach
 *      the owner.
 *
 *  (b) `grimnir-validate` also exits 1 — but it is not broken. Its audit RAN and
 *      found 2 issues; exit 1 is how it reports "findings". Rendering that as a
 *      red failed service is exactly why nobody reads it.
 *
 * A two-state pass/fail model cannot express both. The outcome vocabulary is:
 *   'ok'        — ran, clean
 *   'findings'  — ran to completion and reported findings (actionable, NOT broken)
 *   'failed'    — did not complete (the alarming one)
 *   'overdue'   — systemd has not fired it well past its next scheduled run
 *   'never-run' — no run recorded yet
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveTimerOutcome, outcomeToStatus, parseExitCode,
} = require('../src/timer-outcome');

const NOW = Date.parse('2026-07-25T18:00:00Z');
const ran = (extra = {}) => ({ lastRun: '2026-07-25T05:02:28Z', lastResult: 'ok', exitOk: true, nextRun: '2026-07-26T05:00:00Z', ...extra });

describe('parseExitCode', () => {
  it('extracts the numeric code from systemd\'s "exit N" string', () => {
    assert.strictEqual(parseExitCode('exit 1'), 1);
    assert.strictEqual(parseExitCode('exit 137'), 137);
  });
  it('treats "ok" as 0 and anything unparseable as null', () => {
    assert.strictEqual(parseExitCode('ok'), 0);
    assert.strictEqual(parseExitCode(null), null);
    assert.strictEqual(parseExitCode('signal'), null);
  });
});

describe('deriveTimerOutcome', () => {
  it('is never-run when there is no recorded run', () => {
    assert.strictEqual(deriveTimerOutcome(null, {}, NOW).outcome, 'never-run');
    assert.strictEqual(deriveTimerOutcome({ lastRun: null }, {}, NOW).outcome, 'never-run');
  });

  it('is ok for a clean run on schedule', () => {
    assert.strictEqual(deriveTimerOutcome(ran(), {}, NOW).outcome, 'ok');
  });

  it('is failed for a non-zero exit with no findings declaration (brokkr-maintenance-os)', () => {
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 1', exitOk: false }), {}, NOW);
    assert.strictEqual(r.outcome, 'failed');
    assert.strictEqual(r.exitCode, 1);
  });

  it('is findings — NOT failed — when the service declares that exit code as findings (grimnir-validate)', () => {
    const svc = { findings_exit_codes: [1] };
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 1', exitOk: false }), svc, NOW);
    assert.strictEqual(r.outcome, 'findings');
    assert.strictEqual(r.exitCode, 1);
  });

  it('still fails for an undeclared exit code even when findings codes are declared', () => {
    const svc = { findings_exit_codes: [1] };
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 2', exitOk: false }), svc, NOW);
    assert.strictEqual(r.outcome, 'failed');
  });

  it('carries a findings count when the run reports one', () => {
    const svc = { findings_exit_codes: [1] };
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 1', exitOk: false, findings: 2 }), svc, NOW);
    assert.strictEqual(r.outcome, 'findings');
    assert.strictEqual(r.findings, 2);
  });

  it('reports findings with a null count when the producer does not say how many', () => {
    const svc = { findings_exit_codes: [1] };
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 1', exitOk: false }), svc, NOW);
    assert.strictEqual(r.findings, null);
  });

  it('is overdue when systemd has not fired it well past the next scheduled run', () => {
    const r = deriveTimerOutcome(
      { lastRun: '2026-07-20T05:00:00Z', lastResult: 'ok', exitOk: true, nextRun: '2026-07-21T05:00:00Z' },
      {}, NOW,
    );
    assert.strictEqual(r.outcome, 'overdue');
  });

  it('prefers a real failure over overdue', () => {
    const r = deriveTimerOutcome(
      { lastRun: '2026-07-20T05:00:00Z', lastResult: 'exit 1', exitOk: false, nextRun: '2026-07-21T05:00:00Z' },
      {}, NOW,
    );
    assert.strictEqual(r.outcome, 'failed');
  });

  it('accepts a producer-declared outcome over the exit-code heuristic', () => {
    // Once a job reports through a real channel, the exit code stops being the
    // signal. `outcome: 'findings'` from the producer wins.
    const r = deriveTimerOutcome(ran({ lastResult: 'exit 0', outcome: 'findings', findings: 3 }), {}, NOW);
    assert.strictEqual(r.outcome, 'findings');
    assert.strictEqual(r.findings, 3);
  });
});

describe('outcomeToStatus', () => {
  it('maps a completed-with-findings run to pass, not fail', () => {
    // The JOB succeeded. Findings are information, not service degradation —
    // rendering them red is what made the audit unreadable.
    assert.strictEqual(outcomeToStatus('findings'), 'pass');
  });
  it('maps a run that could not complete to fail', () => {
    assert.strictEqual(outcomeToStatus('failed'), 'fail');
  });
  it('maps ok to pass and overdue to warn', () => {
    assert.strictEqual(outcomeToStatus('ok'), 'pass');
    assert.strictEqual(outcomeToStatus('overdue'), 'warn');
  });
  it('maps never-run to null (no outcome yet — not a false pass)', () => {
    assert.strictEqual(outcomeToStatus('never-run'), null);
  });
});
