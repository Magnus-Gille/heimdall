'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { buildApp } = require('../src/server');
const { openDatabase, getPanelsForService, countPanelsForService } = require('../src/db');
const { validatePanel, MAX_TOTAL_PANELS, MAX_PANEL_SERVICES } = require('../src/panel-ingest');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-panels-'));
  return openDatabase(path.join(dir, 'test.db'));
}

const EXAMPLE = {
  service: 'm5-inference', panel: 'offloadability', kind: 'timeseries',
  label: 'Offloadability — nightly gate fire-rate', unit: 'percent',
  points: [{ t: '2026-06-26', y: 3.5 }, { t: '2026-06-27', y: 1.7 }],
  summary: { latest: 1.7, window: '24h', n: 60 },
  detail: { kind: 'table', rows: [{ model: 'qwen3-30b-instruct', disagree: '0/52' }, { model: 'gpt-oss-120b', disagree: '0/5' }] },
};

// --- validatePanel (pure) ---
describe('validatePanel', () => {
  it('accepts the canonical timeseries-with-detail example', () => {
    const r = validatePanel(EXAMPLE);
    assert.equal(r.ok, true);
    assert.equal(r.value.kind, 'timeseries');
    assert.equal(r.value.data.points.length, 2);
    assert.equal(r.value.data.detail.kind, 'table');
    assert.equal(r.value.data.detail.rows.length, 2);
  });

  it('rejects bad service/panel id charset', () => {
    assert.equal(validatePanel({ service: 'Bad Service', panel: 'p', kind: 'status', state: 'pass' }).ok, false);
    assert.equal(validatePanel({ service: 'svc', panel: 'Bad_Panel', kind: 'status', state: 'pass' }).ok, false);
  });

  it('rejects unknown kind', () => {
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'pie' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('unknown kind')));
  });

  it('rejects missing required kind-data', () => {
    assert.equal(validatePanel({ service: 'svc', panel: 'p', kind: 'stat' }).ok, false); // no value
    assert.equal(validatePanel({ service: 'svc', panel: 'p', kind: 'timeseries', points: [] }).ok, false);
    assert.equal(validatePanel({ service: 'svc', panel: 'p', kind: 'table' }).ok, false); // no rows
    assert.equal(validatePanel({ service: 'svc', panel: 'p', kind: 'status', state: 'bogus' }).ok, false);
  });

  it('truncates a too-long label (guardrail, with warning)', () => {
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'stat', value: 1, label: 'x'.repeat(300) });
    assert.equal(r.ok, true);
    assert.equal(r.value.label.length, 120);
    assert.ok(r.warnings.some((w) => w.includes('label truncated')));
  });

  it('caps timeseries points to last 500 (guardrail, with warning)', () => {
    const points = Array.from({ length: 600 }, (_, i) => ({ t: String(i), y: i }));
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'timeseries', points });
    assert.equal(r.ok, true);
    assert.equal(r.value.data.points.length, 500);
    assert.equal(r.value.data.points[0].y, 100); // last 500 kept
    assert.ok(r.warnings.some((w) => w.includes('points capped')));
  });

  it('does NOT duplicate timeseries point warnings on success (LOW fix)', () => {
    // Mix of valid + invalid points: normPoints emits a "dropped" warning.
    // The preliminary emptiness check must not double-count it.
    const points = [{ t: 'a', y: 1 }, { t: 'b' }, { y: 2 }, null];
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'timeseries', points });
    assert.equal(r.ok, true);
    const dropWarnings = r.warnings.filter((w) => w.includes('dropped') && w.includes('timeseries point'));
    assert.equal(dropWarnings.length, 1, `expected exactly one dropped-points warning, got ${dropWarnings.length}: ${JSON.stringify(r.warnings)}`);
  });

  it('caps table rows to 200 and cols to 20 (guardrails)', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ a: i }));
    const cols = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'table', rows, cols });
    assert.equal(r.ok, true);
    assert.equal(r.value.data.rows.length, 200);
    assert.equal(r.value.data.cols.length, 20);
  });

  it('reports discarded non-object table rows without echoing their contents (#40)', () => {
    const secret = 'discarded-row-payload-must-not-echo';
    const r = validatePanel({ service: 'svc', panel: 'queue', kind: 'table', rows: [{ task: 'kept' }, [secret]] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.data.rows, [{ task: 'kept' }]);
    assert.ok(r.warnings.some((warning) => warning.includes('non-object table row')));
    assert.doesNotMatch(JSON.stringify(r.warnings), new RegExp(secret));
  });

  it('drops a bad optional delta but keeps the stat (lenient)', () => {
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'stat', value: 5, delta: 'nope' });
    assert.equal(r.ok, true);
    assert.equal(r.value.data.delta, undefined);
    assert.ok(r.warnings.some((w) => w.includes('delta')));
  });

  it('normTable: caps distinct row keys to 20, drops extras, emits warning', () => {
    // Build rows where the union of keys exceeds 20.
    const row = {};
    for (let i = 0; i < 25; i++) row[`col${i}`] = `v${i}`;
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'table', rows: [row] });
    assert.equal(r.ok, true);
    // Every stored row must have ≤20 keys.
    for (const stored of r.value.data.rows) {
      assert.ok(Object.keys(stored).length <= 20, `row has ${Object.keys(stored).length} keys, expected ≤20`);
    }
    assert.ok(r.warnings.some((w) => w.includes('distinct keys capped')));
  });

  it('normTable: clamps non-string cell values to MAX_STR chars', () => {
    // A numeric cell should be stored as its string representation (short).
    // A large object should be stored as a clamped string.
    const bigObj = { data: 'x'.repeat(600) };
    const r = validatePanel({ service: 'svc', panel: 'p', kind: 'table', rows: [{ num: 42, obj: bigObj }] });
    assert.equal(r.ok, true);
    const stored = r.value.data.rows[0];
    // num: coerced to string "42"
    assert.equal(stored.num, '42');
    // obj: JSON-stringified then clamped to 500 chars
    assert.ok(typeof stored.obj === 'string', 'non-string object cell should be stored as string');
    assert.ok(stored.obj.length <= 500, `object cell too long: ${stored.obj.length}`);
  });
});

