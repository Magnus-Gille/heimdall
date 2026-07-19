'use strict';

/**
 * plugins/hugin.js — the Hugin task-dispatcher panel plugin (v2 platform).
 *
 * Renders the Hugin dispatcher's domain panels (tasks, history) on the GENERIC
 * service page by reusing the proven v1 data layer (`src/hugin.js`) and card
 * renderers (`src/html.js`).
 *
 * Mirrors the v1 `/api/card/hugin-tasks` and `/api/card/task-history` route
 * bodies exactly, so the panels show the same data as the old v1 `/tasks` page.
 * (P4 will fold the v1 `/tasks` page into the v2 Services drill-down and retire it.)
 *
 * Every external dependency (`hugin`, `html`) is injectable via `deps` for tests —
 * the data layer opens the real Munin SQLite DB; tests stub it out entirely.
 */

const HUGIN = require('../hugin');
const HTML = require('../html');
const { esc } = require('../render/util');

const PLUGIN_CSS = '/css/hugin.css';

/**
 * Render one Hugin panel to an HTML fragment string. Mirrors the v1
 * `/api/card/hugin-tasks` and `/api/card/task-history` route bodies exactly.
 *
 * @param {object} panel  a normalized descriptor panel ({ id, view, ... })
 * @param {object} deps   { hugin, html }
 * @returns {Promise<string>}
 */
async function renderPanel(panel, deps = {}) {
  // Scope wrapper: the reused v1 renderers (huginTasksCard/taskHistoryCard) emit
  // inline v1 color vars (--green/--amber/--red/--muted) which the v2 token layer
  // doesn't define. `.hugin-panel` (hugin.css) aliases them to v2 --status-* so
  // status cues colour correctly here, without touching the shared v1 renderer
  // (still used by the v1 /tasks page, which has its own --green/etc.).
  return `<div class="hugin-panel">${await renderPanelInner(panel, deps)}</div>`;
}

async function renderPanelInner(panel, deps = {}) {
  const hugin = deps.hugin || HUGIN;
  const html = deps.html || HTML;

  const view = (panel && typeof panel.view === 'string' && panel.view) ? panel.view : null;

  try {
    switch (view) {
      case 'tasks': {
        const tasks = hugin.readHuginTasks();
        const successRate = hugin.getTaskSuccessRate(tasks, 7);
        const queueMetrics = hugin.getTaskQueueMetrics(tasks);
        const heartbeat = hugin.readHuginHeartbeat();
        const timeoutCal = hugin.getTimeoutCalibration(30);
        return html.huginTasksCard(tasks, successRate, queueMetrics, heartbeat, timeoutCal);
      }

      case 'history': {
        const tasks = hugin.readHuginTasks({ limit: 1000 });
        return html.taskHistoryCard(tasks, 1);
      }

      default:
        return `<h3>${esc((panel && (panel.label || panel.id)) || 'Panel')}</h3>`
          + `<div class="hugin-note">Unknown Hugin panel view "${esc(String(view))}".</div>`;
    }
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    return `<div class="hugin-note">Hugin panel error: ${esc(msg)}</div>`;
  }
}

/** The plugin descriptor registered in plugins/index.js. */
const plugin = {
  name: 'hugin',
  css: PLUGIN_CSS,
  renderPanel,
};

module.exports = {
  plugin,
  renderPanel,
  PLUGIN_CSS,
};
