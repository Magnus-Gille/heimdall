'use strict';

const crypto = require('crypto');
const { parse: markedParse } = require('marked');

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

function xmlEsc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Post-process marked HTML → XHTML: self-close void elements, ensure <br/>, <hr/>, <img/>
function toXhtml(html) {
  return html
    .replace(/<(br|hr)(\s[^>]*)?>/gi, '<$1$2 />')
    .replace(/<img\b([^>]*?)(?<!\/)>/gi, '<img$1 />')
    .replace(/<(br|hr|img)(\s[^>]*?)\s+\/\s+\/>/gi, '<$1$2 />');
}

const CONTENT_CSS = `@namespace epub "http://www.idpf.org/2007/ops";
html { font-family: Georgia, "Iowan Old Style", "Charter", serif; }
body { margin: 1em auto; max-width: 36em; padding: 0 1em; line-height: 1.55; color: #1a1a1a; }
h1, h2, h3, h4 { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; line-height: 1.25; }
h1 { font-size: 1.6em; margin: 1em 0 0.5em; }
h2 { font-size: 1.25em; margin: 1.5em 0 0.4em; }
h3 { font-size: 1.08em; margin: 1.3em 0 0.3em; }
p { margin: 0.6em 0; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #aaa; color: #555; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f4; padding: 0 0.2em; }
pre { background: #f4f4f4; padding: 0.8em; overflow-x: auto; font-size: 0.85em; line-height: 1.4; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
th, td { border: 1px solid #bbb; padding: 0.3em 0.6em; text-align: left; }
th { background: #eee; }
hr { border: 0; border-top: 1px solid #bbb; margin: 2em 0; }
`;

function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function packageOpf({ bookId, title, author, language, modified }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="${OPF_NS}" version="3.0" unique-identifier="book-id" xml:lang="${xmlEsc(language)}">
  <metadata xmlns:dc="${DC_NS}">
    <dc:identifier id="book-id">${xmlEsc(bookId)}</dc:identifier>
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:creator>${xmlEsc(author)}</dc:creator>
    <dc:language>${xmlEsc(language)}</dc:language>
    <meta property="dcterms:modified">${xmlEsc(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>
`;
}

function navXhtml({ title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" xml:lang="en" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${xmlEsc(title)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="content.xhtml">${xmlEsc(title)}</a></li>
    </ol>
  </nav>
</body>
</html>
`;
}

function contentXhtml({ title, bodyXhtml, source }) {
  const sourceNote = source
    ? `<p class="source"><small>Source: ${xmlEsc(source)}</small></p>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" xml:lang="en" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${xmlEsc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <section epub:type="chapter">
    ${bodyXhtml}
    ${sourceNote}
  </section>
</body>
</html>
`;
}

/**
 * Build an EPUB3 buffer from a single markdown article.
 * @param {object} opts
 * @param {string} opts.title - Book/chapter title.
 * @param {string} opts.markdown - Markdown content.
 * @param {string} [opts.author] - Creator. Default: 'Heimdall'.
 * @param {string} [opts.language] - IETF tag. Default: 'en'.
 * @param {string} [opts.identifier] - Unique URN/UUID. Default: generated UUIDv4.
 * @param {string} [opts.source] - Original source URL/path.
 * @param {Date}   [opts.modified] - Modified timestamp. Default: now.
 * @returns {Promise<Buffer>} - EPUB file bytes.
 */
async function buildEpub(opts) {
  const {
    title,
    markdown,
    author = 'Heimdall',
    language = 'en',
    identifier = `urn:uuid:${crypto.randomUUID()}`,
    source = null,
    modified = new Date(),
  } = opts;

  if (!title) throw new Error('buildEpub: title is required');
  if (typeof markdown !== 'string') throw new Error('buildEpub: markdown must be a string');

  const bodyHtml = markedParse(markdown, { async: false });
  const bodyXhtml = toXhtml(bodyHtml);
  const modIso = modified.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // archiver v8 is ESM-only; dynamic import keeps this CommonJS module usable
  // on every supported Node runtime.
  const { ZipArchive } = await import('archiver');
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.on('data', c => chunks.push(c));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
  });

  // mimetype MUST be first and STORED (no compression).
  archive.append('application/epub+zip', { name: 'mimetype', store: true });
  archive.append(containerXml(), { name: 'META-INF/container.xml' });
  archive.append(
    packageOpf({ bookId: identifier, title, author, language, modified: modIso }),
    { name: 'OEBPS/package.opf' }
  );
  archive.append(navXhtml({ title }), { name: 'OEBPS/nav.xhtml' });
  archive.append(contentXhtml({ title, bodyXhtml, source }), { name: 'OEBPS/content.xhtml' });
  archive.append(CONTENT_CSS, { name: 'OEBPS/style.css' });

  await archive.finalize();
  return done;
}

module.exports = { buildEpub, toXhtml, xmlEsc };
