'use strict';

/**
 * Ticket-system (Plane CE + ticket-gateway) health probe — GRIM-245.
 *
 * ticket-gateway answers `GET /health` without authentication with
 * `{"status":"ok","plane":{"reachable":true}}`, so one poll covers both the gateway
 * and Plane's API as the gateway sees it. Two boolean metrics are stored under host
 * `m5` and evaluated by the generic alert engine (collector §9b) via the rules on the
 * `ticket-system` descriptor — same 2-streak semantics as the inference/MCP probes.
 *
 * The URL is deployment configuration (`TICKET_GATEWAY_HEALTH_URL`, e.g. the gateway's
 * public `/health`). It has no default: when unset the probe is skipped entirely, so an
 * unconfigured Heimdall neither alerts nor shows a card.
 *
 * Only the two fields above are read; no response body is persisted.
 */

const { SCHEMA_ID } = require('./contract/schema');

const TIMEOUT_MS = 5000;
const HOST = 'm5';

/** Pure: collapse a parsed /health body into the two health booleans. */
function classifyHealth(body) {
  const gateway = !!(body && body.status === 'ok');
  const plane = !!(gateway && body.plane && body.plane.reachable === true);
  return { gateway, plane };
}

/**
 * @returns {Promise<{configured:boolean, gateway_healthy:boolean, plane_healthy:boolean, latency_ms:number|null, error:string|null}>}
 */
async function probeTicketSystem(url = process.env.TICKET_GATEWAY_HEALTH_URL, fetchImpl = fetch) {
  if (!url) {
    return { configured: false, gateway_healthy: false, plane_healthy: false, latency_ms: null, error: null };
  }
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'manual' });
    const latency = Date.now() - start;
    if (res.status !== 200) {
      return { configured: true, gateway_healthy: false, plane_healthy: false, latency_ms: latency, error: `health HTTP ${res.status}` };
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON → unhealthy below */ }
    if (!body) {
      return { configured: true, gateway_healthy: false, plane_healthy: false, latency_ms: latency, error: 'health body not JSON' };
    }
    const c = classifyHealth(body);
    let error = null;
    if (!c.gateway) error = 'health status not ok';
    else if (!c.plane) error = 'plane unreachable from gateway';
    return { configured: true, gateway_healthy: c.gateway, plane_healthy: c.plane, latency_ms: latency, error };
  } catch (err) {
    return {
      configured: true, gateway_healthy: false, plane_healthy: false, latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe and store metrics. A no-op (returns configured:false) when no URL is configured. */
async function collectTicketSystemHealth(db, timestamp, url, fetchImpl) {
  const { insertMetrics } = require('./db');
  const r = await probeTicketSystem(url, fetchImpl);
  if (!r.configured) return r;
  const rows = [
    { timestamp, host: HOST, metric: 'ticket_gateway_healthy', value: r.gateway_healthy ? 1 : 0, unit: 'boolean', metadata: null },
    { timestamp, host: HOST, metric: 'ticket_latency_ms', value: r.latency_ms, unit: 'ms', metadata: null },
    { timestamp, host: HOST, metric: 'ticket_error', value: null, unit: 'text', metadata: r.error ? { error: r.error } : null },
  ];
  // Plane's state is only known when the gateway answered; a gateway outage must not
  // also raise a (false) "Plane unreachable" alert, so the Plane metric is skipped then.
  if (r.gateway_healthy) {
    rows.push({ timestamp, host: HOST, metric: 'ticket_plane_healthy', value: r.plane_healthy ? 1 : 0, unit: 'boolean', metadata: null });
  }
  insertMetrics(db, rows);
  return r;
}

function buildTicketSystemDescriptor(opts = {}) {
  return {
    _schema: SCHEMA_ID,
    service: { name: 'ticket-system', label: 'Ticket system', namespace: 'grimnir', instance_id: HOST, criticality: 'high' },
    kind: 'http-service',
    status: opts.status !== undefined ? opts.status : null,
    version: null,
    metrics: [],
    alerts: {
      rules: [
        {
          metric: 'ticket_gateway_healthy', op: '==', value: 0, streak: 2,
          severity: 'warning', title: 'Ticket gateway unhealthy',
          detail: 'ticket-gateway /health is failing — agents cannot read or file tickets.',
          error_metric: 'ticket_error',
        },
        {
          metric: 'ticket_plane_healthy', op: '==', value: 0, streak: 2,
          severity: 'warning', title: 'Plane unreachable from ticket gateway',
          detail: 'ticket-gateway reports Plane unreachable — the ticket system is down.',
          error_metric: 'ticket_error',
        },
      ],
      active_count: 0,
      firing: [],
    },
    panels: [],
    links: { repo: 'https://github.com/Magnus-Gille/ticket-system' },
    ui: { icon: 'ticket', category: 'infra' },
  };
}

/** Snapshot for the ticket system — status from the latest collected metrics; null when never polled. */
function ticketSystemSnapshot(db, deps = {}) {
  const now = deps.now || Date.now();
  const getLatest = deps.getLatestMetrics || require('./db').getLatestMetrics;
  const seen = {};
  try {
    for (const r of (db ? getLatest(db, HOST) : []) || []) {
      if (r && (r.metric === 'ticket_gateway_healthy' || r.metric === 'ticket_plane_healthy')) seen[r.metric] = r.value;
    }
  } catch { /* best-effort: no metrics yet */ }
  const polled = 'ticket_gateway_healthy' in seen;
  const status = !polled ? null
    : (seen.ticket_gateway_healthy === 1 && seen.ticket_plane_healthy === 1) ? 'pass' : 'fail';
  return {
    service: 'ticket-system', kind: 'http-service', status,
    descriptor: buildTicketSystemDescriptor({ status }),
    fetchedAt: new Date(now).toISOString(), reachable: polled,
    schemaVersion: SCHEMA_ID, source: 'plugin',
    error: polled ? null : 'no ticket-system metrics collected yet',
  };
}

module.exports = {
  classifyHealth, probeTicketSystem, collectTicketSystemHealth,
  buildTicketSystemDescriptor, ticketSystemSnapshot,
};
