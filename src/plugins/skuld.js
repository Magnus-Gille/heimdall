'use strict';

/**
 * plugins/skuld.js — the Skuld daily briefing panel plugin (v2 platform).
 *
 * Renders the Skuld briefing on the generic service page by reusing the
 * proven v1 data layer (`src/skuld-briefing.js`) and card renderer
 * (`src/html.js#briefingFullCard`).
 *
 * Mirrors the v1 `/api/card/briefing-full` route body, so the panel shows
 * the same data as the old v1 `/briefing` page. (P4 folds the v1 `/briefing`
 * page into the v2 Services drill-down via this plugin.)
 *
 * Every external dependency (`skuld`, `html`) is injectable via `deps` for
 * tests — the data layer calls the real Munin HTTP API; tests stub it out.
 */

const SKULD = require('../skuld-briefing');
const HTML = require('../html');
const { esc } = require('../render/util');

const PLUGIN_CSS = '/css/skuld.css';

/**
 * Render one Skuld panel to an HTML fragment string.
 *
 * @param {object} panel  a normalized descriptor panel ({ id, view, ... })
 * @param {object} deps   { skuld, html }
 * @returns {Promise<string>}
 */
async function renderPanel(panel, deps = {}) {
  // Scope wrapper: the reused v1 renderer (briefingFullCard) emits inline
  // v1 color vars (--card-bg/--bg-hover). `.skuld-panel` (skuld.css) aliases
  // them to v2 semantic tokens, scoped to the plugin's own output so the
  // v1 /briefing page (own palette) is unaffected.
  return `<div class="skuld-panel">${await renderPanelInner(panel, deps)}</div>`;
}

async function renderPanelInner(panel, deps = {}) {
  const skuld = deps.skuld || SKULD;
  const html = deps.html || HTML;

  const view = (panel && typeof panel.view === 'string' && panel.view) ? panel.view : null;

  try {
    switch (view) {
      case 'briefing': {
        const briefing = await skuld.fetchLatestBriefing();
        return html.briefingFullCard(briefing);
      }

      default:
        return `<h3>${esc((panel && (panel.label || panel.id)) || 'Panel')}</h3>`
          + `<div class="skuld-note">Unknown Skuld panel view "${esc(String(view))}".</div>`;
    }
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    return `<div class="skuld-note">Skuld panel error: ${esc(msg)}</div>`;
  }
}

/** The plugin descriptor registered in plugins/index.js. */
const plugin = {
  name: 'skuld',
  css: PLUGIN_CSS,
  renderPanel,
};

module.exports = {
  plugin,
  renderPanel,
  PLUGIN_CSS,
};
