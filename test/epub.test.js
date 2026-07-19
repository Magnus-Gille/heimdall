'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { buildEpub, toXhtml } = require('../src/epub');

function readZipEntries(buf) {
  // Parse minimal ZIP central directory to list entries.
  // Find End Of Central Directory (EOCD) — signature 0x06054b50.
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    // Central directory signature 0x02014b50
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'bad CD signature');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  // Local file header at entry.localHeaderOffset:
  //   0..3   signature 0x04034b50
  //   26..27 nameLen, 28..29 extraLen
  //   30+    name, then extra, then data.
  const lfh = entry.localHeaderOffset;
  assert.strictEqual(buf.readUInt32LE(lfh), 0x04034b50);
  const nameLen = buf.readUInt16LE(lfh + 26);
  const extraLen = buf.readUInt16LE(lfh + 28);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported method ${entry.method}`);
}

test('buildEpub produces a ZIP with EPUB3 structure', async () => {
  const buf = await buildEpub({
    title: 'Test Article',
    markdown: '# Heading\n\nSome *italic* and **bold** text with a <br>manual break.\n\n- one\n- two\n',
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 200);

  // First entry must be "mimetype" and STORED (method 0).
  // Local file header sig 0x04034b50 at offset 0.
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
  const firstMethod = buf.readUInt16LE(8);
  assert.strictEqual(firstMethod, 0, 'mimetype must be stored (method 0)');
  const firstNameLen = buf.readUInt16LE(26);
  const firstName = buf.slice(30, 30 + firstNameLen).toString('utf8');
  assert.strictEqual(firstName, 'mimetype');

  const entries = readZipEntries(buf);
  const names = entries.map(e => e.name).sort();
  assert.deepStrictEqual(names, [
    'META-INF/container.xml',
    'OEBPS/content.xhtml',
    'OEBPS/nav.xhtml',
    'OEBPS/package.opf',
    'OEBPS/style.css',
    'mimetype',
  ]);
});

test('buildEpub embeds title and converts markdown', async () => {
  const buf = await buildEpub({
    title: 'My <Funky> Title',
    markdown: '## Hello\n\nLorem ipsum dolor sit amet.\n',
    author: 'Magnus',
  });
  const entries = readZipEntries(buf);
  const byName = Object.fromEntries(entries.map(e => [e.name, e]));
  const mimetype = readEntry(buf, byName['mimetype']).toString('utf8');
  assert.strictEqual(mimetype, 'application/epub+zip');
  const opf = readEntry(buf, byName['OEBPS/package.opf']).toString('utf8');
  assert.match(opf, /My &lt;Funky&gt; Title/);
  assert.match(opf, /<dc:creator>Magnus<\/dc:creator>/);
  const content = readEntry(buf, byName['OEBPS/content.xhtml']).toString('utf8');
  assert.match(content, /Lorem ipsum dolor sit amet/);
  assert.match(content, /<h2/);
});

test('toXhtml self-closes void elements', () => {
  assert.strictEqual(toXhtml('a<br>b'), 'a<br />b');
  assert.strictEqual(toXhtml('<hr>'), '<hr />');
  assert.strictEqual(toXhtml('<img src="x.png" alt="">'), '<img src="x.png" alt="" />');
  // Already self-closed should survive
  assert.strictEqual(toXhtml('<br/>'), '<br/>');
});

test('buildEpub requires title and markdown', async () => {
  await assert.rejects(() => buildEpub({ markdown: 'x' }), /title is required/);
  await assert.rejects(() => buildEpub({ title: 't' }), /markdown must be a string/);
});