// --- POST /api/panels ---
describe('POST /api/panels', () => {
  let app;
  let db;
  const TOKEN = 'panel-token-xyz';
  const savedEnv = {};

  before(async () => {
    savedEnv.HEIMDALL_FLEET_TOKEN = process.env.HEIMDALL_FLEET_TOKEN;
    savedEnv.HEIMDALL_BIND = process.env.HEIMDALL_BIND;
    savedEnv.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK = process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK;
    process.env.HEIMDALL_FLEET_TOKEN = TOKEN;
    process.env.HEIMDALL_BIND = '192.0.2.1'; // non-loopback so token is required
    delete process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK;

    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const post = (body, token) => app.inject({
    method: 'POST', url: '/api/panels',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  it('fail-closed: 401 with no token', async () => {
    const res = await post(EXAMPLE, null);
    assert.equal(res.statusCode, 401);
  });

  it('401 with a wrong token', async () => {
    const res = await post(EXAMPLE, 'wrong');
    assert.equal(res.statusCode, 401);
  });

  it('200 upsert with valid token; persists + reports warnings field', async () => {
    const res = await post(EXAMPLE, TOKEN);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.warnings));
    const panels = getPanelsForService(db, 'm5-inference');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].kind, 'timeseries');
    assert.equal(panels[0].data.detail.rows.length, 2);
  });

  it('upsert by (service,panel): re-POST same id does not create a second row', async () => {
    await post({ ...EXAMPLE, label: 'updated label' }, TOKEN);
    const panels = getPanelsForService(db, 'm5-inference');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].label, 'updated label');
  });

  it('400 on bad id charset', async () => {
    const res = await post({ service: 'Bad Svc', panel: 'p', kind: 'status', state: 'pass' }, TOKEN);
    assert.equal(res.statusCode, 400);
  });

  it('400 on unknown kind', async () => {
    const res = await post({ service: 'svc', panel: 'p', kind: 'pie' }, TOKEN);
    assert.equal(res.statusCode, 400);
  });

  it('429 when a service exceeds the panel-count cap', async () => {
    for (let i = 0; i < 50; i++) {
      const r = await post({ service: 'capped', panel: `p${i}`, kind: 'stat', value: i }, TOKEN);
      assert.equal(r.statusCode, 200);
    }
    assert.equal(countPanelsForService(db, 'capped'), 50);
    const over = await post({ service: 'capped', panel: 'p50', kind: 'stat', value: 1 }, TOKEN);
    assert.equal(over.statusCode, 429);
    // Updating an EXISTING panel is still allowed at the cap.
    const upd = await post({ service: 'capped', panel: 'p0', kind: 'stat', value: 999 }, TOKEN);
    assert.equal(upd.statusCode, 200);
  });

  it('413 when the request body exceeds the 256 KiB route-level bodyLimit', async () => {
    // Build a raw JSON string > 256 KiB (not a valid panel, but bodyLimit fires before parsing).
    const bigBody = JSON.stringify({ service: 'svc', panel: 'p', kind: 'stat', value: 1, extra: 'x'.repeat(300 * 1024) });
    const res = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: bigBody,
    });
    // Fastify returns 413 for payload-too-large.
    assert.equal(res.statusCode, 413, `expected 413 for oversized body, got ${res.statusCode}`);
  });
});

