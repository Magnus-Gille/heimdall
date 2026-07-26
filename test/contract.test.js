'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateDescriptor, statusToState, ARCHETYPES, isSafeHref, normalizeLinks } = require('../src/contract/schema');
const { MAX_ROWS, MAX_COLS, MAX_POINTS, MAX_CELL } = require('../src/contract/panel-data');

describe('contract.validateDescriptor', () => {
  it('accepts a full valid descriptor and normalizes it', () => {
    const r = validateDescriptor({
      _schema: 'https://monitor.example.com/schema/service/v1',
      service: { name: 'm5-gateway', label: 'M5 Inference', criticality: 'high' },
      kind: 'inference',
      status: 'pass',
      version: '1.4.2',
      deploy: { deployed_commit: 'abc1234', latest_commit: 'def5678', drift: 2 },
      metrics: [{ key: 'inference_latency_ms', label: 'Latency', unit: 'ms', chart: true }],
      panels: [{ id: 'm5-models', plugin: 'inference', source: '/models', refresh: 60 }],
      links: { health: 'http://x/healthz', repo: 'https://github.com/x/y' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.service.label, 'M5 Inference');
    assert.equal(r.value.kind, 'inference');
    assert.equal(r.value.version, '1.4.2');
    assert.equal(r.value.deploy.drift, 2);
    assert.equal(r.value.metrics[0].chart, true);
    assert.equal(r.value.panels[0].plugin, 'inference');
  });

  it('carries a panel `view` through normalization (and nulls it when absent)', () => {
    const r = validateDescriptor({
      service: { name: 'a' }, kind: 'inference',
      panels: [
        { id: 'm5-capability-map', plugin: 'inference', view: 'capability-map', source: '/ledger', fullWidth: true },
        { id: 'plain', plugin: 'inference' },
      ],
    });
    assert.equal(r.value.panels[0].view, 'capability-map');
    assert.equal(r.value.panels[0].fullWidth, true);
    assert.equal(r.value.panels[1].view, null);
  });

  it('hard-fails when service.name is missing', () => {
    assert.equal(validateDescriptor({ kind: 'http-service' }).ok, false);
    assert.equal(validateDescriptor({ service: {} }).ok, false);
  });

  it('hard-fails on a non-object', () => {
    assert.equal(validateDescriptor(null).ok, false);
    assert.equal(validateDescriptor([]).ok, false);
    assert.equal(validateDescriptor('x').ok, false);
  });

  it('defaults an unknown kind to http-service with a warning', () => {
    const r = validateDescriptor({ service: { name: 'a' }, kind: 'weird' });
    assert.equal(r.ok, true);
    assert.equal(r.value.kind, 'http-service');
    assert.ok(r.warnings.some((w) => /unknown kind/.test(w)));
  });

  it('nulls an unknown status and warns; accepts pass/warn/fail', () => {
    assert.equal(validateDescriptor({ service: { name: 'a' }, status: 'bogus' }).value.status, null);
    assert.equal(validateDescriptor({ service: { name: 'a' }, status: 'warn' }).value.status, 'warn');
  });

  it('coerces a numeric version and ignores a non-array metrics field', () => {
    const r = validateDescriptor({ service: { name: 'a' }, version: 7, metrics: 'nope' });
    assert.equal(r.value.version, '7');
    assert.deepEqual(r.value.metrics, []);
    assert.ok(r.warnings.some((w) => /metrics must be an array/.test(w)));
  });

  it('preserves an optional live `value` (+updated_at) on descriptor metrics (#108)', () => {
    const r = validateDescriptor({
      service: { name: 'ratatoskr' },
      metrics: [
        { key: 'triage_latency_ms', label: 'Latency', unit: 'ms', value: 234.5, updated_at: '2026-07-05T10:00:00Z' },
        { key: 'decisions', label: 'Decisions', value: 'offloaded' },
      ],
    });
    assert.equal(r.value.metrics[0].value, 234.5);
    assert.equal(r.value.metrics[0].updated_at, '2026-07-05T10:00:00Z');
    assert.equal(r.value.metrics[1].value, 'offloaded');
    assert.equal(r.value.metrics[1].updated_at, null);
  });

  it('rejects an invalid or oversized updated_at on a metric (#108)', () => {
    const r = validateDescriptor({
      service: { name: 'a' },
      metrics: [
        { key: 'a', value: 1, updated_at: 'not-a-date' },
        { key: 'b', value: 2, updated_at: 'x'.repeat(100) },
        { key: 'c', value: 3, updated_at: '2026-07-05T10:00:00Z' },
      ],
    });
    assert.equal(r.value.metrics[0].updated_at, null, 'unparseable string → null');
    assert.equal(r.value.metrics[1].updated_at, null, 'oversized string → null');
    assert.equal(r.value.metrics[2].updated_at, '2026-07-05T10:00:00Z', 'valid ISO preserved');
  });

  it('nulls a non-scalar metric value and caps a huge string value (#108)', () => {
    const r = validateDescriptor({
      service: { name: 'a' },
      metrics: [
        { key: 'bad', value: { nested: 'obj' } },
        { key: 'noval', label: 'No value' },
        { key: 'big', value: 'x'.repeat(5000) },
      ],
    });
    assert.equal(r.value.metrics[0].value, null);
    assert.equal(r.value.metrics[1].value, null);
    assert.ok(r.value.metrics[2].value.length <= 500, 'huge string value is clamped');
  });

  it('flags an unrecognized schema but still renders', () => {
    const r = validateDescriptor({ _schema: 'https://other/v9', service: { name: 'a' } });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /unrecognized _schema/.test(w)));
  });

  it('statusToState maps pass/warn/fail and unknown→stale', () => {
    assert.equal(statusToState('pass'), 'ok');
    assert.equal(statusToState('warn'), 'warn');
    assert.equal(statusToState('fail'), 'crit');
    assert.equal(statusToState(null), 'stale');
  });

  it('exposes the five archetypes', () => {
    assert.deepEqual(ARCHETYPES, ['inference', 'http-service', 'timer', 'static', 'mcp']);
  });

  it('isSafeHref allows http(s) + root-relative, blocks javascript:/data:/protocol-relative', () => {
    assert.equal(isSafeHref('https://github.com/x'), true);
    assert.equal(isSafeHref('http://localhost:3030/health'), true);
    assert.equal(isSafeHref('/heimdall.json'), true);
    assert.equal(isSafeHref('javascript:alert(1)'), false);
    assert.equal(isSafeHref('JaVaScRiPt:alert(1)'), false);
    assert.equal(isSafeHref('data:text/html,<script>'), false);
    assert.equal(isSafeHref('//evil.example.com'), false);
    assert.equal(isSafeHref(''), false);
    assert.equal(isSafeHref(42), false);
  });

  it('normalizeLinks strips unsafe URLs, keeps safe ones', () => {
    const out = normalizeLinks({ repo: 'https://github.com/x', self: '/heimdall.json', xss: 'javascript:alert(1)', off: '//evil.com' });
    assert.deepEqual(out, { repo: 'https://github.com/x', self: '/heimdall.json' });
  });

  it('validateDescriptor drops a javascript: link at normalization (XSS guard)', () => {
    const r = validateDescriptor({ service: { name: 'a' }, links: { repo: 'https://ok/x', evil: 'javascript:alert(1)' } });
    assert.equal(r.ok, true);
    assert.equal(r.value.links.repo, 'https://ok/x');
    assert.equal('evil' in r.value.links, false);
  });
});

