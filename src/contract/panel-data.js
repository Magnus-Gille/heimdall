'use strict';

/**
 * panel-data.js — shared cap consts + normalizers for typed panels.
 *
 * Single source of truth for the data-size caps that apply on BOTH the push
 * path (POST /api/panels via panel-ingest.js) and the pull path (descriptor
 * inline panels via schema.js normalizePanels).  Must be pure — no db/http
 * imports — so schema.js can require it without import cycles.
 */

// ─── Cap consts ─────────────────────────────────────────────────────────────

const MAX_LABEL = 120;
const MAX_UNIT = 40;
const MAX_POINTS = 500;
const MAX_ROWS = 200;
const MAX_COLS = 20;
const MAX_CELL = 500; // table cell / status message clamp
const MAX_SUMMARY_EXTRA = 20; // extra (non latest/window/n) timeseries summary fields (#87)
const MAX_SUMMARY_EXTRA_KEY = 64; // clamp key length (#87 DoS guard — bounds stored JSON + rendered HTML)
const MAX_SUMMARY_EXTRA_VAL = 200; // clamp extra summary string values (#87)
const MAX_COL_LABEL = 120; // table header / column-key length clamp

// ─── Private helpers ─────────────────────────────────────────────────────────

const STATUS_STATES = new Set(['pass', 'warn', 'fail']);

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function clampStr(s, max) { return String(s).slice(0, max); }

// ─── Shared normalizers (also used directly by validatePanel) ────────────────

/** Normalize + cap a list of {t,y} points; drops invalid ones. */
function normPoints(arr, warnings) {
  if (!Array.isArray(arr)) return [];
  let pts = arr
    .filter((p) => isObj(p) && isNum(p.y))
    .map((p) => ({ t: typeof p.t === 'string' ? clampStr(p.t, 64) : '', y: p.y }));
  const dropped = arr.length - pts.length;
  if (dropped > 0) warnings.push(`dropped ${dropped} invalid timeseries point(s)`);
  if (pts.length > MAX_POINTS) {
    warnings.push(`points capped to last ${MAX_POINTS} (was ${pts.length})`);
    pts = pts.slice(-MAX_POINTS);
  }
  return pts;
}

/** Normalize a table-ish {cols?, rows} payload; caps rows/cols. */
function normTable(obj, warnings) {
  const out = {};
  let rows = Array.isArray(obj.rows)
    ? obj.rows.filter((r) => isObj(r))
    : [];
  if (Array.isArray(obj.rows) && rows.length !== obj.rows.length) {
    warnings.push(`dropped ${obj.rows.length - rows.length} non-object table row(s)`);
  }
  if (rows.length > MAX_ROWS) {
    warnings.push(`table rows capped to ${MAX_ROWS} (was ${rows.length})`);
    rows = rows.slice(0, MAX_ROWS);
  }
  // Truncate over-long column KEY strings consistently so header text and the
  // row-key it maps to stay aligned (the renderer joins cells to cols by key).
  let keyTruncated = false;
  const capKey = (k) => {
    if (k.length > MAX_COL_LABEL) { keyTruncated = true; return k.slice(0, MAX_COL_LABEL); }
    return k;
  };

  // Count distinct (truncated) keys BEFORE capping so the warning is accurate.
  const allDistinctKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allDistinctKeys.add(capKey(k));
  const distinctKeyCount = allDistinctKeys.size;

  // Cap distinct key set to MAX_COLS; truncate keys; clamp cell values.
  const seenKeys = new Set();
  rows = rows.map((r) => {
    const o = {};
    for (const [k0, v] of Object.entries(r)) {
      const k = capKey(k0);
      if (!seenKeys.has(k) && seenKeys.size >= MAX_COLS) continue; // key cap hit — drop
      seenKeys.add(k);
      o[k] = typeof v === 'string' ? clampStr(v, MAX_CELL) : (v == null ? v : clampStr(String(v), MAX_CELL));
    }
    return o;
  });
  if (distinctKeyCount > MAX_COLS) {
    warnings.push(`table distinct keys capped to ${MAX_COLS} (was ${distinctKeyCount})`);
  }
  out.rows = rows;
  if (Array.isArray(obj.cols)) {
    let cols = obj.cols.filter((c) => typeof c === 'string').map(capKey);
    if (cols.length > MAX_COLS) {
      warnings.push(`table cols capped to ${MAX_COLS} (was ${cols.length})`);
      cols = cols.slice(0, MAX_COLS);
    }
    if (cols.length) out.cols = cols;
  }
  if (keyTruncated) {
    warnings.push(`table column key(s) truncated to ${MAX_COL_LABEL} chars`);
  }
  return out;
}

