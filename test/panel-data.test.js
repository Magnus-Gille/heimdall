'use strict';

/**
 * Unit tests for src/contract/panel-data.js — shared caps + normalizeTypedPanelData.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LABEL, MAX_UNIT, MAX_POINTS, MAX_ROWS, MAX_COLS, MAX_CELL, MAX_COL_LABEL,
  normPoints, normTable, normalizeTypedPanelData,
} = require('../src/contract/panel-data');

// ─── Cap constant sanity ──────────────────────────────────────────────────────

describe('panel-data cap consts', () => {
  it('exports the expected cap values', () => {
    assert.equal(MAX_LABEL, 120);
    assert.equal(MAX_UNIT, 40);
    assert.equal(MAX_POINTS, 500);
    assert.equal(MAX_ROWS, 200);
    assert.equal(MAX_COLS, 20);
    assert.equal(MAX_CELL, 500);
    assert.equal(MAX_COL_LABEL, 120);
  });
});

// ─── normPoints ───────────────────────────────────────────────────────────────

describe('normPoints', () => {
  it('keeps valid {t,y} points', () => {
    const w = [];
    const pts = normPoints([{ t: '2026-01-01', y: 1 }, { t: '2026-01-02', y: 2 }], w);
    assert.equal(pts.length, 2);
    assert.equal(w.length, 0);
  });

  it('drops invalid entries and warns', () => {
    const w = [];
    const pts = normPoints([{ t: '2026-01-01', y: 1 }, { t: '2026-01-02' }, null, 'bad', { y: 3 }], w);
    assert.equal(pts.length, 2); // only {y:1} and {y:3} are valid
    assert.ok(w.some((x) => x.includes('dropped')));
  });

  it(`caps to last ${MAX_POINTS} points when over`, () => {
    const arr = Array.from({ length: 600 }, (_, i) => ({ t: String(i), y: i }));
    const w = [];
    const pts = normPoints(arr, w);
    assert.equal(pts.length, MAX_POINTS);
    assert.equal(pts[0].y, 100); // last 500 kept
    assert.ok(w.some((x) => x.includes('points capped')));
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(normPoints(null, []), []);
    assert.deepEqual(normPoints('oops', []), []);
  });
});

// ─── normTable ────────────────────────────────────────────────────────────────

describe('normTable', () => {
  it('passes through a normal small table', () => {
    const w = [];
    const t = normTable({ rows: [{ a: '1', b: '2' }] }, w);
    assert.equal(t.rows.length, 1);
    assert.equal(w.length, 0);
  });

  it(`caps rows to ${MAX_ROWS}`, () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ a: String(i) }));
    const w = [];
    const t = normTable({ rows }, w);
    assert.equal(t.rows.length, MAX_ROWS);
    assert.ok(w.some((x) => x.includes('rows capped')));
  });

  it(`caps distinct keys to ${MAX_COLS}`, () => {
    const row = {};
    for (let i = 0; i < MAX_COLS + 5; i++) row[`col${i}`] = `v${i}`;
    const w = [];
    const t = normTable({ rows: [row] }, w);
    assert.ok(Object.keys(t.rows[0]).length <= MAX_COLS);
    assert.ok(w.some((x) => x.includes('distinct keys capped')));
  });

  it(`caps cols array to ${MAX_COLS}`, () => {
    const cols = Array.from({ length: MAX_COLS + 5 }, (_, i) => `c${i}`);
    const w = [];
    const t = normTable({ rows: [{ c0: 'x' }], cols }, w);
    assert.ok(t.cols.length <= MAX_COLS);
    assert.ok(w.some((x) => x.includes('cols capped')));
  });

  it(`clamps cell values to ${MAX_CELL} chars`, () => {
    const bigStr = 'x'.repeat(MAX_CELL + 100);
    const w = [];
    const t = normTable({ rows: [{ a: bigStr }] }, w);
    assert.equal(t.rows[0].a.length, MAX_CELL);
  });

  it('drops non-object rows and warns', () => {
    const w = [];
    const t = normTable({ rows: [{ a: 1 }, null, 'bad', 42] }, w);
    assert.equal(t.rows.length, 1);
    assert.ok(w.some((x) => x.includes('non-object table row')));
  });

  it(`truncates over-long row KEYS to ${MAX_COL_LABEL} chars (header text), warns once`, () => {
    const longKey = 'k'.repeat(MAX_COL_LABEL + 50);
    const w = [];
    const t = normTable({ rows: [{ [longKey]: 'v' }] }, w);
    const keys = Object.keys(t.rows[0]);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].length, MAX_COL_LABEL, 'row key not truncated');
    assert.ok(w.some((x) => x.includes('column key(s) truncated')));
  });

  it(`truncates over-long explicit COLS to ${MAX_COL_LABEL} chars`, () => {
    const longCol = 'c'.repeat(MAX_COL_LABEL + 50);
    const w = [];
    const t = normTable({ rows: [{ a: '1' }], cols: [longCol] }, w);
    assert.equal(t.cols[0].length, MAX_COL_LABEL, 'explicit col not truncated');
    assert.ok(w.some((x) => x.includes('column key(s) truncated')));
  });

  it('keeps cell values aligned to their (truncated) header key', () => {
    const longKey = 'h'.repeat(MAX_COL_LABEL + 10);
    const truncated = longKey.slice(0, MAX_COL_LABEL);
    const w = [];
    const t = normTable({ rows: [{ [longKey]: 'cell-value' }] }, w);
    // The value must still be reachable under the truncated key.
    assert.equal(t.rows[0][truncated], 'cell-value');
  });

  it('does not warn about key truncation when all keys are short', () => {
    const w = [];
    normTable({ rows: [{ a: '1', b: '2' }] }, w);
    assert.ok(!w.some((x) => x.includes('column key(s) truncated')));
  });
});

// ─── normalizeTypedPanelData ──────────────────────────────────────────────────

describe('normalizeTypedPanelData — stat', () => {
  it('copies value + delta when valid', () => {
    const w = [];
    const d = normalizeTypedPanelData('stat', { value: 42, delta: { value: -3, dir: 'down' } }, w);
    assert.equal(d.value, 42);
    assert.deepEqual(d.delta, { value: -3, dir: 'down' });
    assert.equal(w.length, 0);
  });

  it('drops invalid delta with warning', () => {
    const w = [];
    const d = normalizeTypedPanelData('stat', { value: 5, delta: 'bad' }, w);
    assert.equal(d.value, 5);
    assert.equal(d.delta, undefined);
    assert.ok(w.some((x) => x.includes('delta')));
  });

  it('returns empty object when value is missing or non-numeric', () => {
    const w = [];
    const d = normalizeTypedPanelData('stat', {}, w);
    assert.deepEqual(d, {});
  });
});

describe('normalizeTypedPanelData — timeseries', () => {
  it('normalizes + caps points', () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ t: String(i), y: i }));
    const w = [];
    const d = normalizeTypedPanelData('timeseries', { points: pts }, w);
    assert.equal(d.points.length, MAX_POINTS);
    assert.ok(w.some((x) => x.includes('points capped')));
  });

  it('normalizes summary', () => {
    const w = [];
    const d = normalizeTypedPanelData('timeseries', {
      points: [{ t: 'a', y: 1 }],
      summary: { latest: 1, window: '24h', n: 60 },
    }, w);
    assert.deepEqual(d.summary, { latest: 1, window: '24h', n: 60 });
  });

  it('returns empty object when points missing or invalid', () => {
    assert.deepEqual(normalizeTypedPanelData('timeseries', {}, []), {});
    assert.deepEqual(normalizeTypedPanelData('timeseries', { points: [] }, []), {});
  });

  it('preserves extra scalar summary fields (#87) alongside latest/window/n', () => {
    const w = [];
    const d = normalizeTypedPanelData('timeseries', {
      points: [{ t: 'a', y: 1 }],
      summary: { latest: 1, window: '24h', n: 6, lowSample: true, source: 'gille-inference', reqRate: 0.5 },
    }, w);
    assert.equal(d.summary.latest, 1);
    assert.equal(d.summary.lowSample, true);
    assert.equal(d.summary.source, 'gille-inference');
    assert.equal(d.summary.reqRate, 0.5);
  });

  it('drops non-scalar extra summary fields and clamps/caps them (#87)', () => {
    const w = [];
    const many = {};
    for (let i = 0; i < 40; i++) many['k' + i] = i;
    const d = normalizeTypedPanelData('timeseries', {
      points: [{ t: 'a', y: 1 }],
      summary: { latest: 1, nested: { a: 1 }, arr: [1, 2], nul: null, big: 'x'.repeat(1000), ...many },
    }, w);
    assert.equal(d.summary.nested, undefined, 'objects dropped');
    assert.equal(d.summary.arr, undefined, 'arrays dropped');
    assert.equal('nul' in d.summary, false, 'null dropped');
    assert.ok(d.summary.big.length <= 200, 'long strings clamped');
    // reserved (latest) + at most 20 extras retained
    assert.ok(Object.keys(d.summary).length <= 21, 'extra count capped');
  });

  it('drops extra summary fields with over-long keys (#87 DoS guard)', () => {
    const w = [];
    const longKey = 'k'.repeat(500);
    const d = normalizeTypedPanelData('timeseries', {
      points: [{ t: 'a', y: 1 }],
      summary: { latest: 1, [longKey]: 'v', short: 'ok' },
    }, w);
    assert.equal(d.summary.short, 'ok', 'normal-length key retained');
    assert.equal(longKey in d.summary, false, 'over-long key dropped');
  });
});

describe('normalizeTypedPanelData — table', () => {
  it('caps rows and cols', () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ a: String(i) }));
    const cols = Array.from({ length: MAX_COLS + 5 }, (_, i) => `c${i}`);
    const w = [];
    const d = normalizeTypedPanelData('table', { rows, cols }, w);
    assert.ok(d.rows.length <= MAX_ROWS);
    assert.ok(d.cols.length <= MAX_COLS);
  });

  it('returns empty object when rows is missing', () => {
    assert.deepEqual(normalizeTypedPanelData('table', {}, []), {});
  });
});

describe('normalizeTypedPanelData — status', () => {
  it('copies state + caps message', () => {
    const longMsg = 'x'.repeat(MAX_CELL + 100);
    const w = [];
    const d = normalizeTypedPanelData('status', { state: 'warn', message: longMsg }, w);
    assert.equal(d.state, 'warn');
    assert.equal(d.message.length, MAX_CELL);
  });

  it('drops non-string message with warning', () => {
    const w = [];
    const d = normalizeTypedPanelData('status', { state: 'pass', message: 42 }, w);
    assert.equal(d.state, 'pass');
    assert.equal(d.message, undefined);
    assert.ok(w.some((x) => x.includes('message')));
  });

  it('returns empty object for unknown state', () => {
    assert.deepEqual(normalizeTypedPanelData('status', { state: 'bogus' }, []), {});
  });
});

describe('normalizeTypedPanelData — detail (all kinds)', () => {
  it('normalizes a valid nested detail table', () => {
    const w = [];
    const d = normalizeTypedPanelData('stat', {
      value: 1,
      detail: { rows: [{ model: 'qwen3', score: '0.9' }], label: 'Breakdown' },
    }, w);
    assert.ok(d.detail);
    assert.equal(d.detail.kind, 'table');
    assert.equal(d.detail.rows.length, 1);
    assert.equal(d.detail.label, 'Breakdown');
  });

  it('drops invalid detail with warning', () => {
    const w = [];
    const d = normalizeTypedPanelData('stat', { value: 1, detail: 'not an object' }, w);
    assert.equal(d.detail, undefined);
    assert.ok(w.some((x) => x.includes('detail')));
  });

  it('caps oversized detail table rows', () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ a: String(i) }));
    const w = [];
    const d = normalizeTypedPanelData('table', { rows: [{ x: '1' }], detail: { rows } }, w);
    assert.ok(d.detail.rows.length <= MAX_ROWS);
  });
});
