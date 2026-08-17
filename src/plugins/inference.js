'use strict';

/**
 * plugins/inference.js — the inference panel plugin (v2 platform).
 *
 * This is the ONE piece of genuinely service-specific code in the platform. It
 * renders the M5 inference box's focused operator view (live state, basic use,
 * and available models) on the generic service-page platform, by reusing the
 * proven v1 data layer (`src/m5.js`) and card renderers (`src/html.js`).
 *
 * Why reuse rather than re-implement: M5 parity is the P2 acceptance gate, and
 * the lowest-risk path to byte-for-byte parity is to call the exact same fetch /
 * parse / summarize / render functions the live `/m5` page uses. Until P4 retires
 * the v1 `/m5` page, `m5.js`/`html.js` remain the single source of truth and this
 * plugin is a thin, additive seam over them. (P4 will physically fold them in and
 * delete the v1 page + its `.m5-*` CSS namespace.)
 *
 * It also builds the M5 service descriptor Heimdall-side: the gateway does not yet
 * serve `/heimdall.json`, so Heimdall self-describes M5 (kind "inference") the same
 * way it self-describes itself (`selfSnapshot`). Panels carry a `view` so the same
 * plugin could later drive other inference services (Ollama nodes) without
 * instance-specific ids.
 *
 * The gateway base + Bearer key resolution mirrors v1 exactly: the data functions
 * default to `HOMESERVER_GATEWAY_URL` / `HOMESERVER_GATEWAY_API_KEY` (env). Every
 * external dependency (`m5`, `html`, `db`, `fs`, `env`) is injectable via `deps`
 * for tests — `fetchLedger` has no `_fetch` seam, so tests override `deps.m5`.
 */

const M5 = require('../m5');
const HTML = require('../html');
const DB = require('../db');
const { esc } = require('../render/util');
const { SCHEMA_ID } = require('../contract/schema');

const PLUGIN_CSS = '/css/inference.css';
const GATEWAY_DEFAULT = process.env.HOMESERVER_GATEWAY_URL || 'http://127.0.0.1:8080';

/**
 * The M5 panel set — order, labels, refresh cadence and full-width flags carry
 * over from the retired v1 `/m5` page. `view` selects the renderer; `source`
 * documents the gateway endpoint each panel reads.
 */
const M5_PANELS = [
  { id: 'm5-overview', view: 'overview', label: 'M5 usage', source: '/ops/summary', refresh: 60, fullWidth: true },
  { id: 'm5-models', view: 'models', label: 'Models', source: '/models', refresh: 60, fullWidth: true },
];

/** Build the M5 service descriptor (Heimdall-side; the gateway has no /heimdall.json yet). */
function buildM5Descriptor(opts = {}) {
  const status = opts.status !== undefined ? opts.status : null;
  const b = String(opts.gatewayUrl || GATEWAY_DEFAULT).replace(/\/$/, '');
  return {
    _schema: SCHEMA_ID,
    service: { name: 'm5-gateway', label: 'M5 Inference', namespace: 'grimnir', instance_id: 'm5', criticality: 'high' },
    kind: 'inference',
    status,
    version: null,
    deploy: { deployed_commit: null, host: 'm5', systemd_unit: 'gille-inference', platform: 'bare-metal' },
    // Live values are shown by the status panel below; no generic metric-definition rows.
    metrics: [],
    // Declarative alert rule — evaluated by the generic alert engine (P3), which
    // replaces the old hardcoded streak logic in src/inference.js.
    alerts: {
      rules: [{
        metric: 'inference_healthy', op: '==', value: 0, streak: 2,
        severity: 'warning', title: 'M5 inference gateway unhealthy',
        detail: 'M5 inference gateway not responding — local sub-task delegation falls back to other runtimes.',
        error_metric: 'inference_error',
      }],
      active_count: 0,
      firing: [],
    },
    panels: M5_PANELS.map((p) => ({ ...p, plugin: 'inference' })),
    links: {
      health: `${b}/healthz`,
      metrics: `${b}/metrics`,
      operations: `${b}/ops/summary`,
      ledger: `${b}/ledger`,
      repo: 'https://github.com/Magnus-Gille/gille-inference',
    },
    ui: { icon: 'cpu', category: 'ai', color: '#7c3aed' },
  };
}

/**
 * Build the M5 service snapshot from collected metrics — the analogue of
 * `selfSnapshot`. Status is derived from the `inference_healthy` metric the
 * collector already stores under host `m5`. `reachable` reflects whether the
 * collector has ever polled (so the page shows "config-only" until it has).
 */
function m5Snapshot(db, deps = {}) {
  const now = deps.now || Date.now();
  const getLatest = deps.getLatestMetrics || DB.getLatestMetrics;
  let healthy = null;
  try {
    for (const r of (db ? getLatest(db, 'm5') : []) || []) {
      if (r && r.metric === 'inference_healthy') healthy = r.value;
    }
  } catch { /* best-effort: no metrics yet */ }
  const status = healthy === 1 ? 'pass' : healthy === 0 ? 'fail' : null;
  return {
    service: 'm5-gateway',
    kind: 'inference',
    status,
    descriptor: buildM5Descriptor({ status, gatewayUrl: deps.gatewayUrl }),
    fetchedAt: new Date(now).toISOString(),
    reachable: healthy != null,
    schemaVersion: SCHEMA_ID,
    source: 'plugin',
    error: healthy == null ? 'no inference metrics collected yet' : null,
  };
}

function instanceIdOf(descriptor) {
  return (descriptor && descriptor.service && descriptor.service.instance_id) || 'm5';
}