// ─── Pull-path panel cap (normalizePanels via validateDescriptor) ─────────────

describe('contract.normalizePanels — pull-path cap (Fix 1)', () => {
  it('caps oversized inline timeseries points before storage', () => {
    const points = Array.from({ length: MAX_POINTS + 100 }, (_, i) => ({ t: String(i), y: i }));
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'ts-panel', kind: 'timeseries', points }],
    });
    assert.equal(r.ok, true);
    const p = r.value.panels[0];
    assert.ok(p.points.length <= MAX_POINTS, `expected ≤${MAX_POINTS} points, got ${p.points ? p.points.length : 'undefined'}`);
    assert.ok(r.warnings.some((w) => w.includes('points capped')), 'expected a cap warning');
  });

  it('caps oversized inline table rows and cols before storage', () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ a: String(i) }));
    const cols = Array.from({ length: MAX_COLS + 5 }, (_, i) => `c${i}`);
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'tbl-panel', kind: 'table', rows, cols }],
    });
    assert.equal(r.ok, true);
    const p = r.value.panels[0];
    assert.ok(p.rows.length <= MAX_ROWS, `rows not capped: ${p.rows && p.rows.length}`);
    assert.ok(p.cols.length <= MAX_COLS, `cols not capped: ${p.cols && p.cols.length}`);
  });

  it('caps oversized status message before storage', () => {
    const message = 'x'.repeat(MAX_CELL + 200);
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'st-panel', kind: 'status', state: 'warn', message }],
    });
    assert.equal(r.ok, true);
    const p = r.value.panels[0];
    assert.ok(p.message.length <= MAX_CELL, `message not capped: ${p.message && p.message.length}`);
  });

  it('caps unit to MAX_UNIT on inline typed panel', () => {
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'stat-panel', kind: 'stat', value: 42, unit: 'x'.repeat(100) }],
    });
    assert.equal(r.ok, true);
    assert.ok(r.value.panels[0].unit.length <= 40);
  });

  it('passes through a small well-formed inline stat panel unchanged', () => {
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'stat-panel', kind: 'stat', value: 42, unit: 'ms', delta: { value: -1, dir: 'down' } }],
    });
    assert.equal(r.ok, true);
    const p = r.value.panels[0];
    assert.equal(p.value, 42);
    assert.deepEqual(p.delta, { value: -1, dir: 'down' });
    assert.equal(p.unit, 'ms');
  });

  it('plugin panels (no kind) pass through normalizePanels without modification', () => {
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'plugin-panel', plugin: 'inference', source: '/ledger', refresh: 60 }],
    });
    assert.equal(r.ok, true);
    const p = r.value.panels[0];
    assert.equal(p.plugin, 'inference');
    assert.equal(p.kind, undefined);
  });

  it('caps an over-long panel label with a panel-scoped warning (LOW fix)', () => {
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: 'p1', kind: 'stat', value: 1, label: 'L'.repeat(300) }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.panels[0].label.length, 120);
    assert.ok(r.warnings.some((w) => w.includes('p1') && w.includes('label truncated')));
  });

  it('exposes discarded non-object table rows through a content-blind panel warning (#40)', () => {
    const secret = 'do-not-leak-this-row-value';
    const r = validateDescriptor({
      service: { name: 'producer' },
      panels: [{ id: 'queue', kind: 'table', rows: [{ task: 'kept' }, [secret, 'other']] }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.panels[0].rows, [{ task: 'kept' }], 'valid object row remains compatible');
    assert.deepEqual(r.value.panel_warnings, [{ panel: 'queue', reason: 'non_object_table_rows_discarded', count: 1 }]);
    assert.ok(r.warnings.some((warning) => warning.includes('queue') && warning.includes('non-object table row')));
    assert.doesNotMatch(JSON.stringify(r.value.panel_warnings), new RegExp(secret));
  });

  it('caps the p.id-as-label fallback when id is over-long (LOW fix)', () => {
    // ids are normally short, but normalizePanels does not enforce the ingest
    // charset, so an over-long id used as the label fallback must still be bounded.
    const longId = 'i'.repeat(300);
    const r = validateDescriptor({
      service: { name: 'svc' },
      panels: [{ id: longId, kind: 'stat', value: 1 }], // no label → falls back to id
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.panels[0].label.length, 120);
  });
});
