'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  servicePage, serviceCard, servicesGridFragment, pushedStatusSummary,
  withPushedStatus, PUSH_STATUS_STALE_MS,
} = require('../src/render/service-page');

describe('service-page XSS hardening', () => {
  // Snapshots from the discovery /health and self tiers bypass validateDescriptor,
  // so the renderer must independently refuse unsafe link schemes.
  it('never emits a javascript: href even if the snapshot carries one', () => {
    const snap = {
      service: 'evil', kind: 'http-service', status: 'pass', reachable: true, source: 'descriptor',
      fetchedAt: new Date(0).toISOString(),
      descriptor: {
        service: { name: 'evil', label: 'Evil' }, kind: 'http-service', status: 'pass',
        links: { repo: 'https://ok/x', xss: 'javascript:alert(document.cookie)' },
        metrics: [], panels: [],
      },
    };
    const html = servicePage('test', snap);
    assert.ok(!/javascript:/i.test(html), 'must not contain a javascript: scheme');
    assert.ok(html.includes('https://ok/x'), 'keeps the safe link');
    assert.ok(html.includes('rel="noopener noreferrer"'), 'adds rel hardening');
  });
});

describe('service-page plugin panels', () => {
  const inferenceSnap = {
    service: 'm5-gateway', kind: 'inference', status: 'pass', reachable: true, source: 'plugin',
    fetchedAt: new Date(0).toISOString(),
    descriptor: {
      service: { name: 'm5-gateway', label: 'M5 Inference' }, kind: 'inference', status: 'pass',
      metrics: [],
      panels: [
        { id: 'm5-models', plugin: 'inference', view: 'models', label: 'Models on the M5', refresh: 60, fullWidth: false },
        { id: 'm5-usage', plugin: 'inference', view: 'usage', label: 'Usage Metrics', refresh: 60, fullWidth: true },
      ],
      links: {},
    },
  };

  it('renders a registered plugin panel as a live HTMX fragment (not a placeholder)', () => {
    const html = servicePage('test', inferenceSnap);
    assert.ok(html.includes('hx-get="/api/plugins/inference/m5-gateway/m5-models"'), 'wires the fragment endpoint');
    assert.ok(html.includes('hx-trigger="load, every 60s"'), 'uses the panel refresh cadence');
    assert.ok(!/rendered by its plugin/.test(html), 'no placeholder for a registered plugin');
  });

  it('injects the plugin stylesheet once', () => {
    const html = servicePage('test', inferenceSnap);
    const matches = html.match(/\/css\/inference\.css/g) || [];
    assert.equal(matches.length, 1, 'inference.css linked exactly once for two inference panels');
  });

  it('falls back to a placeholder for an unknown plugin', () => {
    const snap = JSON.parse(JSON.stringify(inferenceSnap));
    snap.descriptor.panels = [{ id: 'x', plugin: 'ghost', label: 'Ghost' }];
    const html = servicePage('test', snap);
    assert.ok(/rendered by its plugin/.test(html), 'unknown plugin degrades gracefully');
    assert.ok(!/inference\.css/.test(html), 'no css injected for an unknown plugin');
  });
});

