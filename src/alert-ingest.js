'use strict';

/**
 * alert-ingest.js — service-pushed alert ingestion (P3 alert bus, §6.2).
 *
 * A service (or Ratatoskr, echoing a forwarded alert) POSTs the standard alert
 * envelope to `POST /api/alerts`; Heimdall persists it to the same `alerts` table
 * the threshold engine writes, keyed by `dedup_key`. Both alert sources → one
 * surface. Framework-independent (returns {status, body}) so it is unit-testable,
 * mirroring fleet/ingest.js. Auth reuses the fleet fail-closed Bearer check.
 */

const { checkFleetAuth } = require('./fleet/auth');
const { createAlert, resolveAlertByDedupKey } = require('./db');

// Normalize the envelope severity (wire vocab: info|warn|error|critical, plus
// loose synonyms) to Heimdall's CANONICAL db vocabulary {info, warning, critical}
// — the same values createAlert callers use and computeOverallStatus keys on
// (src/status.js). Unknown → 'warning' so a pushed alert always surfaces.
const SEVERITY_CANON = {
  info: 'info', notice: 'info', low: 'info',
  warn: 'warning', warning: 'warning', medium: 'warning', degraded: 'warning',
  error: 'critical', critical: 'critical', crit: 'critical', fail: 'critical', high: 'critical',
};

const MAX_TITLE = 200;
const MAX_DETAIL = 2000;
const MAX_KEY = 200;
const MAX_SHORT = 120;

/**
 * Validate + normalize an alert envelope. Accepts either the bare alert object
 * or a `{ alert: {...} }` wrapper (the Ratatoskr envelope shape). `body` becomes
 * the persisted `detail`; `ts`/`links` are accepted but not stored (no column).
 * @returns {{ok: boolean, errors?: string[], value?: object}}
 */
function validateAlertEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const a = (body.alert && typeof body.alert === 'object' && !Array.isArray(body.alert)) ? body.alert : body;

  const errors = [];
  const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'firing';
  if (state !== 'firing' && state !== 'resolved') errors.push('state must be firing or resolved');
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (state === 'firing' && !title) errors.push('title is required for a firing alert');
  if (title.length > MAX_TITLE) errors.push(`title too long (max ${MAX_TITLE})`);
  const dedup_key = (typeof a.dedup_key === 'string' && a.dedup_key.trim())
    ? a.dedup_key.trim().slice(0, MAX_KEY)
    : null;
  if (state === 'resolved' && !dedup_key) errors.push('dedup_key is required for a resolved alert');
  if (errors.length) return { ok: false, errors };

  const rawSeverity = (typeof a.severity === 'string' && a.severity) ? a.severity.toLowerCase() : 'warn';
  const severity = SEVERITY_CANON[rawSeverity] || 'warning';
  const source = (typeof a.source === 'string' && a.source) ? a.source.slice(0, MAX_SHORT) : null;
  const detail = typeof a.body === 'string' ? a.body.slice(0, MAX_DETAIL)
    : (typeof a.detail === 'string' ? a.detail.slice(0, MAX_DETAIL) : null);
  const host = (typeof a.host === 'string' && a.host) ? a.host.slice(0, MAX_SHORT) : (source || 'external');
  const category = (typeof a.category === 'string' && a.category) ? a.category.slice(0, 60) : 'external';

  return { ok: true, value: { state, host, category, severity, title, detail, dedup_key, source } };
}

/**
 * Auth → validate → persist. Returns {status, body}.
 * @param {object} db open database
 * @param {object} opts { authHeader, token, bindHost, allowInsecureLoopback, body, createAlertFn?, resolveAlertByDedupKeyFn? }
 */
function handleAlertIngest(db, opts = {}) {
  const {
    authHeader = '', token = '', bindHost = '127.0.0.1',
    allowInsecureLoopback = false, body, createAlertFn = createAlert,
    resolveAlertByDedupKeyFn = resolveAlertByDedupKey,
  } = opts;

  const auth = checkFleetAuth(authHeader, token, bindHost, allowInsecureLoopback);
  if (!auth.ok) {
    return {
      status: auth.code || 401,
      body: { error: 'alert ingest requires HEIMDALL_ALERT_TOKEN (or HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK=1 for loopback-only dev)' },
    };
  }

  const v = validateAlertEnvelope(body);
  if (!v.ok) return { status: 400, body: { error: 'invalid alert', details: v.errors } };

  const a = v.value;
  try {
    if (a.state === 'resolved') {
      const resolved = resolveAlertByDedupKeyFn(db, a.dedup_key);
      return { status: 200, body: { ok: true, resolved, dedup_key: a.dedup_key } };
    }
    const id = createAlertFn(db, a.host, a.category, a.severity, a.title, a.detail, { dedup_key: a.dedup_key, source: a.source });
    return { status: 200, body: { ok: true, id, dedup_key: a.dedup_key } };
  } catch (err) {
    return { status: 500, body: { error: 'persist failed', detail: String((err && err.message) || err) } };
  }
}

module.exports = { handleAlertIngest, validateAlertEnvelope };
