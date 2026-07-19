'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { buildApp } = require('../src/server');
const { openDatabase, getActiveAlerts, getUnacknowledgedAlerts, createAlert } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-routes-'));
  return openDatabase(path.join(dir, 'test.db'));
}

// --- Alerts tab + list + count fragments ---
describe('Alerts tab fragments', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('GET /alerts returns the page with the Alerts nav active', async () => {
    const res = await app.inject({ method: 'GET', url: '/alerts' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('href="/alerts"'), 'Alerts nav link present');
  });

  it('GET /api/alerts/list returns an HTML fragment', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts/list' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.equal(typeof res.body, 'string');
  });

  it('GET /api/alerts/count is empty when nothing is pending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts/count' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
  });

  it('renders alert title + dismiss control in the list, and a count badge', async () => {
    createAlert(db, 'test-host', 'engine', 'warning', 'List render test alert', 'detail');
    const list = await app.inject({ method: 'GET', url: '/api/alerts/list' });
    assert.ok(list.body.includes('List render test alert'), 'alert title rendered in list');
    assert.ok(list.body.includes('/api/alerts/'), 'dismiss control (hx-delete) present');

    const count = await app.inject({ method: 'GET', url: '/api/alerts/count' });
    assert.ok(count.body.includes('nav-badge'), 'count badge rendered');
    assert.ok(count.body.includes('1'), 'count reflects one pending alert');
  });
});

// --- GET /api/alerts ---
describe('GET /api/alerts', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 with an empty array when no alerts exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });
});

// --- POST /api/alerts ---
describe('POST /api/alerts', () => {
  let app;
  let db;
  const TOKEN = 'test-token-abc';
  const savedEnv = {};

  before(async () => {
    // Set token and allow loopback so inject() passes auth
    savedEnv.HEIMDALL_ALERT_TOKEN = process.env.HEIMDALL_ALERT_TOKEN;
    savedEnv.HEIMDALL_BIND = process.env.HEIMDALL_BIND;
    savedEnv.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK = process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK;
    process.env.HEIMDALL_ALERT_TOKEN = TOKEN;
    process.env.HEIMDALL_BIND = '192.0.2.1'; // non-loopback so token is required
    delete process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK;

    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'disk full' }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 when authorization token is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ title: 'disk full' }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 400 when body has no title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ severity: 'warning' }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('creates an alert with valid token + body and persists it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        title: 'High disk usage',
        severity: 'warning',
        source: 'test-service',
        dedup_key: 'test:disk-high',
      }),
    });
    assert.equal(res.statusCode, 200);
    const active = getActiveAlerts(db);
    assert.equal(active.length, 1);
    assert.equal(active[0].title, 'High disk usage');
    assert.equal(active[0].source, 'test-service');
  });

  it('dedups by dedup_key: second POST with same key does not create a second row', async () => {
    const DEDUP_KEY = 'test:dedup-self-contained';
    // First POST — creates the alert
    await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        title: 'Dedup first',
        severity: 'warning',
        dedup_key: DEDUP_KEY,
      }),
    });
    // Second POST — same dedup_key, updated fields
    await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        title: 'Dedup second',
        severity: 'critical',
        dedup_key: DEDUP_KEY,
      }),
    });
    const active = getActiveAlerts(db).filter((a) => a.dedup_key === DEDUP_KEY);
    // Still exactly 1 row — dedup collapsed the second push
    assert.equal(active.length, 1, 'dedup: only one row for the key');
    // Title and severity updated in place by the second POST
    assert.equal(active[0].title, 'Dedup second', 'title updated by second push');
    assert.equal(active[0].severity, 'critical', 'severity updated by second push');
  });

  it('resolves an alert by dedup_key through the authenticated endpoint', async () => {
    const DEDUP_KEY = 'test:resolve-route';
    await app.inject({
      method: 'POST', url: '/api/alerts',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ title: 'Temporary failure', dedup_key: DEDUP_KEY }),
    });
    const res = await app.inject({
      method: 'POST', url: '/api/alerts',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ state: 'resolved', dedup_key: DEDUP_KEY }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).resolved, 1);
    assert.equal(getActiveAlerts(db).filter((a) => a.dedup_key === DEDUP_KEY).length, 0);
  });
});

