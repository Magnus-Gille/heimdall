'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getPlugin, listPlugins } = require('../src/plugins');
const { renderPanel, PLUGIN_CSS } = require('../src/plugins/skuld');

// Minimal stubs: return predictable HTML fragments so no real Munin HTTP call is made.
function fakeSkuld(overrides = {}) {
  return {
    fetchLatestBriefing: async () => null,
    ...overrides,
  };
}

function fakeHtml(overrides = {}) {
  return {
    briefingFullCard: () => '<div class="briefing-marker">Daily Briefing Content</div>',
    ...overrides,
  };
}

describe('skuld plugin registry', () => {
  it('resolves the skuld plugin and exposes its css', () => {
    const p = getPlugin('skuld');
    assert.ok(p);
    assert.equal(p.name, 'skuld');
    assert.equal(p.css, '/css/skuld.css');
    assert.equal(typeof p.renderPanel, 'function');
  });

  it('is listed among all plugins', () => {
    assert.ok(listPlugins().some((p) => p.name === 'skuld'));
  });

  it('PLUGIN_CSS constant matches the registered css', () => {
    assert.equal(PLUGIN_CSS, '/css/skuld.css');
  });
});

describe('skuld plugin — renderPanel view:briefing', () => {
  it('returns HTML from briefingFullCard when view is briefing', async () => {
    const html = await renderPanel(
      { id: 'skuld-briefing', view: 'briefing', label: 'Daily Briefing' },
      { skuld: fakeSkuld(), html: fakeHtml() },
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('Daily Briefing Content'));
    assert.ok(html.includes('skuld-panel'));
  });

  it('passes the fetched briefing to briefingFullCard', async () => {
    const calls = [];
    const fakeBriefing = { date: '2026-06-24', narrative: 'Test narrative', sources: [], eventsToday: 3, generatedAt: 'now' };
    const skuld = fakeSkuld({ fetchLatestBriefing: async () => fakeBriefing });
    const html = fakeHtml({ briefingFullCard: (b) => { calls.push(b); return '<div>ok</div>'; } });
    await renderPanel({ view: 'briefing' }, { skuld, html });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], fakeBriefing);
  });

  it('handles null briefing (no briefing yet) gracefully', async () => {
    const skuld = fakeSkuld({ fetchLatestBriefing: async () => null });
    const html = fakeHtml({ briefingFullCard: (b) => b === null ? '<div class="briefing-empty">No briefing</div>' : '<div>ok</div>' });
    const result = await renderPanel({ view: 'briefing' }, { skuld, html });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('skuld-panel'));
  });
});

describe('skuld plugin — graceful degradation', () => {
  it('returns escaped error note and does NOT throw when fetchLatestBriefing rejects', async () => {
    const skuld = fakeSkuld({ fetchLatestBriefing: async () => { throw new Error('Munin unreachable <test>'); } });
    const result = await renderPanel({ view: 'briefing' }, { skuld, html: fakeHtml() });
    assert.ok(typeof result === 'string');
    // Must not throw (already proven by reaching here), and must contain escaped error text
    assert.ok(result.includes('Skuld panel error'));
    assert.ok(result.includes('Munin unreachable'));
    // The raw angle bracket must be escaped
    assert.ok(!result.includes('<test>'), 'error text must be HTML-escaped');
    assert.ok(result.includes('&lt;test&gt;'));
  });

  it('returns a note for an unknown view and does NOT throw', async () => {
    const result = await renderPanel(
      { id: 'mystery', view: 'nope', label: 'Mystery' },
      { skuld: fakeSkuld(), html: fakeHtml() },
    );
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Mystery') || result.includes('Unknown Skuld panel view'));
    assert.ok(!/<script>/.test(result));
  });

  it('handles a panel with no view gracefully', async () => {
    const result = await renderPanel(
      { id: 'bare-panel' },
      { skuld: fakeSkuld(), html: fakeHtml() },
    );
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('escapes XSS in error messages', async () => {
    const skuld = fakeSkuld({
      fetchLatestBriefing: async () => { throw new Error('<script>alert(1)</script>'); },
    });
    const result = await renderPanel({ view: 'briefing' }, { skuld, html: fakeHtml() });
    assert.ok(!/<script>alert/.test(result), 'script tags must be escaped');
    assert.ok(result.includes('&lt;script&gt;'));
  });
});

// --- End-to-end route: injected skuld panel → /api/plugins fragment + guard ---
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../src/server');
const { openDatabase, upsertServiceSnapshot } = require('../src/db');
const { knownPanelsFor } = require('../src/plugins/known-panels');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-skuld-route-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('skuld panel fragment route (end-to-end)', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    // Seed a skuld snapshot carrying the Heimdall-side known panels.
    upsertServiceSnapshot(db, {
      service: 'skuld', kind: 'http-service', status: null,
      descriptor: {
        service: { name: 'skuld', label: 'skuld', criticality: 'normal' },
        kind: 'http-service', status: null, metrics: [],
        panels: knownPanelsFor('skuld'),
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

  it('emits the panel HTMX endpoint on /services/skuld', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/skuld' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /hx-get="\/api\/plugins\/skuld\/skuld\/skuld-briefing"/);
    assert.match(res.body, /skuld\.css/);
  });

  it('renders the skuld-briefing fragment (wrapped, never throws)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/plugins/skuld/skuld/skuld-briefing',
      headers: { 'hx-request': 'true' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /skuld-panel/); // the scope wrapper is always present
  });

  it('404s when the requested plugin does not match the panel', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/inference/skuld/skuld-briefing' });
    assert.equal(res.statusCode, 404);
  });

  it('404s for an unknown panel id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/skuld/skuld/nope' });
    assert.equal(res.statusCode, 404);
  });
});

// Locks the XSS contract through the REAL briefingFullCard (Codex #48 L1):
// guards against a future change to the renderer silently weakening escaping.
describe('skuld plugin — real briefingFullCard escaping', () => {
  const realHtml = require('../src/html');

  it('escapes hostile briefing content and stays wrapped in .skuld-panel', async () => {
    const hostile = {
      date: '<script>d</script>',
      generatedAt: '<b>g</b>',
      sources: ['<img src=x onerror=alert(1)>'],
      narrative: '# Title\n\n<script>alert(1)</script>\n\nplain text',
    };
    const out = await renderPanel(
      { id: 'skuld-briefing', view: 'briefing', plugin: 'skuld' },
      { skuld: fakeSkuld({ fetchLatestBriefing: async () => hostile }), html: realHtml },
    );
    assert.match(out, /skuld-panel/);
    assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/);   // raw script not emitted
    assert.doesNotMatch(out, /<img[^>]*onerror/i);             // no raw <img> tag (brackets escaped)
    assert.match(out, /&lt;script&gt;/);                        // narrative escaped
    assert.match(out, /&lt;img/);                              // hostile source escaped to text
  });
});
