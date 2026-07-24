'use strict';

/**
 * Boundary tests for src/config/insight-thresholds.js (issue #6): every
 * user-facing insight status comes from the shared band helper, boundaries are
 * pinned exactly on both sides, and unknown/calibrating is never good.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  bandStatus,
  bandTitle,
  SIS_BAND,
  OUTCOME_QUALITY_BAND,
  FIRST_PASS_BAND,
} = require('../src/config/insight-thresholds');

test('SIS band boundaries are exact on both sides', () => {
  assert.strictEqual(bandStatus(100, SIS_BAND), 'ok');
  assert.strictEqual(bandStatus(75, SIS_BAND), 'ok'); // boundary: >= okMin
  assert.strictEqual(bandStatus(74.999, SIS_BAND), 'warn');
  assert.strictEqual(bandStatus(55, SIS_BAND), 'warn'); // boundary: >= warnMin
  assert.strictEqual(bandStatus(54.999, SIS_BAND), 'crit');
  assert.strictEqual(bandStatus(0, SIS_BAND), 'crit');
});

test('outcome-quality band boundaries are exact on both sides', () => {
  assert.strictEqual(bandStatus(0.80, OUTCOME_QUALITY_BAND), 'ok');
  assert.strictEqual(bandStatus(0.799, OUTCOME_QUALITY_BAND), 'warn');
  assert.strictEqual(bandStatus(0.60, OUTCOME_QUALITY_BAND), 'warn');
  assert.strictEqual(bandStatus(0.599, OUTCOME_QUALITY_BAND), 'crit');
});

test('first-pass-correctness band boundaries are exact on both sides', () => {
  assert.strictEqual(bandStatus(0.70, FIRST_PASS_BAND), 'ok');
  assert.strictEqual(bandStatus(0.699, FIRST_PASS_BAND), 'warn');
  assert.strictEqual(bandStatus(0.50, FIRST_PASS_BAND), 'warn');
  assert.strictEqual(bandStatus(0.499, FIRST_PASS_BAND), 'crit');
});

test('unknown or calibrating is stale, never good', () => {
  for (const v of [null, undefined, NaN, 'not-a-number', Infinity, -Infinity]) {
    assert.strictEqual(bandStatus(v, SIS_BAND), 'stale', `value ${String(v)} must be stale`);
  }
  // 0 is a real (bad) measurement, NOT stale — a legitimate zero must stay crit.
  assert.strictEqual(bandStatus(0, OUTCOME_QUALITY_BAND), 'crit');
});

test('bandTitle explains good/degraded/bad and stale, with formatting', () => {
  const t = bandTitle(SIS_BAND);
  assert.match(t, /good ≥ 75/);
  assert.match(t, /degraded ≥ 55/);
  assert.match(t, /bad < 55/);
  assert.match(t, /stale/);
  const pct = bandTitle(OUTCOME_QUALITY_BAND, (v) => `${Math.round(v * 100)}%`);
  assert.match(pct, /good ≥ 80%/);
  assert.match(pct, /degraded ≥ 60%/);
});

test('renderer uses the shared bands: no data renders stale (never ok), and populated KPIs carry band tooltips', () => {
  const { insightsPage } = require('../src/render/insights');

  // No data → every banded KPI must be stale, not ok.
  const emptyHtml = insightsPage('test', {});
  const emptyKpiRow = emptyHtml.split('kpi-row')[1] || '';
  assert.ok(!emptyKpiRow.includes('kpi-val is-ok'), 'no banded KPI may render ok without data');
  assert.ok(emptyKpiRow.includes('is-stale'), 'missing data must render stale');

  // Populated record → tooltips carry the threshold provenance from the shared config.
  const record = {
    week: '2026-W30',
    headline: { commits: 12 },
    outcomes: { achieved: 10, fully: 9, mostly: 1, not: 0 },
  };
  const html = insightsPage('test', { records: [record] });
  assert.match(html, /title="good ≥ 75/, 'SIS KPI must state its band');
  assert.match(html, /good ≥ 80%/, 'outcome KPI must state its band as percentages');
  assert.match(html, /good ≥ 70%/, 'first-pass KPI must state its band as percentages');
});
