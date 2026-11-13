'use strict';

/**
 * code-health-alerts.js — warn when a repository's objective code-health
 * evidence goes stale.
 *
 * For 30 days every artifact from a registered repository was rejected while
 * the source status read only "incomplete", and nothing alarmed. This fires one
 * warning per repository when the newest admitted run is older than that
 * repository's shortest registered slot freshness cap, and clears it once a
 * fresher run is admitted.
 *
 * What alerts here, and what deliberately does not:
 *   - a known last admission older than the cap → warning (never critical, so
 *     no push notification; mirrors deploy-drift alerts).
 *   - no admission on record at all → no alert. Age is not determinable and is
 *     not guessed; it is returned to the caller as `unknown`.
 *   - objective source disabled or unconfigured → no alert, any prior one clears.
 */

const { createAlert, resolveAlert } = require('./db');
const { REPOSITORIES, EXPECTED_SLOTS } = require('./code-health/registry');
const { lastAdmittedRunAt } = require('./code-health/store');

const CATEGORY = 'code-health';
const HOST = 'control-node';

function titleFor(repoName) {
  return `Code health evidence stale: ${repoName}`;
}

/** Shortest registered freshness cap for the repository's slots, in ms. */
function freshnessCapMs(repoName) {
  const caps = (EXPECTED_SLOTS.get(repoName)?.slots || [])
    .map((slot) => slot.freshness_ms)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return caps.length ? Math.min(...caps) : null;
}

function formatHours(ms) {
  const hours = ms / 3600000;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/**
 * @param {object} db
 * @param {object} opts { enabled, configured, now, createAlert, resolveAlert }
 * @returns {{stale: object[], fresh: string[], unknown: string[]}}
 */
function evaluateCodeHealthStalenessAlerts(db, opts = {}) {
  const now = opts.now || Date.now();
  const create = opts.createAlert || createAlert;
  const resolve = opts.resolveAlert || resolveAlert;
  const active = opts.enabled === true && opts.configured === true;
  const out = { stale: [], fresh: [], unknown: [] };

  for (const source of REPOSITORIES) {
    const title = titleFor(source.name);
    const cap = freshnessCapMs(source.name);
    const last = active && cap ? lastAdmittedRunAt(db, source.owner, source.name) : null;
    const lastMs = last ? Date.parse(last) : NaN;
    if (!active || !cap) {
      resolve(db, HOST, title);
      continue;
    }
    if (!Number.isFinite(lastMs)) {
      resolve(db, HOST, title);
      out.unknown.push(source.name);
      continue;
    }
    const age = now - lastMs;
    if (age > cap) {
      create(db, HOST, CATEGORY, 'warning', title,
        `${source.owner}/${source.name}: newest admitted run was created ${last}, `
        + `${formatHours(age)} ago; freshness cap ${formatHours(cap)}. Check the code-health collection status.`);
      out.stale.push({ repository: source.name, lastAdmittedRunAt: last, ageMs: age, capMs: cap });
    } else {
      resolve(db, HOST, title);
      out.fresh.push(source.name);
    }
  }
  return out;
}

module.exports = { evaluateCodeHealthStalenessAlerts, freshnessCapMs, titleFor, CATEGORY };
