'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listArticles, deriveTitle, deriveExcerpt, isValidSlug } = require('../src/read-docs');

async function makeFixture(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-read-'));
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), contents);
  }
  return dir;
}

test('deriveTitle uses first heading', () => {
  assert.strictEqual(deriveTitle('# Hello World\n\nbody', 'x'), 'Hello World');
  assert.strictEqual(deriveTitle('## Sub Title\n', 'x'), 'Sub Title');
});

test('deriveTitle falls back to slug', () => {
  assert.strictEqual(deriveTitle('no heading here', 'my-slug-name'), 'My Slug Name');
});

test('deriveExcerpt strips markdown and truncates', () => {
  const md = '# Title\n\nThis is a [link](https://x) and **bold** text. It should be clean.\n\nSecond paragraph.';
  const ex = deriveExcerpt(md);
  assert.ok(!ex.includes('['));
  assert.ok(!ex.includes('**'));
  assert.ok(ex.startsWith('This is a link'));
});

test('deriveExcerpt handles long input', () => {
  const long = 'word '.repeat(200);
  const ex = deriveExcerpt(long);
  assert.ok(ex.length <= 240);
  assert.ok(ex.endsWith('…'));
});

test('isValidSlug rules', () => {
  assert.ok(isValidSlug('hello'));
  assert.ok(isValidSlug('hello-world-2'));
  assert.ok(!isValidSlug('Hello'));
  assert.ok(!isValidSlug('-leading'));
  assert.ok(!isValidSlug('a/b'));
  assert.ok(!isValidSlug('..'));
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug('a'.repeat(200)));
});

test('listArticles filters lowercase/digit-prefixed and sorts by mtime', async () => {
  const dir = await makeFixture({
    'README.md': '# Readme',
    'PLAN.md': '# Plan',
    'first.md': '# First\n\nFirst article body.\n',
    'second.md': '# Second\n\nSecond article body.\n',
    '2026-04-14-dated.md': '# Dated\n\nDated article body.\n',
    'notes.txt': 'ignored',
  });
  // Force distinct mtimes
  const now = Date.now();
  await fs.utimes(path.join(dir, 'first.md'), now / 1000, (now - 120_000) / 1000);
  await fs.utimes(path.join(dir, 'second.md'), now / 1000, (now - 60_000) / 1000);
  await fs.utimes(path.join(dir, '2026-04-14-dated.md'), now / 1000, now / 1000);

  const articles = await listArticles({ dir });
  assert.strictEqual(articles.length, 3);
  assert.strictEqual(articles[0].slug, '2026-04-14-dated');
  assert.strictEqual(articles[1].slug, 'second');
  assert.strictEqual(articles[2].slug, 'first');
  assert.strictEqual(articles[0].title, 'Dated');
});

test('listArticles returns empty when dir missing', async () => {
  const articles = await listArticles({ dir: '/nonexistent/heimdall/read-test' });
  assert.deepStrictEqual(articles, []);
});
