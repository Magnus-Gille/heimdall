'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { readListPage, readArticlePage } = require('../src/render/read');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-read-'));
  return openDatabase(path.join(dir, 'test.db'));
}

const ARTICLES = [
  { slug: 'alpha', title: 'Alpha Findings', mtimeIso: '2026-06-01T10:00:00Z', wordCount: 440, excerpt: 'First.' },
  { slug: 'beta', title: 'Beta Notes', mtimeIso: '2026-06-02T10:00:00Z', wordCount: 220, excerpt: 'Second.' },
];

describe('readListPage (v2)', () => {
  it('renders inside the v2 shell with the Read nav active', () => {
    const html = readListPage('test1', ARTICLES);
    assert.match(html, /class="nav"/);                       // v2 shell
    assert.match(html, /href="\/services"/);                 // v2 nav, not v1
    assert.match(html, /aria-current="page"/);               // Read is active
    assert.match(html, /\/css\/reader\.css/);                // reader styles loaded
    assert.doesNotMatch(html, /href="\/tasks"/);             // no v1 nav
  });

  it('renders one card per article with a link, date and reading time', () => {
    const html = readListPage('test1', ARTICLES);
    assert.match(html, /href="\/read\/alpha"/);
    assert.match(html, /Alpha Findings/);
    assert.match(html, /Jun 1, 2026/);
    assert.match(html, /2 min read/);                        // 440 / 220
  });

  it('shows an empty state when there are no articles', () => {
    const html = readListPage('test1', []);
    assert.match(html, /No research documents found/);
  });

  it('escapes article titles', () => {
    const html = readListPage('test1', [{ slug: 'x', title: '<script>bad</script>', mtimeIso: '', wordCount: 1 }]);
    assert.doesNotMatch(html, /<script>bad<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('readArticlePage (v2)', () => {
  const article = { slug: 'alpha', title: 'Alpha Findings', mtimeIso: '2026-06-01T10:00:00Z', wordCount: 440, markdown: '# Heading\n\nSome **bold** prose.' };

  it('renders inside the v2 shell with reader assets', () => {
    const html = readArticlePage('test1', article, {});
    assert.match(html, /class="nav"/);
    assert.match(html, /\/css\/reader\.css/);
    assert.match(html, /\/reader\.js/);                      // externalized font controls (CSP-safe)
    assert.doesNotMatch(html, /readThemeScript|localStorage\.getItem\('heimdall-reader-size'\)/); // no inline script
  });

  it('renders the markdown body, EPUB link and font controls', () => {
    const html = readArticlePage('test1', article, {});
    assert.match(html, /<strong>bold<\/strong>/);            // marked-parsed
    assert.match(html, /href="\/read\/alpha\.epub"/);
    assert.match(html, /reader-font-btn/);
  });

  it('renders prev/next navigation when provided', () => {
    const html = readArticlePage('test1', article, {
      prev: { slug: 'p', title: 'Prev One' },
      next: { slug: 'n', title: 'Next One' },
    });
    assert.match(html, /href="\/read\/p"/);
    assert.match(html, /Prev One/);
    assert.match(html, /href="\/read\/n"/);
    assert.match(html, /Next One/);
  });
});

describe('readArticlePage — XSS sanitization (heimdall#46)', () => {
  function render(markdown) {
    return readArticlePage('test', { slug: 'x', title: 'X', mtimeIso: '', wordCount: 1, markdown }, {});
  }

  it('strips raw <script> tags from markdown output', () => {
    const html = render('<script>alert(1)</script>\n\nSafe text.');
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /alert\(1\)/);
  });

  it('strips onerror attribute from <img>', () => {
    const html = render('![x](https://example.com/img.png)');
    // sanity: image is present
    assert.match(html, /<img/);
    // onerror must not appear even if injected directly in markdown
    const html2 = render('<img src="x" onerror="alert(1)">');
    assert.doesNotMatch(html2, /onerror/);
  });

  it('does not produce a javascript: href from a markdown link', () => {
    const html = render('[click me](javascript:alert(1))');
    assert.doesNotMatch(html, /javascript:/);
  });

  it('preserves normal https: links', () => {
    const html = render('[Example](https://example.com)');
    assert.match(html, /href="https:\/\/example\.com"/);
  });

  it('preserves headings, emphasis, code and blockquotes', () => {
    const html = render('# H1\n\n**bold** _em_ `code`\n\n> quote');
    assert.match(html, /<h1>/);
    assert.match(html, /<strong>/);
    assert.match(html, /<em>/);
    assert.match(html, /<code>/);
    assert.match(html, /<blockquote>/);
  });

  it('strips protocol-relative href (//evil.com phishing vector)', () => {
    // allowProtocolRelative:false must block scheme-less URLs that bypass allowedSchemes
    const html = render('<a href="//evil.com">click</a>');
    assert.doesNotMatch(html, /\/\/evil\.com/);
  });

  it('adds rel="noopener noreferrer" to target="_blank" links (tabnabbing)', () => {
    const html = render('<a href="https://example.com" target="_blank">link</a>');
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it('overrides existing rel when target="_blank" is present', () => {
    const html = render('<a href="https://example.com" target="_blank" rel="opener">link</a>');
    assert.doesNotMatch(html, /rel="opener"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });
});

describe('GET /read (v2 route)', () => {
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

  it('serves the reader through the v2 shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/read' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /class="nav"/);
    assert.match(res.body, /\/css\/reader\.css/);
  });

  it('serves the external reader.js asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/reader.js' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('javascript'));
  });

  it('serves the reader.css asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/css/reader.css' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('css'));
  });
});
