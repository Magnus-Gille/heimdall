'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lttbDownsample, prepareChartData, linearRegression } = require('../src/charts');

describe('lttbDownsample', () => {
  it('returns data unchanged when fewer points than target', () => {
    const data = [{ value: 1 }, { value: 2 }, { value: 3 }];
    assert.deepStrictEqual(lttbDownsample(data, 5), data);
  });

  it('returns data unchanged when exactly target points', () => {
    const data = [{ value: 1 }, { value: 2 }, { value: 3 }];
    assert.deepStrictEqual(lttbDownsample(data, 3), data);
  });

  it('returns data unchanged when targetPoints < 3', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ value: i }));
    assert.deepStrictEqual(lttbDownsample(data, 2), data);
  });

  it('returns null/undefined input unchanged', () => {
    assert.strictEqual(lttbDownsample(null, 10), null);
    assert.strictEqual(lttbDownsample(undefined, 10), undefined);
  });

  it('always includes first and last points', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ value: Math.sin(i / 10) }));
    const result = lttbDownsample(data, 10);
    assert.strictEqual(result[0], data[0]);
    assert.strictEqual(result[result.length - 1], data[data.length - 1]);
  });

  it('returns exactly targetPoints points', () => {
    const data = Array.from({ length: 200 }, (_, i) => ({ value: i * 2 }));
    const result = lttbDownsample(data, 20);
    assert.strictEqual(result.length, 20);
  });

  it('preserves peaks in data', () => {
    // Create flat data with a single spike
    const data = Array.from({ length: 100 }, (_, i) => ({ value: i === 50 ? 1000 : 1 }));
    const result = lttbDownsample(data, 10);
    // The spike should be preserved
    assert.ok(result.some(p => p.value === 1000), 'spike should be preserved');
  });

  it('handles data with null/undefined values (treats as 0)', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ value: i % 5 === 0 ? null : i }));
    const result = lttbDownsample(data, 10);
    assert.strictEqual(result.length, 10);
  });
});

describe('prepareChartData', () => {
  it('maps data to {x, y} format', () => {
    const data = [
      { timestamp: '2025-01-01', value: 42 },
      { timestamp: '2025-01-02', value: 43 },
    ];
    const result = prepareChartData(data, 10);
    assert.deepStrictEqual(result, [
      { x: '2025-01-01', y: 42 },
      { x: '2025-01-02', y: 43 },
    ]);
  });

  it('downsamples when data exceeds target points', () => {
    const data = Array.from({ length: 500 }, (_, i) => ({
      timestamp: `2025-01-01T${String(i).padStart(4, '0')}`,
      value: i,
    }));
    const result = prepareChartData(data, 50);
    assert.strictEqual(result.length, 50);
    assert.ok(result.every(p => 'x' in p && 'y' in p));
  });
});

describe('linearRegression', () => {
  it('returns null for fewer than 2 points', () => {
    assert.strictEqual(linearRegression([]), null);
    assert.strictEqual(linearRegression([{ x: 1, y: 1 }]), null);
  });

  it('computes correct slope and intercept for perfect line', () => {
    // y = 2x + 1
    const points = [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }];
    const result = linearRegression(points);
    assert.ok(Math.abs(result.slope - 2) < 1e-10);
    assert.ok(Math.abs(result.intercept - 1) < 1e-10);
  });

  it('computes correct slope for horizontal line', () => {
    const points = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }];
    const result = linearRegression(points);
    assert.ok(Math.abs(result.slope) < 1e-10);
    assert.ok(Math.abs(result.intercept - 5) < 1e-10);
  });

  it('returns null for vertical line (identical x values)', () => {
    const points = [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }];
    assert.strictEqual(linearRegression(points), null);
  });

  it('handles negative slope', () => {
    // y = -3x + 10
    const points = [{ x: 0, y: 10 }, { x: 1, y: 7 }, { x: 2, y: 4 }, { x: 3, y: 1 }];
    const result = linearRegression(points);
    assert.ok(Math.abs(result.slope - (-3)) < 1e-10);
    assert.ok(Math.abs(result.intercept - 10) < 1e-10);
  });
});