/** Fallback when a panel carries no explicit `view` (ids are `m5-<view>`). */
function viewOf(panel) {
  if (panel && typeof panel.view === 'string' && panel.view) return panel.view;
  if (panel && typeof panel.id === 'string') return panel.id.replace(/^m5-/, '');
  return null;
}

/**
 * Render one inference panel to an HTML fragment string. Mirrors the v1
 * `/api/card/m5-*` route bodies exactly, reusing the same data + render funcs.
 *
 * @param {object} panel  a normalized descriptor panel ({ id, view, ... })
 * @param {object} deps   { db, descriptor, m5, html, env, fs, getLatestMetrics, getLastCollectionTime }
 * @returns {Promise<string>}
 */
async function renderPanel(panel, deps = {}) {
  const m5 = deps.m5 || M5;
  const html = deps.html || HTML;
  const db = deps.db || null;
  const descriptor = deps.descriptor || {};
  const env = deps.env || process.env;
  const fsMod = deps.fs || require('fs');
  const getLatest = deps.getLatestMetrics || DB.getLatestMetrics;
  const getLastCollection = deps.getLastCollectionTime || DB.getLastCollectionTime;

  const view = viewOf(panel);
  // SECURITY: the gateway fetches below carry the M5 bearer token (HOMESERVER_GATEWAY_API_KEY),
  // so the base MUST come from trusted server config (HOMESERVER_GATEWAY_URL) — NEVER from
  // descriptor-supplied links. A descriptor arrives over the network (discovery, a trust boundary);
  // deriving the fetch base from its links would let a malicious service redirect the authenticated
  // request (and leak the token) to an attacker origin (SSRF). `deps.gatewayUrl` is a test seam only.
  const base = deps.gatewayUrl || GATEWAY_DEFAULT;

  switch (view) {
    case 'overview': {
      const [health, operations] = await Promise.all([
        m5.fetchHealth(base),
        m5.fetchOperations(base),
      ]);
      return html.m5OverviewCard({
        health,
        usage: operations.summary || null,
        error: operations.error || null,
      });
    }

    case 'status': {
      const map = {};
      try {
        for (const r of (db ? getLatest(db, instanceIdOf(descriptor)) : []) || []) {
          if (r && r.metric) map[r.metric] = r.value;
        }
      } catch { /* render empty state */ }
      let lastCollected = null;
      try { lastCollected = db ? getLastCollection(db, instanceIdOf(descriptor)) : null; } catch { /* ignore */ }
      return html.m5StatusCard({
        inference_healthy: map.inference_healthy,
        inference_latency_ms: map.inference_latency_ms,
        inference_ledger_pairs: map.inference_ledger_pairs,
        inference_recent_pass_rate: map.inference_recent_pass_rate,
        inference_recent_unverified_count: map.inference_recent_unverified_count,
        inference_avg_tok_per_sec: map.inference_avg_tok_per_sec,
        lastCollected,
      });
    }

    case 'capability-map': {
      const ledger = await m5.fetchLedger(base);
      if (ledger.error) return html.m5CapabilityMapCard(null, ledger.error);
      return html.m5CapabilityMapCard(m5.ledgerToMatrix(ledger.report));
    }

    case 'findings': {
      let generated = null;
      try {
        const ledger = await m5.fetchLedger(base);
        // Only generate (a ~30s LLM call) when the ledger is readable — exactly as v1.
        if (!ledger.error) {
          const tally = m5.tallyVerdicts(ledger.report);
          generated = await m5.generateFindings({ tally, baseUrl: base });
        }
      } catch { /* never break the page → static-only */ }
      return html.m5FindingsCard(m5.STATIC_FINDINGS, generated);
    }

    case 'models': {
      const result = await m5.fetchModels(base);
      if (result.error) return html.m5SimpleModelsCard(null, result.error);
      return html.m5SimpleModelsCard(m5.summarizeModels(result.models), null);
    }

    case 'usage': {
      const result = await m5.fetchMetrics(base);
      if (result.error) return html.m5UsageCard(null, result.error);
      const { samples, errors } = m5.parseMetrics(result.text);
      // Malformed/proxy-error body (parse errors, no valid samples) ≠ genuine empty registry.
      if (errors.length > 0 && samples.length === 0) return html.m5UsageCard(null, 'metrics malformed');
      return html.m5UsageCard(m5.summarizeUsageMetrics(samples), null);
    }

    case 'routing': {
      const snapshotPath = env.M5_ROUTING_JSON_PATH;
      if (snapshotPath) {
        try {
          if (fsMod.existsSync(snapshotPath)) {
            const snapshot = JSON.parse(fsMod.readFileSync(snapshotPath, 'utf8'));
            return html.m5RoutingCard(snapshot, null, null);
          }
        } catch (err) {
          // Malformed/unreadable snapshot — log (v1 parity) and fall through to live derivation.
          console.warn('[inference plugin] routing snapshot unreadable:', err && err.message);
        }
      }
      const ledger = await m5.fetchLedger(base);
      if (ledger.error) return html.m5RoutingCard(null, null, ledger.error);
      return html.m5RoutingCard(null, m5.deriveRoutingFromLedger(ledger.report), null);
    }

    default:
      return `<h3>${esc((panel && (panel.label || panel.id)) || 'Panel')}</h3>`
        + `<div class="m5-note">No inference renderer for view "${esc(String(view))}".</div>`;
  }
}

/** The plugin descriptor registered in plugins/index.js. */
const plugin = {
  name: 'inference',
  css: PLUGIN_CSS,
  renderPanel,
};

module.exports = {
  plugin,
  renderPanel,
  buildM5Descriptor,
  m5Snapshot,
  viewOf,
  M5_PANELS,
  PLUGIN_CSS,
};
