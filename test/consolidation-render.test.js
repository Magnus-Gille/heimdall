'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { consolidationPage } = require('../src/render/consolidation');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-consol-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('consolidationPage', () => {
  it('renders inside the v2 shell with the Services nav active (sub-view of munin-memory)', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /class="nav"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /href="\/services".*aria-current="page"|aria-current="page".*href="\/services"/s);
  });

  it('no longer registers a top-level Consolidation nav tab', () => {
    const html = consolidationPage('v', {});
    assert.doesNotMatch(html, /<a href="\/consolidation"/);
  });

  it('links back to the munin-memory service page', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /href="\/services\/munin-memory"/);
  });

  it('loads consolidation.css in the <head>', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /\/css\/consolidation\.css/);
  });

  it('embeds the consolidation-status HTMX card wrapper', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /hx-get="\/api\/card\/consolidation-status"/);
  });

  it('includes a page heading', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /<h1>Consolidation<\/h1>/);
  });

  it('embeds the consolidation chart canvas', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /id="consolidation-chart"/);
  });

  it('renders coverage table with empty-state message when no coverage', () => {
    const html = consolidationPage('v', { coverage: [], backlog: [] });
    assert.match(html, /No synthesis entries found/);
  });

  it('renders coverage rows when coverage data is provided', () => {
    const html = consolidationPage('v', {
      coverage: [{ namespace: 'projects/foo', lastConsolidated: '2026-06-01T00:00:00Z', backlog: 0 }],
      backlog: [],
    });
    assert.match(html, /projects\/foo/);
  });

  it('coverage table uses a Backlog column (not Logs incorporated)', () => {
    const html = consolidationPage('v', { coverage: [], backlog: [] });
    assert.match(html, /<th>Backlog<\/th>/);
    assert.doesNotMatch(html, /Logs incorporated/i);
  });

  it('renders the per-namespace backlog count, including an explicit zero', () => {
    const html = consolidationPage('v', {
      coverage: [
        { namespace: 'projects/has-backlog', lastConsolidated: '2026-06-20T00:00:00Z', backlog: 7 },
        { namespace: 'projects/clean', lastConsolidated: '2026-06-21T00:00:00Z', backlog: 0 },
      ],
      backlog: [{ namespace: 'projects/has-backlog', count: 7 }],
    });
    // Both non-zero and zero are explicit — blank means unknown, never healthy.
    assert.match(html, />7<\/span>/);
    assert.match(html, /consol-backlog-cell[^>]*><span class="is-ok">0<\/span>/);
  });

  it('shows backlog warning when backlog is non-empty', () => {
    const html = consolidationPage('v', {
      coverage: [],
      backlog: [{ type: 'consolidation_backlog', namespace: 'projects/foo' }],
    });
    assert.match(html, /consolidation backlog/);
  });

  it('summarizes and prioritizes actionable namespace coverage before the full table', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    const html = consolidationPage('v', {
      coverage: [
        { namespace: 'projects/fresh', lastConsolidated: '2026-07-09T00:00:00Z', backlog: 0 },
        { namespace: 'projects/stale', lastConsolidated: '2026-06-01T00:00:00Z', backlog: 0 },
        { namespace: 'projects/backlogged', lastConsolidated: '2026-07-08T00:00:00Z', backlog: 7 },
      ],
      backlog: [
        { namespace: 'projects/backlogged', count: 7 },
        { namespace: 'projects/never', count: 4 },
      ],
    }, now);
    assert.match(html, /<strong>2<\/strong> backlogged/i);
    assert.match(html, /<strong>1<\/strong> quiet 14d\+/i);
    assert.match(html, /<strong>1<\/strong> never synthesized/i);
    assert.match(html, /<strong>2<\/strong> recently synthesized/i);
    assert.match(html, /Needs attention/i);
    assert.match(html, /<summary>All 4 namespaces<\/summary>/i);
    assert.ok(html.indexOf('projects/backlogged') < html.indexOf('projects/stale'));
    const attentionHtml = html.slice(html.indexOf('Needs attention'), html.indexOf('<details class="consol-all">'));
    assert.doesNotMatch(attentionHtml, /projects\/stale/);
  });

  it('escapes the gitVersion in CSS href', () => {
    const html = consolidationPage('<bad>', {});
    assert.doesNotMatch(html, /<bad>/);
    assert.match(html, /&lt;bad&gt;/);
  });

  it('includes Chart.js script tags (charts: true)', () => {
    const html = consolidationPage('v', {});
    assert.match(html, /chart\.umd\.min\.js/);
  });
});

describe('GET /consolidation route', () => {
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

  it('serves /services/munin-memory/consolidation through the v2 shell (200, text/html)', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/munin-memory/consolidation' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /class="nav"/);
    assert.match(res.body, /Consolidation/);
  });

  it('redirects the old /consolidation URL to the service sub-view (301)', async () => {
    const res = await app.inject({ method: 'GET', url: '/consolidation' });
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/services/munin-memory/consolidation');
  });

  it('serves /api/card/consolidation-status (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/card/consolidation-status' });
    assert.equal(res.statusCode, 200);
  });

  it('serves /api/consolidation/activity returning JSON array (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/consolidation/activity' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  it('serves /css/consolidation.css (200, text/css)', async () => {
    const res = await app.inject({ method: 'GET', url: '/css/consolidation.css' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('css'));
  });
});
