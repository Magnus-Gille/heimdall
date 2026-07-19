'use strict';

/**
 * consolidation.js — the /consolidation page, rendered through the v2 shell (pageShell).
 * Consolidation-specific styling lives in /css/consolidation.css.
 * The status card refreshes via HTMX. The activity chart is initialized by charts-client.js.
 * The coverage table is server-side rendered with data from fetchConsolidationDetail().
 */

const { pageShell } = require('./shell');
const { esc, formatAge } = require('./util');

function consolidationCssLink(gitVersion) {
  return `  <link rel="stylesheet" href="/css/consolidation.css?v=${esc(gitVersion || 'dev')}">`;
}

const QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const ATTENTION_LIMIT = 20;

function coverageView(coverage, backlog, nowMs) {
  const byNamespace = new Map();
  for (const row of coverage) {
    if (!row || !row.namespace) continue;
    byNamespace.set(row.namespace, { ...row });
  }
  for (const item of backlog) {
    if (!item || !item.namespace) continue;
    const existing = byNamespace.get(item.namespace) || {
      namespace: item.namespace,
      lastConsolidated: null,
    };
    existing.backlog = item.count;
    byNamespace.set(item.namespace, existing);
  }

  const rows = [...byNamespace.values()].map(row => {
    const parsed = row.lastConsolidated ? Date.parse(row.lastConsolidated) : NaN;
    const never = !Number.isFinite(parsed);
    const quiet = !never && nowMs - parsed > QUIET_AFTER_MS;
    const backlogCount = Number(row.backlog);
    const backlogValue = Number.isFinite(backlogCount) && backlogCount >= 0
      ? Math.trunc(backlogCount)
      : null;
    const backlogged = backlogValue != null && backlogValue > 0;
    const priority = backlogged ? 0 : (never ? 1 : (quiet ? 3 : 2));
    return { ...row, backlog: backlogValue, never, quiet, backlogged, priority };
  }).sort((a, b) => a.priority - b.priority
    || (b.backlog || 0) - (a.backlog || 0)
    || String(a.lastConsolidated || '').localeCompare(String(b.lastConsolidated || ''))
    || String(a.namespace).localeCompare(String(b.namespace)));

  return {
    rows,
    attention: rows.filter(row => row.backlogged || row.never),
    counts: {
      backlogged: rows.filter(row => row.backlogged).length,
      quiet: rows.filter(row => row.quiet).length,
      never: rows.filter(row => row.never).length,
      recent: rows.filter(row => !row.never && !row.quiet).length,
    },
  };
}

function coverageRows(rows, nowMs) {
  if (rows.length === 0) {
    return '<tr><td colspan="4" style="color:var(--text-muted)">No synthesis entries found</td></tr>';
  }
  return rows.map(row => {
    const state = row.backlogged ? 'Backlog' : (row.never ? 'Never' : (row.quiet ? 'Quiet' : 'Current'));
    const stateClass = row.backlogged || row.never ? 'is-warn' : (row.quiet ? 'is-stale' : 'is-ok');
    const backlog = row.backlog == null
      ? '<span class="is-stale">—</span>'
      : `<span class="${row.backlog > 0 ? 'is-warn' : 'is-ok'}">${esc(String(row.backlog))}</span>`;
    return `<tr>
      <td>${esc(row.namespace)}</td>
      <td>${esc(formatAge(row.lastConsolidated, nowMs))}</td>
      <td><span class="consol-state ${stateClass}">${state}</span></td>
      <td class="consol-backlog-cell">${backlog}</td>
    </tr>`;
  }).join('');
}

function coverageTable(rows, nowMs, className = '') {
  return `<table class="consol-coverage-table${className ? ` ${className}` : ''}">
    <thead><tr><th>Namespace</th><th>Last consolidated</th><th>Status</th><th>Backlog</th></tr></thead>
    <tbody>${coverageRows(rows, nowMs)}</tbody>
  </table>`;
}

function consolidationPage(gitVersion, detail, nowMs = Date.now()) {
  const { coverage = [], backlog = [] } = detail || {};
  const view = coverageView(coverage, backlog, nowMs);
  const visibleAttention = view.attention.slice(0, ATTENTION_LIMIT);

  const backlogNote = backlog.length > 0
    ? `<p class="consol-backlog-note"><span class="is-warn">⚠</span> ${esc(String(backlog.length))} namespace${backlog.length !== 1 ? 's' : ''} with a consolidation backlog.</p>`
    : '';
  const summary = `<div class="consol-summary">
    <span class="${view.counts.backlogged ? 'is-warn' : 'is-ok'}"><strong>${view.counts.backlogged}</strong> backlogged</span>
    <span class="is-stale"><strong>${view.counts.quiet}</strong> quiet 14d+</span>
    <span class="${view.counts.never ? 'is-warn' : 'is-ok'}"><strong>${view.counts.never}</strong> never synthesized</span>
    <span class="is-ok"><strong>${view.counts.recent}</strong> recently synthesized</span>
  </div>`;
  const attention = view.attention.length > 0
    ? `<div class="consol-attention"><h4>Needs attention</h4>${coverageTable(visibleAttention, nowMs, 'consol-attention-table')}` +
      (view.attention.length > ATTENTION_LIMIT
        ? `<p class="consol-table-note">Showing the top ${ATTENTION_LIMIT} of ${view.attention.length} actionable namespaces.</p>`
        : '') + '</div>'
    : '<p class="consol-clear is-ok">No namespace backlog needs attention.</p>';
  const allRows = view.rows.length > 0
    ? `<details class="consol-all"><summary>All ${view.rows.length} namespaces</summary>${coverageTable(view.rows, nowMs)}</details>`
    : coverageTable([], nowMs);

  const content = `
    <div class="consolidation-page">
      <div class="page-head">
        <a href="/services/munin-memory" class="page-sub">← Munin Memory</a>
      </div>
      <div class="proj-page-header">
        <h1>Consolidation</h1>
        <p class="proj-page-sub">Synthesis worker status, activity, and namespace coverage.</p>
      </div>
      <main class="grid">
        <div class="card col-full" hx-get="/api/card/consolidation-status" hx-trigger="load, every 30s" hx-swap="innerHTML">
          <div class="loading">Loading consolidation status...</div>
        </div>
        <div class="card col-full">
          <h3>Synthesis Activity (30d)</h3>
          <div class="consol-chart-wrap">
            <canvas id="consolidation-chart" width="900" height="300"></canvas>
          </div>
        </div>
        <div class="card col-full">
          <h3>Namespace Coverage</h3>
          ${summary}
          ${backlogNote}
          ${attention}
          ${allRows}
        </div>
      </main>
    </div>`;

  return pageShell({
    title: 'Heimdall — Munin Memory · Consolidation',
    active: '/services',
    gitVersion,
    content,
    head: consolidationCssLink(gitVersion),
    charts: true,
    lastUpdated: true,
  });
}

module.exports = { consolidationPage, coverageView };