describe('service-page live metric values (#108)', () => {
  function snapWithMetrics(metrics) {
    return {
      service: 'ratatoskr', kind: 'http-service', status: 'pass', reachable: true, source: 'descriptor',
      fetchedAt: new Date(0).toISOString(),
      descriptor: {
        service: { name: 'ratatoskr', label: 'Ratatoskr' }, kind: 'http-service', status: 'pass',
        metrics, panels: [], links: {},
      },
    };
  }

  it('renders a live numeric value with its unit in the Metrics card', () => {
    const html = servicePage('test', snapWithMetrics([
      { key: 'triage_latency_ms', label: 'Triage Latency', unit: 'ms', value: 234.5 },
    ]));
    assert.ok(html.includes('Triage Latency'), 'shows the metric label');
    assert.ok(html.includes('234.5 ms'), 'renders the live value + unit');
  });

  it('renders a string value and a deterministic updated_at age', () => {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-07-05T10:03:00Z'); // 3m after the stamp below
    try {
      const html = servicePage('test', snapWithMetrics([
        { key: 'last_decision', label: 'Last Decision', value: 'offloaded', updated_at: '2026-07-05T10:00:00Z' },
      ]));
      assert.ok(html.includes('offloaded'), 'renders the string value');
      assert.ok(html.includes('(3m ago)'), 'renders the updated_at age');
    } finally {
      Date.now = realNow;
    }
  });

  it('escapes a descriptor-supplied metric value and unit (XSS guard)', () => {
    const html = servicePage('test', snapWithMetrics([
      { key: 'evil', label: 'Evil', unit: '<i>u</i>', value: '<script>alert(1)</script>' },
    ]));
    assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'raw script tag must not appear');
    assert.ok(!/<i>u<\/i>/.test(html), 'raw unit markup must not appear');
    assert.ok(html.includes('&lt;script&gt;'), 'value is HTML-escaped');
  });

  it('renders a falsy-but-valid value of 0 as a live reading (not the definition fallback)', () => {
    const html = servicePage('test', snapWithMetrics([
      { key: 'errors', label: 'Errors', unit: '', value: 0, warn: { gt: 5 } },
    ]));
    assert.ok(html.includes('<span class="metric-val">0</span>'), 'value 0 renders as the live reading');
    assert.ok(!/warn \{/.test(html), 'does not fall back to the threshold definition for a 0 value');
  });

  it('falls back to the definition display when a metric has no value', () => {
    const html = servicePage('test', snapWithMetrics([
      { key: 'defonly', label: 'Def Only', unit: 'ms' },
    ]));
    assert.ok(html.includes('Def Only'), 'still lists the metric');
  });
});

describe('service-page consolidation sub-view link', () => {
  function snapFor(name) {
    return {
      service: name, kind: 'mcp', status: 'pass', reachable: true, source: 'descriptor',
      fetchedAt: new Date(0).toISOString(),
      descriptor: {
        service: { name, label: name }, kind: 'mcp', status: 'pass',
        metrics: [], panels: [], links: {},
      },
    };
  }

  it('shows the Consolidation dashboard link on the munin-memory service page', () => {
    const html = servicePage('test', snapFor('munin-memory'));
    assert.ok(html.includes('href="/services/munin-memory/consolidation"'),
      'munin-memory must link to its consolidation sub-view');
  });

  it('does not show the Consolidation link on other services', () => {
    const html = servicePage('test', snapFor('some-other-service'));
    assert.ok(!html.includes('/services/munin-memory/consolidation'),
      'consolidation link must be scoped to munin-memory only');
  });
});

describe('service-page timer cards (#97)', () => {
  const timerSnap = (status, timer) => ({
    service: 'brokkr-maintenance-os', kind: 'timer', status, reachable: false, source: 'config',
    fetchedAt: '2026-07-02T00:00:00Z',
    descriptor: {
      service: { name: 'brokkr-maintenance-os', label: 'brokkr-maintenance-os' },
      kind: 'timer', status, metrics: [], panels: [], links: {}, timer,
    },
  });

  it('a passing timer shows a Passed badge and its last-run time, not "config only"', () => {
    const html = serviceCard(timerSnap('pass', { lastRun: '2026-07-02T03:00:00Z', nextRun: '2026-07-03T03:00:00Z', lastResult: 'ok' }));
    assert.ok(html.includes('Passed'), 'passing timer reads Passed');
    assert.ok(/ran /.test(html), 'footer shows when it last ran');
    assert.ok(!html.includes('config only'), 'no longer flat config-only');
  });

  it('a failed timer shows a Failed badge', () => {
    const html = serviceCard(timerSnap('fail', { lastRun: '2026-07-02T03:00:00Z', nextRun: null, lastResult: 'exit 1' }));
    assert.ok(html.includes('Failed'), 'failed timer reads Failed');
  });

  it('a never-run timer says it has not run — never "config only"/"unreachable"', () => {
    // CONTRACT CHANGE. "config only" beside `reachable: 0` and `status: pass`
    // read as a broken probe. A timer has no endpoint by design; the honest
    // statement is that no run has been recorded yet.
    const html = serviceCard(timerSnap(null, null));
    assert.ok(html.includes('not run yet'), 'footer states the real situation');
    assert.ok(!/unreachable/i.test(html), 'a timer is never "unreachable"');
  });

  it('the detail page shows a Schedule card with last run + result', () => {
    const html = servicePage('test', timerSnap('fail', { lastRun: '2026-07-02T03:00:00Z', nextRun: '2026-07-03T03:00:00Z', lastResult: 'exit 1' }));
    assert.ok(html.includes('Schedule'), 'detail page has a Schedule card');
    assert.ok(html.includes('Last run'), 'shows last-run row');
    assert.ok(html.includes('exit 1'), 'shows the failing exit result');
  });

  it('renders Next run as a future ETA ("in ..."), never "just now"', () => {
    // A far-future nextRun must not read as "just now" (formatAge bug for future ts).
    const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const html = servicePage('test', timerSnap('pass', { lastRun: '2026-07-02T03:00:00Z', nextRun: future, lastResult: 'ok' }));
    assert.ok(html.includes('Next run'), 'shows next-run row');
    assert.ok(/in \d+h/.test(html), 'next run is a forward-looking ETA');
    assert.ok(!/Next run[\s\S]{0,40}just now/.test(html), 'next run is not mislabelled "just now"');
  });
});