// --- DELETE /api/alerts/:id ---
describe('DELETE /api/alerts/:id', () => {
  let app;
  let db;
  const TOKEN = 'test-token-delete';
  const savedEnv = {};

  before(async () => {
    savedEnv.HEIMDALL_ALERT_TOKEN = process.env.HEIMDALL_ALERT_TOKEN;
    savedEnv.HEIMDALL_BIND = process.env.HEIMDALL_BIND;
    savedEnv.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK = process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK;
    process.env.HEIMDALL_ALERT_TOKEN = TOKEN;
    process.env.HEIMDALL_BIND = '192.0.2.1';
    delete process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK;

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

  it('acknowledges an existing alert and returns 200 with empty HTML body', async () => {
    // First create an alert
    const post = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ title: 'Alert to dismiss', dedup_key: 'dismiss:test' }),
    });
    assert.equal(post.statusCode, 200);

    const [alert] = getActiveAlerts(db);
    assert.ok(alert, 'alert must exist before dismiss');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/${alert.id}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
    assert.ok(res.headers['content-type'].includes('text/html'));

    // Dismiss = acknowledge, NOT resolve: the alert stays "active" (so status
    // aggregation is unchanged) but disappears from the user-facing surfaces. This
    // is what makes the × stick across the alert engine's re-fire.
    assert.equal(getActiveAlerts(db).length, 1, 'still active (acknowledged, not resolved)');
    assert.equal(getUnacknowledgedAlerts(db).length, 0, 'hidden from the Alerts tab + badge');
  });

  it('rejects a mutation from a non-loopback peer and leaves the alert visible', async () => {
    createAlert(db, 'test-host', 'engine', 'warning', 'Remote dismiss attempt', 'detail', {
      dedup_key: 'dismiss:remote-attempt',
    });
    const alert = getUnacknowledgedAlerts(db).find((row) => row.dedup_key === 'dismiss:remote-attempt');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/${alert.id}`,
      remoteAddress: '198.51.100.23',
    });
    assert.equal(res.statusCode, 403);
    assert.ok(getUnacknowledgedAlerts(db).some((row) => row.id === alert.id));
  });

  it('stays dismissed when the same alert is re-created (engine re-fire)', async () => {
    const KEY = 'dismiss:refire';
    await app.inject({
      method: 'POST', url: '/api/alerts',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ title: 'Re-firing drift', dedup_key: KEY }),
    });
    const alert = getUnacknowledgedAlerts(db).find((a) => a.dedup_key === KEY);
    await app.inject({ method: 'DELETE', url: `/api/alerts/${alert.id}` });
    // Engine re-fires the identical alert (same dedup_key → UPDATE of the active row).
    await app.inject({
      method: 'POST', url: '/api/alerts',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ title: 'Re-firing drift', dedup_key: KEY, severity: 'critical' }),
    });
    assert.equal(
      getUnacknowledgedAlerts(db).filter((a) => a.dedup_key === KEY).length, 0,
      're-fire does not resurrect a dismissed alert',
    );
  });

  it('returns 200 for an unknown id (no-op acknowledge, handler does not 404)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/alerts/99999',
    });
    // Handler calls resolveAlertById and ignores return value — always 200
    assert.equal(res.statusCode, 200);
  });

  it('returns 400 for a non-integer id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/alerts/abc' });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for a malformed id with a numeric prefix (no silent truncation)', async () => {
    // Number.parseInt('1abc') would yield 1 and acknowledge the wrong alert.
    const res = await app.inject({ method: 'DELETE', url: '/api/alerts/1abc' });
    assert.equal(res.statusCode, 400);
  });
});

describe('localhost-only APIs', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('rejects a non-loopback socket peer even without proxy headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      remoteAddress: '198.51.100.23',
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects proxy-forwarded requests even when the immediate peer is loopback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { 'x-forwarded-for': '198.51.100.23' },
    });
    assert.equal(res.statusCode, 403);
  });
});

// --- GET /api/card/task-history (kept: v2 Services/hugin panel paginates via this route) ---
describe('GET /api/card/task-history', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  // HTMX requests carry the `hx-request` header, which the onSend hook uses to
  // unwrap `{html}` → text/html. The v2 Services/hugin panel's pagination fetches
  // this route exactly that way.
  it('returns 200 unwrapped HTML for the default (page 1)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/card/task-history', headers: { 'hx-request': 'true' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.equal(typeof res.body, 'string');
  });

  it('returns 200 for an explicit page param (pagination path the hugin panel uses)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/card/task-history?page=2', headers: { 'hx-request': 'true' },
    });
    assert.equal(res.statusCode, 200);
  });
});
