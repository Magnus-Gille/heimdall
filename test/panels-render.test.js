'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderTypedPanel } = require('../src/render/panels');

describe('renderTypedPanel — kinds', () => {
  it('stat renders the value, unit and an up delta', () => {
    const html = renderTypedPanel({ panel: 's', kind: 'stat', label: 'Reqs', value: 42, unit: 'rps', delta: { value: 3, dir: 'up' } });
    assert.ok(html.includes('42'));
    assert.ok(html.includes('rps'));
    assert.ok(html.includes('panel-delta is-up'));
    assert.ok(html.includes('▲'));
  });

  it('timeseries renders an inline svg sparkline + latest', () => {
    const html = renderTypedPanel({
      panel: 'ts', kind: 'timeseries', label: 'Trend', unit: 'percent',
      points: [{ t: 'a', y: 1 }, { t: 'b', y: 5 }, { t: 'c', y: 3 }],
      summary: { latest: 3, window: '24h', n: 10 },
    });
    assert.ok(html.includes('<svg'));
    assert.ok(html.includes('latest 3'));
    assert.ok(html.includes('window 24h'));
  });

  it('table renders headers (col union) and rows', () => {
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows: [{ a: 1, b: 2 }, { a: 3, c: 4 }] });
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('<th>a</th>'));
    assert.ok(html.includes('<th>b</th>'));
    assert.ok(html.includes('<th>c</th>'));
    assert.ok(html.includes('<td>1</td>'));
  });

  it('status renders a pill + message', () => {
    const html = renderTypedPanel({ panel: 'st', kind: 'status', label: 'Gate', state: 'fail', message: 'queue stalled' });
    assert.ok(html.includes('status-badge is-crit'));
    assert.ok(html.includes('queue stalled'));
  });

  it('renders a nested detail table beneath the main panel', () => {
    const html = renderTypedPanel({
      panel: 'ts', kind: 'timeseries', label: 'T',
      points: [{ t: 'a', y: 1 }, { t: 'b', y: 2 }],
      detail: { kind: 'table', rows: [{ model: 'm1', n: 7 }] },
    });
    assert.ok(html.includes('panel-detail'));
    assert.ok(html.includes('m1'));
  });

  it('unknown kind renders a placeholder, not a throw', () => {
    const html = renderTypedPanel({ panel: 'x', kind: 'pie', label: 'X' });
    assert.ok(html.includes('unsupported panel kind'));
  });

  it('timeseries renders extra scalar summary fields (#87)', () => {
    const html = renderTypedPanel({
      panel: 'ts', kind: 'timeseries', label: 'Trend',
      points: [{ t: 'a', y: 1 }, { t: 'b', y: 5 }],
      summary: { latest: 3, window: '24h', n: 6, lowSample: true, source: 'gille-inference' },
    });
    // boolean flag surfaced (key + yes/no), string extra surfaced (key + value)
    assert.ok(html.includes('lowSample'), 'boolean extra key shown');
    assert.ok(/lowSample[^<]*yes/i.test(html), 'boolean value shown');
    assert.ok(html.includes('source'), 'string extra key shown');
    assert.ok(html.includes('gille-inference'), 'string extra value shown');
  });

  it('timeseries escapes extra summary keys and values (XSS guard)', () => {
    const html = renderTypedPanel({
      panel: 'ts', kind: 'timeseries', label: 'T',
      points: [{ t: 'a', y: 1 }, { t: 'b', y: 2 }],
      summary: { latest: 1, '<x>': '<img src=x onerror=alert(1)>' },
    });
    assert.ok(!html.includes('<img src=x'), 'raw HTML value must be escaped');
    assert.ok(!html.includes('<x>'), 'raw HTML key must be escaped');
    // Assert the escaped form is PRESENT — proves the field was escaped-and-shown,
    // not merely dropped (a drop would also satisfy the absence checks above).
    assert.ok(html.includes('&lt;img src=x'), 'value rendered in escaped form');
    assert.ok(html.includes('&lt;x&gt;'), 'key rendered in escaped form');
  });
});