describe('service-page "checked never" regression (#97 secondary)', () => {
  it('a reachable service card shows a real "checked" age, never "checked never"', () => {
    // Simulate a raw hydrated DB row (snake_case fetched_at) to prove the
    // renderer no longer prints "checked never" for reachable services.
    const row = {
      service: 'munin-memory', kind: 'http-service', status: 'pass', reachable: 1, source: 'health',
      fetched_at: new Date(Date.now() - 5 * 60000).toISOString(),
      descriptor: { service: { name: 'munin-memory', label: 'Munin Memory' }, kind: 'http-service', status: 'pass', metrics: [], panels: [], links: {} },
    };
    const html = serviceCard(row);
    assert.ok(!/checked never/.test(html), 'must not say "checked never" for a reachable service');
    assert.ok(/checked .*ago/.test(html), 'shows a real relative age');
  });
});

describe('service-page pushed status truthfulness', () => {
  const configSnap = (name = 'mimir') => ({
    service: name, kind: 'static', status: null, reachable: false, source: 'config',
    descriptor: {
      service: { name, label: name }, kind: 'static', status: null,
      metrics: [], panels: [], links: {},
    },
  });
  const pushed = (kind, data, updated_at = Date.now()) => ({
    service: 'mimir', panel: `${kind}-panel`, kind, label: `${kind} panel`, data, updated_at,
  });

  it('uses the worst pushed status and freshest timestamp for an unprobed service', () => {
    const now = Date.parse('2026-07-13T11:00:00Z');
    const summary = pushedStatusSummary([
      pushed('status', { state: 'pass' }, Date.parse('2026-07-13T09:00:00Z')),
      pushed('status', { state: 'warn' }, Date.parse('2026-07-13T10:00:00Z')),
    ], now);
    assert.equal(summary.state, 'warn');
    assert.equal(summary.updatedAt, '2026-07-13T10:00:00.000Z');
    assert.equal(summary.statusUpdatedAt, '2026-07-13T10:00:00.000Z');
  });

  it('renders a pushed pass as healthy evidence instead of Unknown/config-only', () => {
    const html = servicePage('test', configSnap(), [pushed('status', { state: 'pass', message: 'backup current' })]);
    assert.ok(html.includes('status-badge is-ok'), 'header reflects pushed pass');
    assert.ok(html.includes('reported '), 'timestamp is labelled reported, not checked');
    assert.ok(html.includes('Status reported by pushed panels; no probe endpoint.'));
    assert.ok(!html.includes('Config-only (no live endpoint reached).'));
  });

  it('never lets a pushed pass mask a reachable failing probe', () => {
    const snap = configSnap('reachable');
    snap.kind = 'http-service';
    snap.reachable = true;
    snap.source = 'descriptor';
    snap.status = 'fail';
    snap.fetchedAt = '2026-07-13T10:00:00Z';
    snap.descriptor.kind = 'http-service';
    snap.descriptor.status = 'fail';
    const html = servicePage('test', snap, [pushed('status', { state: 'pass' })]);
    assert.ok(html.includes('status-badge is-crit'), 'probe failure remains authoritative');
  });

  it('does not render a stale pushed pass as current health', () => {
    const old = Date.now() - PUSH_STATUS_STALE_MS - 1000;
    const html = servicePage('test', configSnap(), [pushed('status', { state: 'pass' }, old)]);
    assert.ok(html.includes('status-badge is-stale'));
    assert.ok(html.includes('Last pushed status is stale; no probe endpoint.'));
  });

  it('preserves stale pushed-status evidence without treating it as current health', () => {
    const old = Date.now() - PUSH_STATUS_STALE_MS - 1000;
    const enriched = withPushedStatus(
      configSnap('stale-reporter'),
      [pushed('status', { state: 'pass' }, old)],
    );
    assert.equal(enriched.pushStatusStale, true);
    assert.equal(enriched.pushStatusUpdatedAt, new Date(old).toISOString());
    assert.equal(enriched.pushReported, undefined);
    assert.equal(enriched.status, null);

    const html = serviceCard(enriched);
    assert.ok(html.includes('status-badge is-stale'));
    assert.ok(html.includes('Stale report'));
    assert.ok(html.includes('(stale)'));
    assert.ok(!html.includes('>Pass<'), 'expired pass must not read as current health');
  });

  it('keeps status panels visible and collapses non-status supporting telemetry', () => {
    const html = servicePage('test', configSnap(), [
      pushed('status', { state: 'warn', message: 'needs attention' }),
      pushed('timeseries', { points: [{ t: 'a', y: 1 }, { t: 'b', y: 2 }] }),
      pushed('table', { rows: [{ model: 'm1' }] }),
    ]);
    assert.ok(html.includes('needs attention'));
    assert.ok(html.includes('Supporting telemetry (2)'));
    assert.ok(html.includes('<details class="supporting-panels col-full">'));
  });

  it('orders failed timers before healthy services and omits healthy cards in exception mode', () => {
    const failedTimer = {
      service: 'failed-timer', kind: 'timer', status: 'fail', reachable: false, source: 'config',
      descriptor: {
        service: { name: 'failed-timer', label: 'failed-timer' }, kind: 'timer', status: 'fail',
        timer: { lastRun: '2026-07-13T08:00:00Z', lastResult: 'exit 1' }, metrics: [], panels: [], links: {},
      },
    };
    const healthy = {
      service: 'healthy-http', kind: 'http-service', status: 'pass', reachable: true, source: 'descriptor',
      fetchedAt: '2026-07-13T10:00:00Z',
      descriptor: { service: { name: 'healthy-http', label: 'healthy-http' }, kind: 'http-service', status: 'pass', metrics: [], panels: [], links: {} },
    };
    const full = servicesGridFragment([healthy, failedTimer]);
    assert.ok(full.indexOf('failed-timer') < full.indexOf('healthy-http'));
    const exceptions = servicesGridFragment([healthy, failedTimer], { exceptionsOnly: true });
    assert.ok(exceptions.includes('failed-timer'));
    assert.ok(!exceptions.includes('healthy-http'));
  });

  it('exception mode includes stale reporters and unreachable live services, but not deliberate unknowns', () => {
    const stalePush = withPushedStatus(configSnap('stale-push'), [
      pushed('status', { state: 'pass' }, Date.now() - PUSH_STATUS_STALE_MS - 1000),
    ]);
    const unreachableLive = {
      service: 'unreachable-live', kind: 'http-service', status: null,
      reachable: false, source: 'health', error: 'unreachable',
      descriptor: {
        service: { name: 'unreachable-live', label: 'unreachable-live' },
        kind: 'http-service', status: null, metrics: [], panels: [], links: {},
      },
    };
    const configOnly = configSnap('config-only-static');
    const neverRun = {
      service: 'never-run', kind: 'timer', status: null, reachable: false, source: 'config',
      descriptor: {
        service: { name: 'never-run', label: 'never-run' },
        kind: 'timer', status: null, timer: null, metrics: [], panels: [], links: {},
      },
    };

    const html = servicesGridFragment(
      [configOnly, neverRun, unreachableLive, stalePush],
      { exceptionsOnly: true },
    );
    assert.ok(html.includes('stale-push'));
    assert.ok(html.includes('Stale report'));
    assert.ok(html.includes('unreachable-live'));
    assert.ok(html.includes('Unreachable'));
    assert.ok(!html.includes('config-only-static'));
    assert.ok(!html.includes('never-run'));
  });
});