// --- GET /api/panels/schema ---
describe('GET /api/panels/schema', () => {
  let app;
  let db;
  before(async () => { db = freshDb(); ({ app } = buildApp(db)); await app.ready(); });
  after(async () => { await app.close(); db.close(); });

  it('returns the schema doc with the four kinds + example', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/panels/schema' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    for (const k of ['stat', 'timeseries', 'table', 'status']) assert.ok(body.kinds[k]);
    assert.equal(body.example.service, 'm5-inference');
    assert.match(body.description, /configured fleet credential.*Authorization header.*Bearer scheme/i);
    assert.doesNotMatch(body.description, /Bearer\s+[A-Z][A-Z0-9_]+/,
      'schema docs must not use secret-shaped Bearer placeholders');
  });
});

// --- /services/:name renders pushed panels ---
describe('GET /services/:name with pushed panels', () => {
  let app;
  let db;
  const TOKEN = 'panel-token-render';
  const savedEnv = {};

  before(async () => {
    savedEnv.HEIMDALL_FLEET_TOKEN = process.env.HEIMDALL_FLEET_TOKEN;
    savedEnv.HEIMDALL_BIND = process.env.HEIMDALL_BIND;
    process.env.HEIMDALL_FLEET_TOKEN = TOKEN;
    process.env.HEIMDALL_BIND = '192.0.2.1';
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });
  after(async () => {
    await app.close();
    db.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('renders a pushed panel on the service page even without a descriptor', async () => {
    const lone = { ...EXAMPLE, service: 'lone-pushed-svc' };
    const r = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(lone),
    });
    assert.equal(r.statusCode, 200);
    const res = await app.inject({ method: 'GET', url: '/services/lone-pushed-svc' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('Offloadability'), 'panel label rendered');
    assert.ok(res.body.includes('qwen3-30b-instruct'), 'detail table row rendered');
    assert.ok(res.body.includes('<svg'), 'sparkline rendered');
  });

  // #102 — panels pushed as `m5-inference` belong on the m5-gateway page.
  it('keeps legacy m5-inference pushed panels out of the focused m5-gateway page', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(EXAMPLE),
    });
    assert.equal(r.statusCode, 200);
    const res = await app.inject({ method: 'GET', url: '/services/m5-gateway' });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes('Offloadability'), 'legacy panel must not re-grow the focused page');
    assert.ok(!res.body.includes('qwen3-30b-instruct'), 'legacy detail must stay out of the focused page');
  });

  it('redirects the aliased producer id to the owning service page', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/m5-inference' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/services/m5-gateway');
  });

  // #102 — a pushed-only service must be discoverable, not a hidden drawer.
  it('lists a pushed-only service on the /services index grid', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ service: 'index-only-svc', panel: 'p1', kind: 'stat', value: 42 }),
    });
    assert.equal(r.statusCode, 200);
    const res = await app.inject({ method: 'GET', url: '/api/services/grid' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('index-only-svc'), 'pushed-only service card present');
    assert.ok(res.body.includes('/services/index-only-svc'), 'card links to its page');
  });

  it('uses a fresh pushed status in the service card/header and exception filter', async () => {
    const pass = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ service: 'reported-pass', panel: 'health', kind: 'status', state: 'pass', message: 'all good' }),
    });
    const warn = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ service: 'reported-warn', panel: 'health', kind: 'status', state: 'warn', message: 'inspect me' }),
    });
    assert.equal(pass.statusCode, 200);
    assert.equal(warn.statusCode, 200);

    const grid = await app.inject({ method: 'GET', url: '/api/services/grid' });
    assert.match(grid.body, /reported-pass[\s\S]*status-badge is-ok|status-badge is-ok[\s\S]*reported-pass/);
    assert.match(grid.body, /reported-warn[\s\S]*status-badge is-warn|status-badge is-warn[\s\S]*reported-warn/);

    const exceptions = await app.inject({ method: 'GET', url: '/api/services/grid?mode=exceptions' });
    assert.ok(exceptions.body.includes('reported-warn'));
    assert.ok(!exceptions.body.includes('reported-pass'));

    const detail = await app.inject({ method: 'GET', url: '/services/reported-pass' });
    assert.ok(detail.body.includes('Status reported by pushed panels; no probe endpoint.'));
    assert.ok(detail.body.includes('reported '));
  });

  it('does NOT list an aliased producer id as its own card on the index', async () => {
    // m5-inference panels exist (pushed above) but render under m5-gateway.
    const res = await app.inject({ method: 'GET', url: '/api/services/grid' });
    assert.ok(!res.body.includes('/services/m5-inference'), 'no card for the aliased id');
    assert.ok(res.body.includes('/services/m5-gateway'), 'owner card present');
  });

  // #102 — read-back path so a producer can verify what actually landed.
  it('GET /api/panels lists stored panels (summary, no data)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/panels' });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body);
    assert.ok(Array.isArray(list));
    const row = list.find((p) => p.service === 'm5-inference' && p.panel === 'offloadability');
    assert.ok(row, 'pushed panel listed');
    assert.equal(row.kind, 'timeseries');
    assert.ok(row.updated_at > 0);
    assert.equal(row.data, undefined, 'summary list omits data payloads');
  });

  // Full data payloads share the fleet trust boundary with POST (Codex review):
  // unauthenticated ?service= reads degrade to summary rows, a valid Bearer gets data.
  it('GET /api/panels?service= without auth returns summary rows only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/panels?service=m5-inference' });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body);
    const row = list.find((p) => p.panel === 'offloadability');
    assert.ok(row, 'panel listed');
    assert.equal(row.data, undefined, 'no data payload without fleet auth');
  });

  it('GET /api/panels?service= with the fleet token returns full panels with data', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/panels?service=m5-inference',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body);
    const row = list.find((p) => p.panel === 'offloadability');
    assert.ok(row, 'panel returned');
    assert.equal(row.data.points.length, 2, 'data payload included');
  });

  it('GET /api/panels?service= with a WRONG token is 401', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/panels?service=m5-inference',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/panels?service= for an unknown service returns []', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/panels?service=no-such-svc',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });
});

