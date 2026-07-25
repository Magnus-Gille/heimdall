'use strict';

/**
 * drift-compare.js — the ONE honest answer to "is what's running behind main?".
 *
 * The previous implementation collapsed every non-equal comparison to the magic
 * number `-1` ("behind, count unknown") and stored it in
 * `service_versions.commits_behind`. That produced three separate lies:
 *
 *   - a NEGATIVE commit count, which no reader can interpret;
 *   - "drift" for services where drift is not measurable at all (munin-memory's
 *     /health returns no commit and its deploy path has no .git, so the compared
 *     "deployed version" was the literal string `ok`);
 *   - "drift" for a deployed revision that is actually AHEAD of origin/main.
 *
 * Here the comparison returns an explicit state and a count that is either null
 * (nothing was counted) or a non-negative integer. Callers must gate alerting on
 * the STATE, never on the number — `unknown` is an instrumentation failure and
 * must stay quiet.
 *
 *   'up-to-date' — deployed === origin/main
 *   'drift'      — deployed is a commit, differs from origin/main, and is behind
 *                  (or the count could not be established but the difference is real)
 *   'ahead'      — deployed contains commits origin/main does not; not "behind"
 *   'unknown'    — the comparison is not possible; `reason` says why
 */

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Is this string a git object id we can meaningfully compare? */
function isCommitish(v) {
  return typeof v === 'string' && SHA_RE.test(v.trim());
}

function prefixEqual(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

function unknown(reason) {
  return { state: 'unknown', commitsBehind: null, commitsAhead: null, reason };
}

/**
 * Compare a deployed revision against origin/main.
 *
 * @param {string|null} deployed  the commit actually running (or a non-commit
 *                                version string, or null when none was collected)
 * @param {string|null} latest    origin/main's commit, or null if unresolved
 * @param {object} [deps]
 * @param {function} [deps.count] () => { behind: number, ahead: number } | null
 *        Optional ancestry probe (git rev-list --left-right --count). Returning
 *        null, or throwing, means "cannot count" — the difference is still real.
 * @returns {{state: string, commitsBehind: number|null, commitsAhead: number|null, reason: string|null}}
 */
function compareCommits(deployed, latest, deps = {}) {
  const dep = typeof deployed === 'string' ? deployed.trim() : deployed;
  const lat = typeof latest === 'string' ? latest.trim() : latest;

  if (!dep) return unknown('no deployed commit was collected for this service');
  if (!lat) return unknown('origin/main could not be resolved');
  if (!isCommitish(dep)) {
    return unknown(`deployed version ${JSON.stringify(String(dep))} is not a commit — drift is not measurable here`);
  }
  if (!isCommitish(lat)) return unknown('origin/main did not resolve to a commit');

  if (prefixEqual(dep.toLowerCase(), lat.toLowerCase())) {
    return { state: 'up-to-date', commitsBehind: 0, commitsAhead: 0, reason: null };
  }

  // The two revisions genuinely differ. Try to establish the direction and size.
  let counted = null;
  if (typeof deps.count === 'function') {
    try { counted = deps.count(dep, lat); } catch { counted = null; }
  }

  const behind = counted && Number.isFinite(counted.behind) && counted.behind >= 0 ? counted.behind : null;
  const ahead = counted && Number.isFinite(counted.ahead) && counted.ahead >= 0 ? counted.ahead : null;

  if (behind === 0 && ahead != null && ahead > 0) {
    // Running MORE than origin/main (deployed from a branch, or main was rewound).
    // Calling this "behind" was the inverted-direction bug.
    return { state: 'ahead', commitsBehind: 0, commitsAhead: ahead, reason: null };
  }
  if (behind != null && behind > 0) {
    return { state: 'drift', commitsBehind: behind, commitsAhead: ahead, reason: null };
  }

  // Difference is real but uncounted (no local checkout / no ancestry probe).
  return {
    state: 'drift',
    commitsBehind: null,
    commitsAhead: null,
    reason: 'deployed commit differs from origin/main; commit count unavailable',
  };
}

/**
 * Derive the drift state of a PERSISTED `service_versions` row.
 *
 * Rows written before this change carry `commits_behind = -1`. That sentinel is
 * not evidence of drift — it only ever meant "these two values are not equal",
 * including when one of them was never a commit. Legacy rows therefore read as
 * `unknown` and can never resurrect a false drift alert.
 */
function driftStateFromRow(row) {
  if (!row) return 'unknown';
  const persisted = row.drift_state;
  if (typeof persisted === 'string' && persisted) return persisted;

  const behind = row.commits_behind;
  if (behind != null && Number.isFinite(Number(behind)) && Number(behind) < 0) return 'unknown';

  return compareCommits(row.deployed_commit, row.latest_commit).state;
}

module.exports = { compareCommits, driftStateFromRow, isCommitish };
