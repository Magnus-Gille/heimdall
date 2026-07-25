'use strict';

/**
 * timer-outcome.js — what a systemd timer's last run actually MEANS.
 *
 * A two-state pass/fail model is wrong for scheduled jobs, and it broke both
 * directions at once on the live instance:
 *
 *   - `brokkr-maintenance-os` exited 1 because the job could not complete. That
 *     is a real failure, and nothing alerted on it.
 *   - `grimnir-validate` also exits 1 — but it ran perfectly and is telling you
 *     it found 2 issues. Rendering that as a crashed service is precisely why
 *     nobody reads the audit.
 *
 * So the outcome vocabulary has three meaningful results plus two "no result"
 * cases:
 *
 *   'ok'        — ran to completion, nothing to report
 *   'findings'  — ran to completion and reported findings. ACTIONABLE, but the
 *                 service is not broken: it is a finding count, not a red card.
 *   'failed'    — did not complete. The genuinely alarming one.
 *   'overdue'   — systemd has not fired it well past its next scheduled run
 *   'never-run' — no run recorded yet (do NOT infer "pass" from systemd's
 *                 ExecMainStatus, which defaults to 0)
 *
 * How we tell 'findings' from 'failed':
 *   1. a producer-declared `outcome` on the run record always wins. This is the
 *      end state: a job reports its own result and the exit code stops mattering.
 *   2. otherwise, a service may DECLARE which exit codes mean "findings" via
 *      `findings_exit_codes` in the service config, for jobs whose exit contract
 *      still overloads the status byte.
 *   3. otherwise a non-zero exit is a failure — the safe default, because that is
 *      the case that must never be silent.
 */

// How far past `nextRun` a timer may drift before we call it overdue. Generous
// so a job that merely runs late does not flap.
const OVERDUE_GRACE_MS = 60 * 60 * 1000;

const OUTCOMES = ['ok', 'findings', 'failed', 'overdue', 'never-run'];

/**
 * Parse systemd's last-result string to a numeric exit code.
 * 'ok' → 0, 'exit 1' → 1, anything else → null (unknown).
 */
function parseExitCode(lastResult) {
  if (typeof lastResult !== 'string') return null;
  const s = lastResult.trim();
  if (s === 'ok') return 0;
  const m = /^exit\s+(\d+)$/i.exec(s);
  return m ? Number(m[1]) : null;
}

function declaredFindingsCodes(svc) {
  const raw = svc && svc.findings_exit_codes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n) => Number.isInteger(n) && n >= 0);
}

function findingsCount(run) {
  const n = run && run.findings;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param {object|null} run  { lastRun, lastResult, exitOk, nextRun, outcome?, findings? }
 * @param {object} svc       the service config entry (may declare findings_exit_codes)
 * @param {number} now       epoch ms
 * @returns {{outcome: string, exitCode: number|null, findings: number|null, lastRun: string|null, lastResult: string|null}}
 */
function deriveTimerOutcome(run, svc = {}, now = Date.now()) {
  const base = {
    exitCode: parseExitCode(run && run.lastResult),
    findings: findingsCount(run),
    lastRun: (run && run.lastRun) || null,
    lastResult: (run && run.lastResult) || null,
  };

  if (!run || !run.lastRun) return { ...base, outcome: 'never-run' };

  // 1. The producer told us what happened. Believe it.
  if (typeof run.outcome === 'string' && OUTCOMES.includes(run.outcome)) {
    return { ...base, outcome: run.outcome };
  }

  const exitCode = base.exitCode;
  const nonZero = run.exitOk === false || (exitCode != null && exitCode !== 0);

  if (nonZero) {
    // 2. Declared findings contract for jobs that still overload the exit byte.
    if (exitCode != null && declaredFindingsCodes(svc).includes(exitCode)) {
      return { ...base, outcome: 'findings' };
    }
    // 3. Otherwise: the job did not complete. This is the one that must be loud.
    return { ...base, outcome: 'failed' };
  }

  if (run.nextRun) {
    const overdueBy = now - Date.parse(run.nextRun);
    if (Number.isFinite(overdueBy) && overdueBy > OVERDUE_GRACE_MS) {
      return { ...base, outcome: 'overdue' };
    }
  }

  if (run.exitOk === true || exitCode === 0) return { ...base, outcome: 'ok' };

  // Ran, on schedule, but the exit outcome is genuinely unknown — do not invent
  // a pass or a warn.
  return { ...base, outcome: 'never-run' };
}

/**
 * Map an outcome onto the service-contract status vocabulary (pass|warn|fail).
 *
 * 'findings' maps to PASS on purpose: the job succeeded. The findings themselves
 * are surfaced as a finding count in their own right (see render/service-page.js
 * and the Overview's Findings line) rather than as service degradation.
 */
function outcomeToStatus(outcome) {
  switch (outcome) {
    case 'ok': return 'pass';
    case 'findings': return 'pass';
    case 'overdue': return 'warn';
    case 'failed': return 'fail';
    default: return null;
  }
}

module.exports = {
  deriveTimerOutcome, outcomeToStatus, parseExitCode, OUTCOMES, OVERDUE_GRACE_MS,
};
