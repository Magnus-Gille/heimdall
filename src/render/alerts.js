'use strict';

/**
 * alerts.js — the dedicated Alerts page (`/alerts`) and its self-refreshing list
 * fragment. Alerts used to live in a sticky strip pinned to the top of every page,
 * which a busy estate (8+ deploy-drift warnings) turned into a full-screen wall.
 * They now live on their own tab; the nav badge carries the at-a-glance count.
 *
 * The list reuses the proven `activeAlertsStrip` renderer verbatim — each row keeps
 * its dismiss (×) control. Dismiss ACKNOWLEDGES (does not resolve), so a re-firing
 * condition stays hidden; see db.getUnacknowledgedAlerts for the lifecycle.
 */

const { pageShell } = require('./shell');
const { activeAlertsStrip, emptyState } = require('./components');

// Map the db severity vocabulary onto the three badge classes. Mirrors
// components.ALERT_SEV_MAP so the badge colour agrees with the strip rows.
const BADGE_SEV = {
  critical: 'crit', crit: 'crit', error: 'crit', fail: 'crit',
  warning: 'warn', warn: 'warn', degraded: 'warn',
  info: 'info', notice: 'info',
};

/**
 * The nav count badge fragment. Empty when nothing is pending (the `<span>` mount
 * collapses), otherwise a pill coloured by the MOST SEVERE pending alert
 * (crit > warn > info) — an info-only set stays neutral, it doesn't read as a warning.
 */
function alertsCountBadge(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length;
  if (!n) return '';
  let sev = 'info';
  for (const r of list) {
    const s = BADGE_SEV[String((r && r.severity) || '').toLowerCase()] || 'info';
    if (s === 'crit') { sev = 'crit'; break; }
    if (s === 'warn') sev = 'warn';
  }
  return `<span class="nav-badge ${sev}">${n}</span>`;
}

/** The alerts list (self-refreshing fragment): the full strip, or an all-clear note. */
function alertsListFragment(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return `<div class="card col-full">${emptyState('No active alerts — all clear.', '✓')}</div>`;
  }
  return activeAlertsStrip(list);
}

/** Full Alerts page. `rows` are unacknowledged alert rows (db schema). */
function alertsPage(gitVersion, rows = []) {
  const content = `
    <div class="page-head">
      <h1 class="page-title">Alerts</h1>
      <p class="page-sub">Active warnings and incidents. Dismiss (×) to acknowledge — it stays hidden until the condition clears and recurs.</p>
    </div>

    <div hx-get="/api/alerts/list" hx-trigger="every 30s" hx-swap="innerHTML">
      ${alertsListFragment(rows)}
    </div>`;

  return pageShell({
    title: 'Heimdall — Alerts',
    active: '/alerts',
    gitVersion,
    content,
  });
}

module.exports = { alertsPage, alertsListFragment, alertsCountBadge };
