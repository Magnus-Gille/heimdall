'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const M5 = require('../src/m5');
const { getPlugin, listPlugins } = require('../src/plugins');
const {
  renderPanel, buildM5Descriptor, m5Snapshot, viewOf, M5_PANELS,
} = require('../src/plugins/inference');

// Build a fake m5 module: real pure helpers, overridable fetchers (fetchLedger
// has no _fetch seam, so the data layer is swapped here rather than at fetch).
function fakeM5(overrides = {}) {
  return { ...M5, ...overrides };
}
const DESCRIPTOR = { service: { instance_id: 'm5' }, links: { ledger: 'http://m5.local:8080/ledger' } };

describe('inference plugin registry', () => {
  it('resolves the inference plugin and exposes its css', () => {
    const p = getPlugin('inference');
    assert.ok(p);
    assert.equal(p.name, 'inference');
    assert.equal(p.css, '/css/inference.css');
    assert.equal(typeof p.renderPanel, 'function');
  });

  it('returns null for unknown / invalid plugin names', () => {
    assert.equal(getPlugin('nope'), null);
    assert.equal(getPlugin(''), null);
    assert.equal(getPlugin(null), null);
    assert.ok(listPlugins().some((p) => p.name === 'inference'));
  });
});

describe('inference plugin — descriptor & snapshot', () => {
  it('builds the M5 descriptor with only the two first-principles panels', () => {
    const d = buildM5Descriptor({ gatewayUrl: 'http://m5.local:8080/', status: 'pass' });
    assert.equal(d.kind, 'inference');
    assert.equal(d.service.name, 'm5-gateway');
    assert.equal(d.service.instance_id, 'm5');
    assert.equal(d.status, 'pass');
    assert.equal(d.panels.length, 2);
    assert.deepEqual(d.panels.map((p) => p.view), ['overview', 'models']);
    assert.ok(d.panels.every((p) => p.plugin === 'inference' && typeof p.view === 'string'));
    // trailing slash on the base must not double up in the link
    assert.equal(d.links.ledger, 'http://m5.local:8080/ledger');
    assert.equal(d.links.health, 'http://m5.local:8080/healthz');
    assert.equal(d.links.metrics, 'http://m5.local:8080/metrics');
    assert.equal(d.links.operations, 'http://m5.local:8080/ops/summary');
  });

  it('m5Snapshot derives status from the collected inference_healthy metric', () => {
    const getLatestMetrics = () => [{ metric: 'inference_healthy', value: 1 }];
    const snap = m5Snapshot({}, { getLatestMetrics, now: 0 });
    assert.equal(snap.service, 'm5-gateway');
    assert.equal(snap.kind, 'inference');
    assert.equal(snap.status, 'pass');
    assert.equal(snap.reachable, true);
    assert.equal(snap.source, 'plugin');
    assert.equal(snap.descriptor.panels.length, 2);
  });

  it('m5Snapshot reports unreachable / null status before any metric exists', () => {
    const snap = m5Snapshot({}, { getLatestMetrics: () => [], now: 0 });
    assert.equal(snap.status, null);
    assert.equal(snap.reachable, false);
    assert.ok(/no inference metrics/.test(snap.error));
  });

  it('m5Snapshot maps inference_healthy=0 to fail', () => {
    const snap = m5Snapshot({}, { getLatestMetrics: () => [{ metric: 'inference_healthy', value: 0 }], now: 0 });
    assert.equal(snap.status, 'fail');
    assert.equal(snap.reachable, true);
  });

  it('viewOf prefers explicit view, falls back to the m5- id prefix', () => {
    assert.equal(viewOf({ view: 'usage', id: 'm5-usage' }), 'usage');
    assert.equal(viewOf({ id: 'm5-capability-map' }), 'capability-map');
    assert.equal(viewOf({}), null);
  });
});

