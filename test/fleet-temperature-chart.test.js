'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '../public/charts-client.js'), 'utf8');

async function renderChart(fetchResponse) {
  const hosts = ['huginmunin', 'nas'];
  const wrapper = { hidden: true };
  const status = { hidden: false, textContent: 'Loading temperature data…' };
  const canvas = { dataset: { hosts: JSON.stringify(hosts) }, getContext: () => ({}) };
  const charts = [];
  const errors = [];
  class FakeChart {
    constructor(_context, config) {
      this.data = config.data;
      this.options = config.options;
      this.updates = 0;
      this.resizes = 0;
      charts.push(this);
    }
    update() { this.updates += 1; }
    resize() { this.resizes += 1; }
    destroy() {}
  }
  const elements = {
    'fleet-temp-chart': canvas,
    'fleet-temp-chart-wrap': wrapper,
    'fleet-temp-chart-status': status,
  };
  const document = {
    readyState: 'loading',
    documentElement: { getAttribute: () => null },
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    addEventListener: () => {},
  };
  const context = vm.createContext({
    document,
    Chart: FakeChart,
    localStorage: { getItem: () => null },
    fetch: (url) => fetchResponse(url),
    console: { error: (...args) => errors.push(args) },
    setTimeout: () => {},
  });
  vm.runInContext(client, context);
  await vm.runInContext('initFleetTempChart()', context);
  return { chart: charts[0], wrapper, status, errors };
}

describe('Fleet temperature chart data state (#75)', () => {
  it('explains an empty 24-hour history and hides the misleading plot', async () => {
    const { chart, wrapper, status, errors } = await renderChart(async () => ({
      ok: true,
      json: async () => [],
    }));
    assert.equal(wrapper.hidden, true);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, 'No temperature samples in the last 24 hours.');
    assert.equal(chart.data.datasets.every((dataset) => dataset.data.length === 0), true);
    assert.equal(errors.length, 0);
  });

  it('shows the chart when any host has samples', async () => {
    const { chart, wrapper, status } = await renderChart(async (url) => ({
      ok: true,
      json: async () => url.includes('/huginmunin/') ? [{ x: '2026-09-26T12:00:00Z', y: 42 }] : [],
    }));
    assert.equal(wrapper.hidden, false);
    assert.equal(status.hidden, true);
    assert.equal(chart.data.datasets[0].data.length, 1);
    assert.equal(chart.data.datasets[1].data.length, 0);
    assert.equal(chart.resizes, 1);
  });

  it('distinguishes a failed request from valid empty history', async () => {
    const { wrapper, status, errors } = await renderChart(async (url) => {
      if (url.includes('/huginmunin/')) return { ok: false, status: 503 };
      return { ok: true, json: async () => [] };
    });
    assert.equal(wrapper.hidden, true);
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /Temperature data unavailable for 1 of 2 hosts/);
    assert.doesNotMatch(status.textContent, /^No temperature samples/);
    assert.equal(errors.length, 1);
  });
});

describe('Fleet temperature chart axis labels (#77)', () => {
  it('formats integer and decimal ticks without floating point tails', async () => {
    const { chart } = await renderChart(async () => ({
      ok: true,
      json: async () => [{ x: '2026-09-26T12:00:00Z', y: 42.3 }],
    }));
    const tickLabel = chart.options.scales.y.ticks.callback;

    assert.equal(tickLabel(42), '42°C');
    assert.equal(tickLabel(42.5), '42.5°C');
    assert.equal(tickLabel(42.300000000000004), '42.3°C');
    assert.equal(chart.options.scales.y.min, undefined);
    assert.equal(chart.options.scales.y.max, undefined);
    assert.equal(chart.data.datasets[0].data.length, 1);
    assert.equal(chart.data.datasets[0].data[0].x, '2026-09-26T12:00:00Z');
    assert.equal(chart.data.datasets[0].data[0].y, 42.3);
  });
});