// ─── Global quota caps (Fix 2) ────────────────────────────────────────────────

describe('handlePanelIngest — global quotas (Fix 2)', () => {
  it('429 when a new panel would exceed MAX_TOTAL_PANELS', () => {
    const db = freshDb();
    // Stub out the count functions to simulate a full fleet store.
    const opts = {
      authHeader: 'Bearer tok', token: 'tok', bindHost: '127.0.0.1',
      allowInsecureLoopback: true, // skip real auth for unit test
      body: { service: 'svc-a', panel: 'brand-new', kind: 'stat', value: 1 },
      countPanelsFn: () => 0,          // per-service: under limit
      countTotalFn: () => MAX_TOTAL_PANELS,   // global total: AT limit
      countServicesFn: () => 1,
    };
    const { handlePanelIngest } = require('../src/panel-ingest');
    const r = handlePanelIngest(db, opts);
    assert.equal(r.status, 429);
    assert.ok(r.body.error.includes('fleet panel store is full'));
    db.close();
  });

  it('429 when a new service would exceed MAX_PANEL_SERVICES', () => {
    const db = freshDb();
    const { handlePanelIngest } = require('../src/panel-ingest');
    const opts = {
      authHeader: 'Bearer tok', token: 'tok', bindHost: '127.0.0.1',
      allowInsecureLoopback: true,
      body: { service: 'brand-new-service', panel: 'p1', kind: 'stat', value: 1 },
      countPanelsFn: () => 0,
      countTotalFn: () => 0,
      countServicesFn: () => MAX_PANEL_SERVICES,  // at limit
    };
    const r = handlePanelIngest(db, opts);
    assert.equal(r.status, 429);
    assert.ok(r.body.error.includes('service limit'));
    db.close();
  });

  it('200 for an UPDATE when total panel count is at MAX_TOTAL_PANELS (existing panel)', () => {
    const db = freshDb();
    const { handlePanelIngest } = require('../src/panel-ingest');
    // First insert the panel legitimately.
    const insert = handlePanelIngest(db, {
      authHeader: 'Bearer tok', token: 'tok', bindHost: '127.0.0.1',
      allowInsecureLoopback: true,
      body: { service: 'svc-upd', panel: 'existing', kind: 'stat', value: 1 },
    });
    assert.equal(insert.status, 200);

    // Now simulate at-cap and update the SAME (service, panel).
    const update = handlePanelIngest(db, {
      authHeader: 'Bearer tok', token: 'tok', bindHost: '127.0.0.1',
      allowInsecureLoopback: true,
      body: { service: 'svc-upd', panel: 'existing', kind: 'stat', value: 99 },
      countTotalFn: () => MAX_TOTAL_PANELS,       // at cap
      countServicesFn: () => MAX_PANEL_SERVICES,  // at cap
      countPanelsFn: () => 50,                    // per-service at cap
    });
    // Update of existing panel must still succeed.
    assert.equal(update.status, 200, `expected 200 for update, got ${update.status}: ${JSON.stringify(update.body)}`);
    db.close();
  });
});