describe('inference plugin — minimal operator view', () => {
  const panel = (view) => M5_PANELS.find((p) => p.view === view);

  it('overview: shows live state and the three basic usage answers', async () => {
    const m5 = fakeM5({
      fetchHealth: async () => ({ ok: true }),
      fetchOperations: async () => ({ summary: {
        generatedAt: '2026-08-17T12:00:00.000Z', activeRequests: 1,
        lastUsedAt: '2026-08-17T11:55:00.000Z',
        last24Hours: { requests: 3, requestTimeMs: 125_000 },
        last7Days: { requests: 9, requestTimeMs: 500_000 },
        daily: [
          { date: '2026-08-17', requests: 3, requestTimeMs: 125_000 },
          { date: '2026-08-16', requests: 0, requestTimeMs: 0 },
        ],
      } }),
    });
    const html = await renderPanel(panel('overview'), { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('Online'));
    assert.ok(html.includes('1 request running'));
    assert.ok(html.includes('3'));
    assert.ok(html.includes('2m 5s'));
    assert.ok(html.includes('5m ago'));
    assert.ok(html.indexOf('2026-08-17') < html.indexOf('2026-08-16'), 'newest day renders first');
    assert.ok(html.includes('No activity'), 'zero days are explicit rather than looking like missing data');
  });

  it('overview: keeps live health separate from usage-data availability', async () => {
    const m5 = fakeM5({
      fetchHealth: async () => ({ ok: true }),
      fetchOperations: async () => ({ error: 'operations HTTP 503' }),
    });
    const html = await renderPanel(panel('overview'), { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('Online'));
    assert.ok(html.includes('Usage data unavailable'));
    assert.ok(html.includes('503'));
  });

  it('models: success path renders the model list', async () => {
    const m5 = fakeM5({ fetchModels: async () => ({ models: [{ key: 'mellum', loaded: true, displayName: 'Mellum' }] }) });
    const html = await renderPanel(panel('models'), { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('<h3>Models</h3>'));
    assert.ok(html.includes('Mellum'));
    assert.ok(html.includes('Loaded now'));
  });

  it('models: error path renders a graceful note', async () => {
    const m5 = fakeM5({ fetchModels: async () => ({ error: 'models HTTP 403' }) });
    const html = await renderPanel(panel('models'), { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('<h3>Models</h3>'));
    assert.ok(html.includes('403'));
    assert.ok(/unavailable/i.test(html));
  });

  it('capability-map: builds the matrix from a live ledger', async () => {
    const report = [{ taskType: 'classify', modelId: 'mellum', verdict: 'viable', successRate: 0.9, avgTokPerSec: 138, attempts: 5 }];
    const m5 = fakeM5({ fetchLedger: async () => ({ report, recent: [] }) });
    const html = await renderPanel({ view: 'capability-map' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('Capability Map'));
    assert.ok(html.includes('classify'));
    assert.ok(html.includes('90%'));
  });

  it('capability-map: ledger error renders the unavailable note', async () => {
    const m5 = fakeM5({ fetchLedger: async () => ({ error: 'ledger HTTP 403' }) });
    const html = await renderPanel({ view: 'capability-map' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(/Ledger unavailable/.test(html));
    assert.ok(html.includes('403'));
  });

  it('findings: ledger up but generation null → static findings only', async () => {
    const m5 = fakeM5({
      fetchLedger: async () => ({ report: [{ verdict: 'viable' }, { verdict: 'not_viable' }], recent: [] }),
      generateFindings: async () => null,
    });
    const html = await renderPanel({ view: 'findings', label: 'What We Learned' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('What We Learned'));
    assert.ok(html.includes('fast workhorse')); // a STATIC_FINDINGS bullet
    assert.ok(/unavailable/i.test(html)); // generated-empty footer
  });

  it('usage: parses Prometheus text into the usage card', async () => {
    const text = [
      '# HELP homeserver_requests_total requests',
      'homeserver_requests_total{model="mellum",outcome="ok"} 5',
      'homeserver_tokens_total{model="mellum",direction="prompt"} 100',
      'homeserver_tokens_total{model="mellum",direction="completion"} 50',
    ].join('\n');
    const m5 = fakeM5({ fetchMetrics: async () => ({ text }) });
    const html = await renderPanel({ view: 'usage', label: 'Usage Metrics' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('Usage Metrics'));
    assert.ok(html.includes('mellum'));
  });

  it('usage: malformed body (parse errors, no samples) → malformed note', async () => {
    const m5 = fakeM5({ fetchMetrics: async () => ({ text: '<html>proxy error</html>' }) });
    const html = await renderPanel({ view: 'usage', label: 'Usage Metrics' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(html.includes('metrics malformed'));
  });

  it('routing: no snapshot file → derives a hint from the live ledger', async () => {
    const report = [{ taskType: 'classify', modelId: 'mellum', verdict: 'viable', successRate: 0.9, avgTokPerSec: 138 }];
    const m5 = fakeM5({ fetchLedger: async () => ({ report, recent: [] }) });
    const html = await renderPanel({ view: 'routing' }, { m5, descriptor: DESCRIPTOR, env: {} });
    assert.ok(/Routing/.test(html));
    assert.ok(html.includes('classify'));
    assert.ok(html.includes('delegate-local'));
  });

  it('routing: reads a snapshot file when M5_ROUTING_JSON_PATH points at one', async () => {
    const snapshot = { globalRule: 'escalate SQL', modelProfiles: {}, routing: { classify: { verdict: 'delegate-local', model: 'mellum', passRate: 0.9 } } };
    const fs = { existsSync: () => true, readFileSync: () => JSON.stringify(snapshot) };
    const html = await renderPanel({ view: 'routing' }, { descriptor: DESCRIPTOR, env: { M5_ROUTING_JSON_PATH: '/x/routing.json' }, fs });
    assert.ok(html.includes('Routing Plan'));
    assert.ok(html.includes('escalate SQL'));
  });

  it('unknown view degrades to a labelled note (never throws)', async () => {
    const html = await renderPanel({ id: 'mystery', view: 'nope', label: 'Mystery' }, { descriptor: DESCRIPTOR });
    assert.ok(html.includes('Mystery'));
    assert.ok(/No inference renderer/.test(html));
  });

  it('never emits an unescaped script even if the ledger carries one', async () => {
    const report = [{ taskType: '<script>alert(1)</script>', modelId: 'mellum', verdict: 'viable', successRate: 0.5 }];
    const m5 = fakeM5({ fetchLedger: async () => ({ report, recent: [] }) });
    const html = await renderPanel({ view: 'capability-map' }, { m5, descriptor: DESCRIPTOR });
    assert.ok(!/<script>alert/.test(html), 'task type must be escaped');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('never derives the authenticated fetch base from descriptor links (SSRF / token-leak guard)', async () => {
    // The gateway fetch carries the M5 bearer token; a network descriptor must not be able to
    // redirect it. The base must come from trusted server config, not descriptor.links.
    let calledBase = 'UNSET';
    const m5 = fakeM5({ fetchModels: async (base) => { calledBase = base; return { models: [] }; } });
    const evil = { service: { instance_id: 'm5' }, links: { ledger: 'http://attacker.example/ledger' } };
    await renderPanel(panel('models'), { m5, descriptor: evil }); // no deps.gatewayUrl → trusted env default
    assert.ok(!String(calledBase).includes('attacker.example'), 'descriptor links must not set the fetch base');
    // and an explicit trusted override IS honoured (the only allowed source)
    await renderPanel(panel('models'), { m5, descriptor: evil, gatewayUrl: 'http://trusted:8080' });
    assert.equal(calledBase, 'http://trusted:8080');
  });
});
