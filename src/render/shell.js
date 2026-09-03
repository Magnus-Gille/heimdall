'use strict';

/**
 * shell.js — the ONE page shell. Replaces the ~6 copy-pasted page functions
 * (head + nav + theme toggle) in html.js. All JS is external (/app.js) to
 * satisfy CSP `script-src 'self'` — the v1 inline theme scripts were actually
 * being blocked by the CSP.
 */

const { esc } = require('./util');

// Live v2 routes. Alerts carries a live count badge (see /api/alerts/count).
const NAV = [
  { href: '/',              label: 'Overview' },
  { href: '/fleet',         label: 'Fleet' },
  { href: '/services',      label: 'Services' },
  { href: '/supervision',   label: 'Units' },
  { href: '/reliability',   label: 'Reliability' },
  { href: '/alerts',        label: 'Alerts', badge: true },
  { href: '/projects',      label: 'Projects' },
  { href: '/insights',      label: 'Insights' },
  { href: '/read',          label: 'Read' },
];

function renderNav(active) {
  return NAV.map((item) => {
    const isActive = item.href === active ? ' class="active"' : '';
    const aria = item.href === active ? ' aria-current="page"' : '';
    // The Alerts badge mounts itself via HTMX and self-refreshes, so the count is
    // live on every page without each page render having to compute it.
    const badge = item.badge
      ? `<span class="nav-badge-mount" hx-get="/api/alerts/count" hx-trigger="load, every 60s" hx-swap="innerHTML"></span>`
      : '';
    return `<a href="${esc(item.href)}"${isActive}${aria}>${esc(item.label)}${badge}</a>`;
  }).join('');
}

/**
 * Render a full HTML page.
 * opts: { title, active, gitVersion, content, head, charts, lastUpdated }
 */
function pageShell(opts = {}) {
  const {
    title = 'Heimdall',
    active = '/',
    gitVersion = 'dev',
    content = '',
    head = '',
    charts = false,
    lastUpdated = false,
  } = opts;

  const v = esc(gitVersion || 'dev');
  const chartHead = charts
    ? `\n  <script src="/chart.umd.min.js"></script>\n  <script src="/chartjs-adapter-date-fns.bundle.min.js"></script>`
    : '';
  const chartFoot = charts ? `\n  <script src="/charts-client.js?v=${v}"></script>` : '';

  const lastUpdatedEl = lastUpdated
    ? `<span class="last-updated" hx-get="/api/card/last-updated" hx-trigger="load, every 30s" hx-swap="innerHTML"></span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <title>${esc(title)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>👁</text></svg>">
  <link rel="stylesheet" href="/css/tokens.css?v=${v}">
  <link rel="stylesheet" href="/css/layout.css?v=${v}">
  <link rel="stylesheet" href="/css/components.css?v=${v}">
  <script src="/app.js?v=${v}"></script>
  <script src="/htmx.min.js"></script>${chartHead}
${head}
</head>
<body>
  <header class="app-header">
    <a href="/" class="brand">
      <img src="/heimdall-logo.png" alt="" class="brand-logo">
      <span class="brand-name">Heimdall</span>
    </a>
    <nav class="nav" aria-label="Primary">${renderNav(active)}</nav>
    <div class="header-meta">
      ${lastUpdatedEl}
      <button class="theme-toggle" title="Toggle dark/light theme" aria-label="Toggle dark/light theme">◐</button>
    </div>
  </header>

  <div class="page">
    ${content}
  </div>

  <footer class="app-footer">
    <span>Heimdall v${v}</span>
    <span>Bifröst watch</span>
  </footer>${chartFoot}
</body>
</html>`;
}

module.exports = { pageShell, renderNav, NAV };
