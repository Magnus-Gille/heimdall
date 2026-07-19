'use strict';

/**
 * panels.js — native renderers for generic typed panels (#57).
 *
 * A producer POSTs a typed-panel blob (or carries it inline in /heimdall.json);
 * Heimdall renders it here with ZERO per-panel code. Typed kinds carry DATA,
 * never HTML — every string is run through esc() (XSS guard). Four kinds:
 *
 *   stat       — big number + optional ▲/▼ delta
 *   timeseries — inline SVG sparkline + latest value
 *   table      — simple HTML table (cols default to union of row keys)
 *   status     — status pill + message
 *
 * Each renderer returns a CARD string. `renderTypedPanel(panel)` dispatches on
 * `panel.kind`. The optional `panel.detail` (a nested table-kind object) renders
 * beneath the main panel via the table renderer.
 *
 * Panel object shape (push + pull share it):
 *   { panel|id, kind, label, unit?, detail?, ...kindData }
 */

const { card } = require('./cards');
const { esc } = require('./util');
const { sparklineSvg, statusBadge } = require('./components');

const STATUS_STATE = { pass: 'ok', warn: 'warn', fail: 'crit' };
const STATUS_LABEL = { pass: 'Pass', warn: 'Warn', fail: 'Fail' };

// DoS-amplification guards: bound output regardless of data source (push OR pull).
const MAX_COLS = 20;
const MAX_ROWS = 200;
const MAX_VISIBLE_ROWS = 12;
const MAX_CELL = 500;
const MAX_POINTS = 500;

function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  // Trim trailing zeros but keep integers clean and decimals readable.
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

/** stat — big number + optional unit + ▲/▼ delta. Returns body HTML. */
function renderStatBody(p) {
  const unit = p.unit ? `<span class="panel-stat-unit">${esc(p.unit)}</span>` : '';
  let delta = '';
  const d = p.delta;
  if (d && typeof d === 'object' && typeof d.value === 'number' && Number.isFinite(d.value)) {
    const dir = d.dir === 'up' || d.dir === 'down'
      ? d.dir
      : (d.value > 0 ? 'up' : (d.value < 0 ? 'down' : 'flat'));
    const glyph = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '◆');
    delta = `<span class="panel-delta is-${esc(dir)}"><span class="glyph" aria-hidden="true">${glyph}</span>${esc(fmtNum(d.value))}</span>`;
  }
  return `<div class="panel-stat">
    <span class="panel-stat-val">${esc(fmtNum(p.value))}</span>${unit}${delta}
  </div>`;
}

// Summary keys the meta line already renders explicitly.
const SUMMARY_RESERVED = new Set(['latest', 'window', 'n']);
// DoS-amplification guards, mirror normalizeTypedPanelData — re-applied here
// because render is the boundary regardless of whether normalization ran.
const MAX_SUMMARY_EXTRA = 20;
const MAX_SUMMARY_EXTRA_KEY = 64;
const MAX_SUMMARY_EXTRA_VAL = 200;

/**
 * Render any extra (non latest/window/n) scalar summary fields (#87) so a
 * producer's future fields "just work" without a template change. Booleans
 * become flag chips (yes/no); numbers and strings render as `key value` text.
 * Non-scalars are ignored. Bounded + esc()'d here too — render is the XSS/DoS
 * boundary regardless of whether normalization already ran.
 */
function renderSummaryExtras(summary) {
  const items = [];
  for (const [rawKey, v] of Object.entries(summary)) {
    if (SUMMARY_RESERVED.has(rawKey)) continue;
    if (items.length >= MAX_SUMMARY_EXTRA) break;
    const k = esc(rawKey.slice(0, MAX_SUMMARY_EXTRA_KEY));
    if (typeof v === 'boolean') {
      items.push(`<span class="panel-flag is-${v ? 'on' : 'off'}">${k}: ${v ? 'yes' : 'no'}</span>`);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      items.push(`<span class="panel-extra-item">${k} ${esc(fmtNum(v))}</span>`);
    } else if (typeof v === 'string') {
      items.push(`<span class="panel-extra-item">${k} ${esc(v.slice(0, MAX_SUMMARY_EXTRA_VAL))}</span>`);
    }
  }
  return items.length ? `<div class="panel-meta panel-extra">${items.join(' ')}</div>` : '';
}

