'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getPlugin, listPlugins } = require('../src/plugins');
const { renderPanel, PLUGIN_CSS } = require('../src/plugins/hugin');

// Minimal stub: returns predictable HTML fragments so no real Munin DB is needed.
function fakeHugin(overrides = {}) {
  return {
    readHuginTasks: () => [],
    getTaskSuccessRate: () => null,
    getTaskQueueMetrics: () => ({ oldestPendingAge: null, runningTasks: [], avgCompletionTime: null, stuckTasks: [], retryCount: 0 }),
    readHuginHeartbeat: () => null,
    getTimeoutCalibration: () => null,
    ...overrides,
  };
}

function fakeHtml(overrides = {}) {
  return {
    huginTasksCard: () => '<div class="hugin-tasks-card">Hugin Tasks</div>',
    taskHistoryCard: () => '<h3>Task History</h3><div>No tasks</div>',
    ...overrides,
  };
}

describe('hugin plugin registry', () => {
  it('resolves the hugin plugin and exposes its css', () => {
    const p = getPlugin('hugin');
    assert.ok(p);
    assert.equal(p.name, 'hugin');
    assert.equal(p.css, '/css/hugin.css');
    assert.equal(typeof p.renderPanel, 'function');
  });

  it('is listed among all plugins', () => {
    assert.ok(listPlugins().some((p) => p.name === 'hugin'));
  });

  it('PLUGIN_CSS constant matches the registered css', () => {
    assert.equal(PLUGIN_CSS, '/css/hugin.css');
  });
});

describe('hugin plugin — renderPanel view:tasks', () => {
  it('returns HTML from huginTasksCard when view is tasks', async () => {
    const html = await renderPanel(
      { id: 'hugin-tasks', view: 'tasks', label: 'Tasks' },
      { hugin: fakeHugin(), html: fakeHtml() },
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('Hugin Tasks'));
  });

  it('passes all five args to huginTasksCard (tasks, successRate, queueMetrics, heartbeat, timeoutCal)', async () => {
    const calls = [];
    const html = fakeHtml({
      huginTasksCard: (...args) => { calls.push(args); return '<div>ok</div>'; },
    });
    const tasks = [{ name: 'x', status: 'completed' }];
    const hugin = fakeHugin({ readHuginTasks: () => tasks });
    await renderPanel({ view: 'tasks' }, { hugin, html });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], tasks);    // first arg is tasks
    assert.equal(calls[0].length, 5);        // 5 args total
  });
});

describe('hugin plugin — renderPanel view:history', () => {
  it('returns HTML from taskHistoryCard when view is history', async () => {
    const html = await renderPanel(
      { id: 'hugin-history', view: 'history', label: 'Task history' },
      { hugin: fakeHugin(), html: fakeHtml() },
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('Task History'));
  });

  it('calls readHuginTasks with limit:1000 for history view', async () => {
    const calls = [];
    const hugin = fakeHugin({ readHuginTasks: (opts) => { calls.push(opts); return []; } });
    await renderPanel({ view: 'history' }, { hugin, html: fakeHtml() });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { limit: 1000 });
  });
});

describe('hugin plugin — graceful degradation', () => {
  it('returns escaped error note and does NOT throw when data layer throws', async () => {
    const hugin = fakeHugin({ readHuginTasks: () => { throw new Error('DB locked <test>'); } });
    const html = await renderPanel({ view: 'tasks' }, { hugin, html: fakeHtml() });
    assert.ok(typeof html === 'string');
    // Must not throw (already proven by reaching here), and must contain escaped error text
    assert.ok(html.includes('Hugin panel error'));
    assert.ok(html.includes('DB locked'));
    // The raw angle bracket must be escaped
    assert.ok(!html.includes('<test>'), 'error text must be HTML-escaped');
    assert.ok(html.includes('&lt;test&gt;'));
  });

  it('returns a note for an unknown view and does NOT throw', async () => {
    const html = await renderPanel(
      { id: 'mystery', view: 'nope', label: 'Mystery' },
      { hugin: fakeHugin(), html: fakeHtml() },
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('Mystery') || html.includes('Unknown Hugin panel view'));
    assert.ok(!/<script>/.test(html));
  });

  it('handles a panel with no view gracefully', async () => {
    const html = await renderPanel(
      { id: 'bare-panel' },
      { hugin: fakeHugin(), html: fakeHtml() },
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.length > 0);
  });

  it('escapes XSS in error messages', async () => {
    const hugin = fakeHugin({
      readHuginTasks: () => { throw new Error('<script>alert(1)</script>'); },
    });
    const html = await renderPanel({ view: 'tasks' }, { hugin, html: fakeHtml() });
    assert.ok(!/<script>alert/.test(html), 'script tags must be escaped');
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

// --- End-to-end route: injected hugin panel → /api/plugins fragment + guard ---
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../src/server');
const { openDatabase, upsertServiceSnapshot } = require('../src/db');
const { knownPanelsFor } = require('../src/plugins/known-panels');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-hugin-route-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('hugin panel fragment route (end-to-end)', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    // Seed a hugin snapshot carrying the Heimdall-side known panels.
    upsertServiceSnapshot(db, {
      service: 'hugin', kind: 'http-service', status: null,
      descriptor: {
        service: { name: 'hugin', label: 'hugin', criticality: 'normal' },
        kind: 'http-service', status: null, metrics: [],
        panels: knownPanelsFor('hugin'),
        links: {},
      },
      fetchedAt: new Date().toISOString(), reachable: false,
      schemaVersion: null, source: 'config', error: 'unreachable',
    });
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('emits the panel HTMX endpoint on /services/hugin', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/hugin' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /hx-get="\/api\/plugins\/hugin\/hugin\/hugin-tasks"/);
    assert.match(res.body, /hugin\.css/);
  });

  it('renders the hugin-tasks fragment (wrapped, never throws)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/plugins/hugin/hugin/hugin-tasks',
      headers: { 'hx-request': 'true' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /hugin-panel/); // the scope wrapper is always present
  });

  it('404s when the requested plugin does not match the panel', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/inference/hugin/hugin-tasks' });
    assert.equal(res.statusCode, 404);
  });

  it('404s for an unknown panel id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/hugin/hugin/nope' });
    assert.equal(res.statusCode, 404);
  });
});
