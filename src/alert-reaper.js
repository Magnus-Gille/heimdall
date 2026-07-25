'use strict';

/**
 * alert-reaper.js — close alerts nothing can ever resolve.
 *
 * Auto-resolve works well in general (894 of 903 alerts on the live instance are
 * resolved). The failure mode is narrower and nastier: when the SERIES an alert
 * was raised from disappears, the evaluator that would resolve it never runs
 * again, so the alert fires forever.
 *
 * Two live examples, both unresolvable by construction:
 *   - "mem_used_pct % threshold on huginmunin" (open since 2026-07-23T05:05).
 *     `checkThresholds` is only ever called with a host that just reported, and
 *     the host identity `huginmunin` stopped reporting at 2026-07-23T08:58 — the
 *     same machine reports as `control-node` now.
 *   - "disk_used_pct_nas % threshold on nas" (open since 2026-07-02). The NAS SSH
 *     probe stopped delivering that metric on 2026-07-22; `checkThresholds`
 *     skipped absent metrics with `continue`, so the resolve branch was dead code.
 *
 * Rather than enumerate every evidence source, the reaper uses the one property
 * they all share: a live alert is RE-ASSERTED every cycle. `createAlert` stamps
 * `last_observed_at` on both insert and refresh, so an active alert nobody has
 * re-asserted within the staleness window is, by definition, no longer being
 * measured. It is closed as "stale — no data" and an audit event is logged, so
 * the close is never mistaken for a recovery.
 */

const { logEvent } = require('./events');
const { canonicalHost } = require('./host-identity');

// Generous by design: hours, not minutes. The collector runs every 5 minutes, so
// this tolerates a long outage of a single evaluator without eating live alerts.
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

const STALE_NOTE = 'stale — no data';

/**
 * Resolve active alerts whose condition has not been re-asserted recently.
 *
 * @param {object} db
 * @param {object} [opts] { now, maxAgeMs, log }
 * @returns {{resolved: Array<{id:number,host:string,title:string,lastObservedAt:string|null}>}}
 */
function reapStaleAlerts(db, opts = {}) {
  const now = opts.now || Date.now();
  const envHours = Number(process.env.HEIMDALL_ALERT_STALE_HOURS);
  const maxAgeMs = Number.isFinite(opts.maxAgeMs)
    ? opts.maxAgeMs
    : (Number.isFinite(envHours) && envHours > 0 ? envHours * 3600_000 : DEFAULT_STALE_MS);
  const cutoff = now - maxAgeMs;
  const nowIso = new Date(now).toISOString();

  // A legacy row predating the last_observed_at column has never been re-stamped;
  // its creation time is the only observation we can prove.
  const rows = db.prepare(`
    SELECT id, host, title, detail, category,
           COALESCE(last_observed_at, created_at) AS observed_at
    FROM alerts
    WHERE resolved_at IS NULL
  `).all();

  const resolved = [];
  for (const row of rows) {
    const observedMs = Date.parse(row.observed_at);
    if (!Number.isFinite(observedMs) || observedMs > cutoff) continue;

    const ageH = Math.round((now - observedMs) / 3600000);
    const note = `Auto-closed: ${STALE_NOTE}. Nothing re-asserted this condition for ~${ageH}h`
      + ` (last observed ${row.observed_at}); its host or metric stopped reporting,`
      + ' so it could not be evaluated any more.';
    const detail = row.detail ? `${row.detail}\n${note}` : note;

    db.prepare('UPDATE alerts SET resolved_at = ?, detail = ? WHERE id = ? AND resolved_at IS NULL')
      .run(nowIso, detail, row.id);

    resolved.push({ id: row.id, host: row.host, title: row.title, lastObservedAt: row.observed_at });

    try {
      logEvent(db, row.host, 'alert', 'info',
        `Alert auto-closed as stale: ${row.title}`,
        `No observation for ~${ageH}h (last ${row.observed_at}).`, 'alert-reaper');
    } catch { /* auditing must never break the reap */ }
  }

  return { resolved };
}

/**
 * Rewrite active alerts from a retired host identity onto the canonical one.
 *
 * Canonicalizing the registry host (huginmunin → control-node) fixes the split
 * going FORWARD, but it strands every alert already open under the old name:
 * the evaluator now resolves `(control-node, title)` and never matches the
 * `(huginmunin, title)` row sitting in the table. Those rows would linger until
 * the staleness window expired.
 *
 * Merging is dedup-aware: if the canonical host already has an active alert with
 * the same title, the stale duplicate is resolved rather than creating two rows
 * that both claim to be the live one.
 *
 * Runs before the evaluators each cycle. Idempotent.
 *
 * @returns {{migrated: number, merged: number}}
 */
function reconcileAlertHosts(db, aliases, opts = {}) {
  if (!aliases || !Object.keys(aliases).length) return { migrated: 0, merged: 0 };
  const nowIso = new Date(opts.now || Date.now()).toISOString();
  const rows = db.prepare('SELECT id, host, title FROM alerts WHERE resolved_at IS NULL').all();

  let migrated = 0;
  let merged = 0;
  for (const row of rows) {
    const canonical = canonicalHost(row.host, aliases);
    if (!canonical || canonical === row.host) continue;

    const existing = db.prepare(
      'SELECT id FROM alerts WHERE host = ? AND title = ? AND resolved_at IS NULL AND id <> ?'
    ).get(canonical, row.title, row.id);

    if (existing) {
      db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?').run(nowIso, row.id);
      merged += 1;
    } else {
      db.prepare('UPDATE alerts SET host = ? WHERE id = ?').run(canonical, row.id);
      migrated += 1;
    }
  }
  return { migrated, merged };
}

module.exports = { reapStaleAlerts, reconcileAlertHosts, DEFAULT_STALE_MS, STALE_NOTE };