// ─── High-level normalizer ────────────────────────────────────────────────────

/**
 * Lenient normalizer for the kind-specific data fields of a typed panel.
 *
 * Does NOT hard-reject missing required fields — caps + warns only.  Used by:
 *   - The pull path  (schema.js normalizePanels — descriptor inline panels)
 *   - The push path  (panel-ingest.js validatePanel, after required-field checks)
 *
 * @param {string}   kind     'stat'|'timeseries'|'table'|'status'
 * @param {object}   raw      panel object with kind-specific fields at top-level
 * @param {string[]} warnings mutable array — push() is called for each cap applied
 * @returns {object} normalized data fields (spread into the stored/rendered panel)
 */
function normalizeTypedPanelData(kind, raw, warnings) {
  const data = {};

  if (kind === 'stat') {
    if (isNum(raw.value)) {
      data.value = raw.value;
      if (raw.delta != null) {
        if (isObj(raw.delta) && isNum(raw.delta.value)) {
          const dir = (raw.delta.dir === 'up' || raw.delta.dir === 'down') ? raw.delta.dir : undefined;
          data.delta = dir ? { value: raw.delta.value, dir } : { value: raw.delta.value };
        } else {
          warnings.push('dropped invalid `delta` (expected { value:number, dir?:up|down })');
        }
      }
    }
  } else if (kind === 'timeseries') {
    if (Array.isArray(raw.points)) {
      const pts = normPoints(raw.points, warnings);
      if (pts.length) {
        data.points = pts;
        if (raw.summary != null) {
          if (isObj(raw.summary)) {
            const s = {};
            if (isNum(raw.summary.latest)) s.latest = raw.summary.latest;
            if (typeof raw.summary.window === 'string') s.window = clampStr(raw.summary.window, 40);
            if (isNum(raw.summary.n)) s.n = raw.summary.n;
            // Preserve extra scalar summary fields (#87) so a producer's future
            // fields "just work" without a renderer change. Only booleans /
            // finite numbers / strings survive; objects, arrays and null are
            // dropped. Bounded (count + string length) as a DoS-amplification
            // guard, mirroring the table/point caps elsewhere in this file.
            const RESERVED = new Set(['latest', 'window', 'n']);
            let extras = 0;
            for (const [k, v] of Object.entries(raw.summary)) {
              if (RESERVED.has(k)) continue;
              if (k.length > MAX_SUMMARY_EXTRA_KEY) { warnings.push('dropped extra summary field with over-long key'); continue; }
              if (extras >= MAX_SUMMARY_EXTRA) { warnings.push('extra summary fields capped'); break; }
              if (typeof v === 'boolean' || isNum(v)) { s[k] = v; extras++; }
              else if (typeof v === 'string') { s[k] = clampStr(v, MAX_SUMMARY_EXTRA_VAL); extras++; }
            }
            if (Object.keys(s).length) data.summary = s;
          } else {
            warnings.push('dropped invalid `summary` (expected object)');
          }
        }
      }
    }
  } else if (kind === 'table') {
    if (Array.isArray(raw.rows)) {
      const t = normTable(raw, warnings);
      Object.assign(data, t);
    }
  } else if (kind === 'status') {
    if (STATUS_STATES.has(raw.state)) {
      data.state = raw.state;
      if (raw.message != null) {
        if (typeof raw.message === 'string') data.message = clampStr(raw.message, MAX_CELL);
        else warnings.push('dropped non-string `message`');
      }
    }
  }

  // detail — always a table-kind object rendered beneath the main panel
  if (raw.detail != null) {
    if (isObj(raw.detail) && Array.isArray(raw.detail.rows)) {
      const t = normTable(raw.detail, warnings);
      const detail = { kind: 'table', ...t };
      if (typeof raw.detail.label === 'string') detail.label = clampStr(raw.detail.label, MAX_LABEL);
      data.detail = detail;
    } else {
      warnings.push('dropped invalid `detail` (expected a table-kind object with rows)');
    }
  }

  return data;
}

module.exports = {
  MAX_LABEL,
  MAX_UNIT,
  MAX_POINTS,
  MAX_ROWS,
  MAX_COLS,
  MAX_CELL,
  MAX_COL_LABEL,
  normPoints,
  normTable,
  normalizeTypedPanelData,
};