/** timeseries — inline sparkline + latest value. Returns body HTML. */
function renderTimeseriesBody(p) {
  const allPoints = Array.isArray(p.points) ? p.points : [];
  // Cap to the last MAX_POINTS before building the sparkline (DoS amplification guard).
  const points = allPoints.length > MAX_POINTS ? allPoints.slice(-MAX_POINTS) : allPoints;
  const ys = points.map((pt) => (pt && typeof pt.y === 'number' ? pt.y : NaN)).filter(Number.isFinite);
  const summary = p.summary && typeof p.summary === 'object' ? p.summary : {};
  const latest = (typeof summary.latest === 'number' && Number.isFinite(summary.latest))
    ? summary.latest
    : (ys.length ? ys[ys.length - 1] : null);
  const meta = [
    latest != null ? `latest ${esc(fmtNum(latest))}${p.unit ? ' ' + esc(p.unit) : ''}` : '',
    summary.window ? `window ${esc(String(summary.window))}` : '',
    (typeof summary.n === 'number' && Number.isFinite(summary.n)) ? `n=${esc(String(summary.n))}` : '',
  ].filter(Boolean).join(' · ');
  const extras = renderSummaryExtras(summary);
  const spark = ys.length >= 2
    ? sparklineSvg(ys, { width: 220, height: 44 })
    : `<div class="panel-empty">not enough points to chart</div>`;
  return `<div class="panel-timeseries">
    ${spark}
    ${meta ? `<div class="panel-meta">${meta}</div>` : ''}
    ${extras}
  </div>`;
}

/** Render already-normalized rows/columns as one table. */
function renderTable(rows, cols) {
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) => {
    const cells = cols.map((c) => {
      const v = r[c];
      // Coerce to string; clamp to MAX_CELL chars before escaping (DoS amplification guard).
      let text = (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      if (text.length > MAX_CELL) text = text.slice(0, MAX_CELL);
      return `<td>${esc(text)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="panel-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** table — show the first actionable slice; collapse oversized evidence lists. */
function renderTableBody(p) {
  // Cap rows to MAX_ROWS regardless of data source (DoS amplification guard).
  const allRows = Array.isArray(p.rows) ? p.rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) : [];
  const rows = allRows.length > MAX_ROWS ? allRows.slice(0, MAX_ROWS) : allRows;
  let cols = Array.isArray(p.cols) ? p.cols.filter((c) => typeof c === 'string') : null;
  if (!cols || !cols.length) {
    const seen = new Set();
    cols = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
  }
  // Cap columns to MAX_COLS regardless of data source.
  if (cols.length > MAX_COLS) cols = cols.slice(0, MAX_COLS);
  if (!rows.length || !cols.length) return `<div class="panel-empty">no rows</div>`;
  const visible = rows.slice(0, MAX_VISIBLE_ROWS);
  const rest = rows.slice(MAX_VISIBLE_ROWS);
  const more = rest.length
    ? `<details class="panel-table-more"><summary>Show ${rest.length} more rows</summary>${renderTable(rest, cols)}</details>`
    : '';
  return renderTable(visible, cols) + more;
}

/** status — status pill + optional message. Returns body HTML. */
function renderStatusBody(p) {
  const state = STATUS_STATE[p.state] || 'stale';
  const label = STATUS_LABEL[p.state] || 'Unknown';
  const msg = p.message ? `<span class="panel-status-msg">${esc(p.message)}</span>` : '';
  return `<div class="panel-status">${statusBadge(state, label)}${msg}</div>`;
}

const BODY_RENDERERS = {
  stat: renderStatBody,
  timeseries: renderTimeseriesBody,
  table: renderTableBody,
  status: renderStatusBody,
};

/** Render the optional nested `detail` (a table-kind object) beneath the main panel. */
function renderDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '';
  // detail is always rendered via the table renderer (the canonical example shape).
  const body = renderTableBody(detail);
  const head = detail.label ? `<div class="panel-detail-label">${esc(detail.label)}</div>` : '';
  return `<div class="panel-detail">${head}${body}</div>`;
}

/**
 * Dispatch on kind and return a full CARD string. Unknown kinds render a small
 * placeholder card rather than throwing (forward-compatible).
 */
function renderTypedPanel(p) {
  if (!p || typeof p !== 'object') return '';
  const renderer = BODY_RENDERERS[p.kind];
  const fullWidth = p.kind === 'table' || (p.detail != null);
  if (!renderer) {
    return card({ title: p.label || p.panel || p.id || 'panel', body: `<div class="panel-empty">unsupported panel kind "${esc(p.kind)}"</div>` });
  }
  const body = renderer(p) + renderDetail(p.detail);
  return card({ title: p.label || p.panel || p.id || 'panel', body, fullWidth });
}

module.exports = {
  renderStatPanel: (p) => card({ title: p.label, body: renderStatBody(p) + renderDetail(p.detail) }),
  renderTimeseriesPanel: (p) => card({ title: p.label, body: renderTimeseriesBody(p) + renderDetail(p.detail), fullWidth: p.detail != null }),
  renderTablePanel: (p) => card({ title: p.label, body: renderTableBody(p) + renderDetail(p.detail), fullWidth: true }),
  renderStatusPanel: (p) => card({ title: p.label, body: renderStatusBody(p) + renderDetail(p.detail) }),
  renderTypedPanel,
  // exposed for reuse/testing
  renderTableBody,
};
