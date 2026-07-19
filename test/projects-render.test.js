'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { projectsPage } = require('../src/render/projects');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-proj-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('projectsPage (v2)', () => {
  it('renders inside the v2 shell with the Projects nav active', () => {
    const html = projectsPage('v');
    assert.match(html, /class="nav"/);           // v2 shell present
    assert.match(html, /aria-current="page"/);   // Projects is active
    assert.match(html, /href="\/projects".*aria-current="page"|aria-current="page".*href="\/projects"/s);
  });

  it('loads projects.css in the <head>', () => {
    const html = projectsPage('v');
    assert.match(html, /\/css\/projects\.css/);
  });

  it('embeds the consolidation-health HTMX card wrapper', () => {
    const html = projectsPage('v');
    assert.match(html, /hx-get="\/api\/card\/consolidation-health"/);
  });

  it('embeds the projects-list HTMX card wrapper', () => {
    const html = projectsPage('v');
    assert.match(html, /hx-get="\/api\/card\/projects-list"/);
  });

  it('does NOT contain the v1 nav link to /tasks', () => {
    const html = projectsPage('v');
    assert.doesNotMatch(html, /href="\/tasks"/);
  });

  it('does NOT contain the v1 nav link to /briefing', () => {
    const html = projectsPage('v');
    assert.doesNotMatch(html, /href="\/briefing"/);
  });

  it('includes a page heading', () => {
    const html = projectsPage('v');
    assert.match(html, /<h1>Projects<\/h1>/);
  });

  it('mounts the live alert count badge in the nav (alerts moved to their own tab)', () => {
    const html = projectsPage('v');
    assert.match(html, /nav-badge-mount/);
    assert.match(html, /href="\/alerts"/);
    assert.doesNotMatch(html, /alert-strip-mount/);
  });

  it('includes the last-updated element', () => {
    const html = projectsPage('v');
    assert.match(html, /last-updated/);
  });

  it('escapes the gitVersion in CSS href', () => {
    const html = projectsPage('<bad>');
    assert.doesNotMatch(html, /<bad>/);
    assert.match(html, /&lt;bad&gt;/);
  });

  it('wraps content in .projects-page for var-alias scope', () => {
    const html = projectsPage('v');
    assert.match(html, /class="projects-page"/);
  });
});

describe('GET /projects (v2 route)', () => {
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

  it('serves /projects through the v2 shell (200, text/html, nav)', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /class="nav"/);
    assert.match(res.body, /\/css\/projects\.css/);
  });

  it('serves /css/projects.css (200, text/css)', async () => {
    const res = await app.inject({ method: 'GET', url: '/css/projects.css' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('css'));
  });
});
