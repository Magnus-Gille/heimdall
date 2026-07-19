'use strict';

/**
 * read.js — the /read article reader, rendered through the v2 shell (pageShell)
 * so it shares the one nav + design system. Reader-specific styling lives in
 * /css/reader.css; the font-size control script is external (/reader.js) to
 * satisfy CSP `script-src 'self'`. Replaces the v1 readListPage/readArticlePage
 * (which carried their own <head>, old nav, and inline scripts).
 */

const { parse: markedParse } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { pageShell } = require('./shell');
const { esc } = require('./util');

/**
 * Allowlist config for sanitize-html: permits normal article markup
 * (headings, paragraphs, lists, links, images, code, blockquotes, tables,
 * emphasis) while stripping <script>, <style>, on* attributes, and
 * javascript: URLs.
 */
const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'del', 's', 'sup', 'sub',
    'a', 'img',
    'pre', 'code',
    'blockquote',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'div', 'span',
  ],
  allowedAttributes: {
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'th': ['scope', 'colspan', 'rowspan'],
    'td': ['colspan', 'rowspan'],
    'code': ['class'],       // syntax-highlight class names
    'pre': ['class'],
    'div': ['class'],
    'span': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],   // data: URIs are common in markdown renderers
  },
  // Reject protocol-relative URLs (//evil.com) — allowedSchemes already covers
  // http/https but doesn't block scheme-less URLs by default.
  allowProtocolRelative: false,
  // Strip on* event-handler attributes globally (belt-and-suspenders on top of
  // the allowedAttributes allowlist, which already excludes them).
  disallowedTagsMode: 'discard',
  // Force rel="noopener noreferrer" on any link with target="_blank" to prevent
  // tabnabbing (opener gaining access to the originating window).
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.target === '_blank') {
        return { tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } };
      }
      return { tagName, attribs };
    },
  },
};

function formatReadDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatReadingTime(wordCount) {
  if (!wordCount) return '';
  const minutes = Math.max(1, Math.round(wordCount / 220));
  return `${minutes} min read`;
}

function readerCssLink(gitVersion) {
  return `  <link rel="stylesheet" href="/css/reader.css?v=${esc(gitVersion || 'dev')}">`;
}

/** Article list (/read). */
function readListPage(gitVersion, articles) {
  const cards = articles && articles.length
    ? articles.map((a) => `
      <a href="/read/${esc(a.slug)}" class="reader-card">
        <h2 class="reader-card-title">${esc(a.title)}</h2>
        <div class="reader-card-meta">
          <time datetime="${esc(a.mtimeIso)}">${esc(formatReadDate(a.mtimeIso))}</time>
          <span class="reader-card-dot">·</span>
          <span>${esc(formatReadingTime(a.wordCount))}</span>
        </div>
        ${a.excerpt ? `<p class="reader-card-excerpt">${esc(a.excerpt)}</p>` : ''}
      </a>`).join('\n')
    : '<p class="reader-empty">No research documents found.</p>';

  const content = `
    <main class="reader-list">
      <div class="reader-list-header">
        <h2>Research &amp; notes</h2>
        <p class="reader-list-sub">Long-form writing from the home-server inference evaluation.</p>
      </div>
      <div class="reader-card-grid">
${cards}
      </div>
    </main>`;

  return pageShell({
    title: 'Heimdall — Read',
    active: '/read',
    gitVersion,
    content,
    head: readerCssLink(gitVersion),
  });
}

/** Single article (/read/:slug). */
function readArticlePage(gitVersion, article, navigation = {}) {
  const { prev = null, next = null } = navigation;
  // TRUST BOUNDARY: article.markdown comes from author-controlled local files
  // under ~/mimir/reading (src/read-docs.js). marked renders it to HTML, which
  // is then sanitized via sanitize-html (SANITIZE_OPTIONS above) as
  // defense-in-depth against injected <script>, on* handlers, and javascript:
  // URLs — in case the directory ever ingests external/untrusted markdown.
  // The existing CSP (script-src 'self') is kept as a second layer. See heimdall#46.
  const body = sanitizeHtml(markedParse(article.markdown), SANITIZE_OPTIONS);
  const prevLink = prev ? `<a class="reader-nav-prev" href="/read/${esc(prev.slug)}">← ${esc(prev.title)}</a>` : '<span></span>';
  const nextLink = next ? `<a class="reader-nav-next" href="/read/${esc(next.slug)}">${esc(next.title)} →</a>` : '<span></span>';

  const content = `
    <nav class="reader-breadcrumb" aria-label="Breadcrumb">
      <a href="/read" class="reader-back">← Read</a>
      <div class="reader-tools">
        <div class="reader-font-controls" role="group" aria-label="Font size">
          <button type="button" class="reader-font-btn" data-size="sm" aria-label="Smaller text">A−</button>
          <button type="button" class="reader-font-btn" data-size="md" aria-label="Default text">A</button>
          <button type="button" class="reader-font-btn" data-size="lg" aria-label="Larger text">A+</button>
        </div>
        <a class="reader-epub" href="/read/${esc(article.slug)}.epub" download>⇩ EPUB</a>
      </div>
    </nav>

    <article class="reader-article" data-reader-size="md">
      <header class="reader-article-header">
        <h1>${esc(article.title)}</h1>
        <div class="reader-article-meta">
          <time datetime="${esc(article.mtimeIso)}">${esc(formatReadDate(article.mtimeIso))}</time>
          <span class="reader-card-dot">·</span>
          <span>${esc(formatReadingTime(article.wordCount))}</span>
        </div>
      </header>
      <div class="reader-prose">${body}</div>
      <nav class="reader-article-nav" aria-label="Article">
        ${prevLink}
        ${nextLink}
      </nav>
    </article>`;

  const head = `${readerCssLink(gitVersion)}
  <script src="/reader.js?v=${esc(gitVersion || 'dev')}"></script>`;

  return pageShell({
    title: `${article.title} — Heimdall`,
    active: '/read',
    gitVersion,
    content,
    head,
  });
}

module.exports = { readListPage, readArticlePage, formatReadDate, formatReadingTime };
