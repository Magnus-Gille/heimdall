'use strict';

/**
 * projects.js — the /projects page, rendered through the v2 shell (pageShell).
 * Project-specific styling lives in /css/projects.css. The page body is two
 * HTMX card wrappers that call fragment routes already registered in server.js:
 *   - /api/card/consolidation-health  (memory consolidation summary)
 *   - /api/card/projects-list         (full project tree)
 * No data-fetching happens here — the renderers (consolidationHealthCard,
 * projectsListCard) are served by the existing fragment routes unchanged.
 */

const { pageShell } = require('./shell');
const { esc } = require('./util');

function projectsCssLink(gitVersion) {
  return `  <link rel="stylesheet" href="/css/projects.css?v=${esc(gitVersion || 'dev')}">`;
}

function projectsPage(gitVersion) {
  const content = `
    <div class="projects-page">
      <div class="proj-page-header">
        <h1>Projects</h1>
        <p class="proj-page-sub">Active work, roadmap status, and memory consolidation health.</p>
      </div>
      <main class="grid">
        <div class="card col-full" hx-get="/api/card/consolidation-health" hx-trigger="load, every 300s" hx-swap="innerHTML">
          <div class="loading">Loading consolidation health...</div>
        </div>
        <div class="card col-full" hx-get="/api/card/projects-list" hx-trigger="load, every 300s" hx-swap="innerHTML">
          <div class="loading">Loading projects...</div>
        </div>
      </main>
    </div>`;

  return pageShell({
    title: 'Heimdall — Projects',
    active: '/projects',
    gitVersion,
    content,
    head: projectsCssLink(gitVersion),
    lastUpdated: true,
  });
}

module.exports = { projectsPage };
