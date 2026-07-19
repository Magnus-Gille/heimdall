'use strict';

/**
 * cards.js — the card-registry primitive. A page is a LIST of card descriptors
 * rendered into one grid, instead of hand-writing each <div hx-get> placeholder
 * + a route + a renderer in three different files (the v1 triple-declaration).
 *
 * A card is either:
 *   - LIVE:   { endpoint, refresh, trigger }  → an HTMX placeholder that fetches
 *             its own fragment (the fragment supplies its full inner HTML).
 *   - STATIC: { body, title }                 → fully server-rendered now.
 * Plus layout: { fullWidth | span, href, id, className }.
 */

const { esc } = require('./util');

function spanClass({ fullWidth, span } = {}) {
  if (fullWidth) return ' col-full';
  if (span === 2) return ' col-2';
  return '';
}

/** Render one card descriptor to HTML. */
function card(desc = {}) {
  const cls = `card${spanClass(desc)}${desc.className ? ' ' + esc(desc.className) : ''}`;
  const idAttr = desc.id ? ` id="${esc(desc.id)}"` : '';

  // LIVE card — HTMX placeholder; the fragment owns its inner HTML.
  if (desc.endpoint) {
    const trigger = desc.trigger || (desc.refresh ? `load, every ${desc.refresh}s` : 'load');
    const loading = desc.loading || 'Loading…';
    return `<div class="${cls}"${idAttr} hx-get="${esc(desc.endpoint)}" hx-trigger="${esc(trigger)}" hx-swap="innerHTML">
      <div class="loading">${esc(loading)}</div>
    </div>`;
  }

  // STATIC card — rendered now.
  const head = desc.title ? `<div class="card-head"><span class="card-title">${esc(desc.title)}</span>${desc.headExtra || ''}</div>` : '';
  const inner = `${head}${desc.body || ''}`;
  if (desc.href) {
    return `<a class="${cls}"${idAttr} href="${esc(desc.href)}">${inner}</a>`;
  }
  return `<div class="${cls}"${idAttr}>${inner}</div>`;
}

/** Render an array of card descriptors (or raw HTML strings) into one grid. */
function grid(cards = []) {
  const html = cards
    .filter(Boolean)
    .map((c) => (typeof c === 'string' ? c : card(c)))
    .join('\n');
  return `<main class="grid">\n${html}\n</main>`;
}

/** A page section with a heading, then a grid. */
function section({ title, sub } = {}, cards = []) {
  const head = title
    ? `<div class="page-head"><h2 class="page-title">${esc(title)}</h2>${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}</div>`
    : '';
  return `${head}${grid(cards)}`;
}

module.exports = { card, grid, section, spanClass };