describe('renderTypedPanel — DoS amplification guards', () => {
  it('table: more than 20 distinct keys → only ≤20 columns rendered', () => {
    // Build one row with 30 distinct keys.
    const row = {};
    for (let i = 0; i < 30; i++) row[`col${i}`] = `v${i}`;
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows: [row] });
    assert.ok(html.includes('<table'));
    const thCount = (html.match(/<th>/g) || []).length;
    assert.ok(thCount <= 20, `expected ≤20 <th>, got ${thCount}`);
  });

  it('table: more than 200 rows → only ≤200 rows rendered', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ n: i }));
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows });
    const tdCount = (html.match(/<td>/g) || []).length;
    assert.ok(tdCount <= 200, `expected ≤200 data rows, got ${tdCount}`);
  });

  it('table: more than 12 rows collapses the supporting rows by default', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows });
    assert.ok(html.includes('panel-table-more'));
    assert.ok(html.includes('Show 8 more rows'));
  });

  it('table: oversized cell value is truncated to 500 chars', () => {
    const big = 'x'.repeat(600);
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows: [{ a: big }] });
    // The rendered cell must not contain 600 x's — must be truncated.
    assert.ok(!html.includes('x'.repeat(501)), 'cell must be truncated to ≤500 chars');
    assert.ok(html.includes('x'.repeat(500)), 'first 500 chars must still be present');
  });

  it('table: non-string cell (object) is JSON-stringified and truncated', () => {
    const big = { data: 'y'.repeat(600) };
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows: [{ a: big }] });
    assert.ok(!html.includes('y'.repeat(501)), 'JSON-stringified object must be truncated to ≤500 chars');
  });

  it('table: pull-path — render caps apply even when data did NOT go through ingest', () => {
    // Simulate a descriptor-inline (pull) panel with 25 cols and 210 rows.
    const row = {};
    for (let i = 0; i < 25; i++) row[`k${i}`] = `v${i}`;
    const rows = Array.from({ length: 210 }, () => ({ ...row }));
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'Pull', rows });
    const headerRows = [...html.matchAll(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/g)];
    const thCounts = headerRows.map((m) => (m[1].match(/<th>/g) || []).length);
    const trCount = (html.match(/<tr>/g) || []).length - (html.match(/<thead>/g) || []).length;
    assert.ok(thCounts.every((n) => n <= 20), `pull-path: expected ≤20 cols/table, got ${thCounts}`);
    assert.ok(trCount <= 200, `pull-path: expected ≤200 rows, got ${trCount}`);
  });

  it('timeseries: more than 500 points → sparkline built from last 500 only', () => {
    // With only 1 point the sparkline falls back to "not enough points". Give >500 so
    // render must cap — verify we get a sparkline (≥2 valid points after capping).
    const points = Array.from({ length: 600 }, (_, i) => ({ t: String(i), y: i % 10 }));
    const html = renderTypedPanel({ panel: 'ts', kind: 'timeseries', label: 'T', points });
    assert.ok(html.includes('<svg'), 'sparkline SVG must be present after capping to 500');
  });
});

describe('renderTypedPanel — XSS escaping', () => {
  it('escapes a <script> / quote in the label', () => {
    const html = renderTypedPanel({ panel: 'p', kind: 'stat', label: '<script>alert("x")</script>', value: 1 });
    assert.ok(!html.includes('<script>'), 'raw <script> must not appear');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes hostile content in table cells and status message', () => {
    const tbl = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', rows: [{ name: '<img src=x onerror=alert(1)>' }] });
    assert.ok(!tbl.includes('<img src=x'), 'raw <img> must not appear in a cell');
    assert.ok(tbl.includes('&lt;img'));

    const st = renderTypedPanel({ panel: 's', kind: 'status', label: 'S', state: 'warn', message: '"><script>bad()</script>' });
    assert.ok(!st.includes('<script>bad'), 'raw script in message must be escaped');
    assert.ok(st.includes('&lt;script&gt;'));
  });

  it('escapes a hostile table column header', () => {
    const html = renderTypedPanel({ panel: 't', kind: 'table', label: 'T', cols: ['<b>x</b>'], rows: [{ '<b>x</b>': 'v' }] });
    assert.ok(!html.includes('<th><b>x</b></th>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });
});
