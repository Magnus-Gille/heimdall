'use strict';

/**
 * tickets.js — the /tickets page: progress in the Plane ticket system.
 * Server-rendered; charts are inline SVG / CSS bars (no client JS, CSP-safe).
 * Receives only aggregates from src/plane.js, never ticket titles.
 * Project/cycle/module names are free text and always escaped.
 */

const { pageShell } = require('./shell');
const { esc, formatAge } = require('./util');
const { kpi, emptyState } = require('./components');
const { grid } = require('./cards');

const SEGMENTS = [
  ['completed', 'Done', 'seg-done'],
  ['started', 'In progress', 'seg-started'],
  ['unstarted', 'Todo', 'seg-unstarted'],
  ['backlog', 'Backlog', 'seg-backlog'],
  ['cancelled', 'Cancelled', 'seg-cancelled'],
  ['other', 'Other', 'seg-other'],
];

const fmtDate = (ms) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));

function legend() {
  return `<div class="tk-legend">${SEGMENTS.map(([, label, cls]) =>
    `<span><i class="tk-swatch ${cls}"></i>${esc(label)}</span>`).join('')}</div>`;
}

function stackedBar(project) {
  const total = project.total || 1;
  const segs = SEGMENTS.filter(([k]) => project.groups[k] > 0).map(([k, label, cls]) => {
    const n = project.groups[k];
    return `<span class="tk-seg ${cls}" style="width:${((n / total) * 100).toFixed(2)}%" title="${esc(label)}: ${n}"></span>`;
  }).join('');
  return `<div class="tk-bar" role="img" aria-label="${esc(project.identifier)}: ${project.groups.completed} of ${project.total} done">${segs}</div>`;
}

function projectsCard(projects) {
  if (!projects.length) return emptyState('No projects matched PLANE_PROJECTS.');
  const rows = projects.map((p) => `<tr>
      <th scope="row">${esc(p.identifier)}${p.truncated ? ' <span class="tk-note" title="Issue list hit the page ceiling; counts are a lower bound">≥</span>' : ''}</th>
      <td class="tk-barcell">${stackedBar(p)}</td>
      <td class="tk-num">${p.open} open</td>
      <td class="tk-num">${p.pct}% done</td>
    </tr>`).join('');
  return `${legend()}<table class="tk-table"><tbody>${rows}</tbody></table>`;
}

function progressRow(label, sub, pct, markerPct) {
  const marker = markerPct == null ? '' : `<span class="tk-marker" style="left:${markerPct}%" title="Time elapsed ${markerPct}%"></span>`;
  return `<div class="tk-prow">
    <div class="tk-plabel"><strong>${esc(label)}</strong><span class="tk-sub">${esc(sub)}</span></div>
    <div class="tk-track"><span class="tk-fill" style="width:${Math.max(0, Math.min(100, pct))}%"></span>${marker}</div>
    <span class="tk-num">${pct}%</span>
  </div>`;
}

function cyclesCard(cycles) {
  if (!cycles.length) return emptyState('No cycle is running right now.');
  return `<p class="tk-sub">Fill = share done · tick = share of the cycle's time elapsed (fill left of the tick means behind schedule).</p>${cycles.map((c) =>
    progressRow(`${c.project} · ${c.name}`,
      `${c.completed}/${c.total} done${c.cancelled ? `, ${c.cancelled} cancelled` : ''} · ${c.daysLeft}d left (${fmtDate(c.start)} → ${fmtDate(c.end)})`,
      c.pct, c.elapsedPct)).join('')}`;
}

function modulesCard(modules) {
  if (!modules.length) return emptyState('No open modules.');
  return modules.map((m) => progressRow(`${m.project} · ${m.name}`,
    `${m.status}${m.target != null ? ` · target ${fmtDate(m.target)}` : ''}${m.total == null ? ' · no counts' : ` · ${m.completed ?? 0}/${m.total}`}`,
    m.pct ?? 0)).join('');
}

function weeklyChart(weekly) {
  const W = 640, H = 160, padL = 28, padB = 22, padT = 8;
  const max = Math.max(1, ...weekly.map((w) => w.closed));
  const bw = (W - padL) / weekly.length;
  const bars = weekly.map((w, i) => {
    const h = ((H - padB - padT) * w.closed) / max;
    const x = padL + i * bw + 3;
    const y = H - padB - h;
    return `<rect class="tk-wbar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${h.toFixed(1)}"><title>Week of ${fmtDate(w.weekStart)}: ${w.closed} closed</title></rect>
      <text class="tk-wval" x="${(x + (bw - 6) / 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" text-anchor="middle">${w.closed || ''}</text>
      ${i % 2 === 0 ? `<text class="tk-wlab" x="${(x + (bw - 6) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(fmtDate(w.weekStart).slice(5))}</text>` : ''}`;
  }).join('');
  return `<svg class="tk-weekly" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tickets closed per week, last ${weekly.length} weeks">
    <line class="tk-axis" x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}"/>
    <text class="tk-wlab" x="0" y="${padT + 8}">${max}</text>${bars}</svg>
    <p class="tk-sub">Closed per ISO week (UTC, Monday start). Archived tickets are not counted, and tickets migrated from GitHub can carry import dates, so old weeks may be skewed.</p>`;
}

function ticketsPage(gitVersion, state = {}) {
  const { configured, snapshot, errors = [], fetchedAt, stale, error } = state;
  let body;
  if (!configured) {
    body = emptyState('Ticket view not configured: set PLANE_BASE_URL and PLANE_API_KEY (viewer role) in the Heimdall environment.');
  } else if (!snapshot) {
    body = emptyState(`Plane is unreachable${error ? ` (${error})` : ''}. Retrying on the next page load.`, '▲');
  } else {
    const t = snapshot.totals;
    const warn = [];
    if (stale) warn.push(`Showing cached data${fetchedAt ? ` from ${formatAge(fetchedAt)}` : ''}${error ? ` — last refresh failed: ${error}` : ''}.`);
    if (errors.length) warn.push(`Could not refresh: ${errors.map((e) => e.project).join(', ')} (showing last known data where available).`);
    body = `${warn.map((w) => `<p class="tk-warn">▲ ${esc(w)}</p>`).join('')}
      ${grid([
        { title: 'Overview', fullWidth: true, body: `<div class="kpi-row">${kpi(t.open, 'Open')}${kpi(t.inCycle, 'Open in current cycle')}${kpi(t.closed7d, 'Closed, 7 days')}${kpi(t.closed30d, 'Closed, 30 days')}${kpi(t.total, 'Total tracked')}</div>` },
        { title: 'Current cycles', body: cyclesCard(snapshot.cycles) },
        { title: 'Open modules / roadmap', body: modulesCard(snapshot.modules) },
        { title: 'Throughput — closed per week', fullWidth: true, body: weeklyChart(snapshot.weekly) },
        { title: 'Progress per project', fullWidth: true, body: projectsCard(snapshot.projects) },
      ])}`;
  }
  const content = `<div class="tickets-page">
    <div class="page-head"><h1 class="page-title">Tickets</h1>
    <p class="page-sub">Progress in the Plane ticket system — read-only aggregates, refreshed every 5 minutes.</p></div>
    ${body}</div>`;
  return pageShell({
    title: 'Heimdall — Tickets', active: '/tickets', gitVersion, content,
    head: `  <link rel="stylesheet" href="/css/tickets.css?v=${esc(gitVersion || 'dev')}">`,
  });
}

module.exports = { ticketsPage };
