'use strict';

/**
 * timer-alerts.js — surface scheduled jobs that could not run.
 *
 * `discovery.js` already derived a timer's status into `service_snapshots`, but
 * nothing ever turned it into an alert: the alert engine only evaluates
 * `descriptor.alerts.rules` and `descriptor.metrics[].warn|crit`, and a
 * config-only timer descriptor has neither. So brokkr-maintenance-os sat at
 * status "fail" / lastResult "exit 1" with no alert at all, while six false
 * deploy-drift warnings were shouting.
 *
 * What alerts here, and what deliberately does not:
 *   - 'failed'   → alert. The job did not complete; only the owner can fix it.
 *   - 'overdue'  → alert. systemd is not firing it; the job is silently not happening.
 *   - 'findings' → NO alert. The job ran fine and has findings to report. Those
 *                  are returned to the caller so they can be rendered as a
 *                  finding count, which is what makes them get read.
 *   - 'ok' / 'never-run' → nothing.
 */

const { createAlert, resolveAlert } = require('./db');
const { deriveTimerOutcome } = require('./timer-outcome');

const CATEGORY = 'timer';

function titleFor(service) {
  return `Scheduled job failing: ${service}`;
}

function detailFor(service, o) {
  const bits = [];
  if (o.outcome === 'overdue') {
    bits.push(`${service} has not been fired by systemd since its scheduled run.`);
  } else {
    bits.push(`${service} did not complete (${o.lastResult || 'non-zero exit'}).`);
  }
  if (o.lastRun) bits.push(`Last run ${o.lastRun}.`);
  return bits.join(' ');
}

/**
 * @param {object} db
 * @param {object[]} driftResults  rows from collectServiceDrift (carry timer_status)
 * @param {object} [deps] { now, createAlert, resolveAlert }
 * @returns {{failed: object[], findings: object[], ok: string[]}}
 */
function evaluateTimerAlerts(db, driftResults, deps = {}) {
  const now = deps.now || Date.now();
  const create = deps.createAlert || createAlert;
  const resolve = deps.resolveAlert || resolveAlert;

  const out = { failed: [], findings: [], ok: [] };

  for (const r of driftResults || []) {
    if (!r || r.type !== 'timer') continue;
    const host = r.host || 'control-node';
    const title = titleFor(r.service);
    const o = deriveTimerOutcome(r.timer_status, r, now);

    if (o.outcome === 'failed' || o.outcome === 'overdue') {
      create(db, host, CATEGORY, 'warning', title, detailFor(r.service, o));
      out.failed.push({ service: r.service, host, outcome: o.outcome, exitCode: o.exitCode });
      continue;
    }

    // Not failing → make sure any previous failure alert is cleared.
    resolve(db, host, title);

    if (o.outcome === 'findings') {
      out.findings.push({ service: r.service, host, count: o.findings, lastRun: o.lastRun });
    } else if (o.outcome === 'ok') {
      out.ok.push(r.service);
    }
  }

  return out;
}

module.exports = { evaluateTimerAlerts, titleFor, CATEGORY };
