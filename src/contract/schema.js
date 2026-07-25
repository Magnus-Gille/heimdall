'use strict';

/**
 * schema.js — the v2 self-describing SERVICE CONTRACT (validator + normalizer).
 *
 * Every Grimnir service SHOULD serve `GET /heimdall.json` returning this shape.
 * Heimdall validates + normalizes it once at discovery time and renders it
 * generically — zero per-service code in the common case. The validator is
 * deliberately LENIENT (forward-compatible: unknown fields are ignored, unknown
 * enums degrade with a warning) and only hard-fails when the object is unusable
 * (not an object, or missing service.name).
 *
 * Aligned with IETF health+json (status/checks/version→releaseId/output/links)
 * and OpenTelemetry resource attrs (service.name/namespace/instance_id).
 */

const { MAX_LABEL, MAX_UNIT, MAX_CELL, normalizeTypedPanelData } = require('./panel-data');

// The stable identifier Heimdall STAMPS on descriptors it produces. It is an
// identifier, not a fetched URL — the validator only requires an incoming
// `_schema` to contain "/service/v1", so third-party producers using the old
// documentation-placeholder id keep validating unchanged.
const SCHEMA_ID = 'https://github.com/Magnus-Gille/heimdall/schema/service/v1';
const ARCHETYPES = ['inference', 'http-service', 'timer', 'static', 'mcp'];
const CRITICALITIES = ['high', 'normal', 'low'];
const STATUSES = ['pass', 'warn', 'fail'];

/** Map a health+json status to a render state (color+shape+text key). */
function statusToState(status) {
  if (status === 'pass') return 'ok';
  if (status === 'warn') return 'warn';
  if (status === 'fail') return 'crit';
  return 'stale';
}

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Preserve a descriptor-supplied ISO-8601 timestamp only when it is a bounded,
 * parseable date string. Descriptors are a network trust boundary (#108): an
 * arbitrary string like "not-a-date" would otherwise be stored and rendered as
 * a bogus metric age. Anything unparseable, mis-shaped, or over-long → null.
 */
function normalizeIsoStamp(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

function normalizeDeploy(d) {
  if (!isObj(d)) return null;
  return {
    deployed_commit: typeof d.deployed_commit === 'string' ? d.deployed_commit : null,
    latest_commit: typeof d.latest_commit === 'string' ? d.latest_commit : null,
    drift: isNum(d.drift) ? d.drift : null,
    deployed_at: typeof d.deployed_at === 'string' ? d.deployed_at : null,
    host: typeof d.host === 'string' ? d.host : null,
    systemd_unit: typeof d.systemd_unit === 'string' ? d.systemd_unit : null,
    platform: typeof d.platform === 'string' ? d.platform : null,
  };
}

function normalizeMetrics(arr, warnings) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) { warnings.push('metrics must be an array — ignored'); return []; }
  return arr
    .filter((m) => isObj(m) && typeof m.key === 'string')
    .map((m) => ({
      key: m.key,
      label: typeof m.label === 'string' ? m.label : m.key,
      unit: typeof m.unit === 'string' ? m.unit : '',
      kind: typeof m.kind === 'string' ? m.kind : 'gauge',
      chart: m.chart === true,
      // Optional LIVE reading (#108): descriptors that publish real metric values
      // (e.g. ratatoskr's triage latency / token averages) carry a scalar `value`
      // and an optional `updated_at` ISO stamp. Preserve them so the dashboard can
      // render the current reading, not just the metric's definition. A string
      // value is clamped (descriptors are a trust boundary); non-scalars → null.
      value: isNum(m.value) ? m.value
        : (typeof m.value === 'string' ? m.value.slice(0, MAX_CELL) : null),
      updated_at: normalizeIsoStamp(m.updated_at),
      warn: isObj(m.warn) ? m.warn : null,
      crit: isObj(m.crit) ? m.crit : null,
    }));
}

function normalizeAlerts(a) {
  if (!isObj(a)) return { rules: [], active_count: 0, firing: [] };
  return {
    rules: Array.isArray(a.rules) ? a.rules.filter(isObj) : [],
    active_count: isNum(a.active_count) ? a.active_count : 0,
    firing: Array.isArray(a.firing) ? a.firing : [],
  };
}

/**
 * URL safety allowlist for descriptor-supplied links. Descriptors arrive over
 * the network from self-describing services (a trust boundary), so a link could
 * carry a `javascript:`/`data:` scheme that esc() does NOT neutralize. Permit
 * only absolute http(s) URLs and same-origin root-relative paths.
 */
function isSafeHref(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('//')) return false;        // protocol-relative — reject
  if (url.startsWith('/')) return true;          // same-origin root-relative
  return /^https?:\/\//i.test(url);              // absolute http(s) only
}

function normalizeLinks(links) {
  if (!isObj(links)) return {};
  const out = {};
  for (const [k, v] of Object.entries(links)) {
    if (isSafeHref(v)) out[k] = v;
  }
  return out;
}

const TYPED_PANEL_KINDS = new Set(['stat', 'timeseries', 'table', 'status']);

/**
 * Normalize the `panels` array from a descriptor.
 * @param {*}        arr      raw panels value from the descriptor
 * @param {string[]} warnings mutable array — cap/drop warnings are appended
 */
function normalizePanels(arr, warnings = []) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => isObj(p) && typeof p.id === 'string')
    .map((p) => {
      // Cap the label (and the p.id-as-label fallback) like the push path does.
      let label = typeof p.label === 'string' ? p.label : p.id;
      if (label.length > MAX_LABEL) {
        warnings.push(`panel "${p.id}": label truncated to ${MAX_LABEL} chars`);
        label = label.slice(0, MAX_LABEL);
      }
      const out = {
        id: p.id,
        label,
        plugin: typeof p.plugin === 'string' ? p.plugin : null,
        // `view` is the plugin-internal panel type (e.g. "capability-map"), letting a
        // plugin serve many instances without instance-specific ids. Optional.
        view: typeof p.view === 'string' ? p.view : null,
        source: typeof p.source === 'string' ? p.source : null,
        refresh: isNum(p.refresh) ? p.refresh : null,
        fullWidth: p.fullWidth === true,
      };
      // Pull symmetry (#57): a descriptor panel can carry an inline typed kind +
      // its kind-data, rendered natively by render/panels.js (same as the push
      // path). Apply the same caps as the push path so oversized inline data is
      // bounded before discovery stores the snapshot.
      if (typeof p.kind === 'string' && TYPED_PANEL_KINDS.has(p.kind)) {
        out.kind = p.kind;
        if (typeof p.unit === 'string') out.unit = p.unit.slice(0, MAX_UNIT);
        const panelWarnings = [];
        const normalized = normalizeTypedPanelData(p.kind, p, panelWarnings);
        Object.assign(out, normalized);
        for (const w of panelWarnings) warnings.push(`panel "${p.id}": ${w}`);
      }
      return out;
    });
}

/**
 * Validate + normalize a raw descriptor object.
 * @returns {{ok: boolean, errors: string[], warnings: string[], value: object|null}}
 */
function validateDescriptor(obj) {
  const errors = [];
  const warnings = [];

  if (!isObj(obj)) {
    return { ok: false, errors: ['descriptor must be a JSON object'], warnings, value: null };
  }

  const schema = obj._schema;
  if (schema != null) {
    if (typeof schema !== 'string') warnings.push('_schema must be a string');
    else if (!schema.includes('/service/v1')) warnings.push(`unrecognized _schema "${schema}" — rendering best-effort`);
  }

  const svc = obj.service;
  if (!isObj(svc) || typeof svc.name !== 'string' || !svc.name) {
    errors.push('service.name is required');
  }

  let kind = obj.kind;
  if (!ARCHETYPES.includes(kind)) {
    if (kind != null) warnings.push(`unknown kind "${kind}" — defaulting to http-service`);
    kind = 'http-service';
  }

  let status = obj.status;
  if (!STATUSES.includes(status)) {
    if (status != null) warnings.push(`unknown status "${status}"`);
    status = null;
  }

  if (errors.length) return { ok: false, errors, warnings, value: null };

  const value = {
    schema: typeof schema === 'string' ? schema : null,
    service: {
      name: svc.name,
      label: typeof svc.label === 'string' ? svc.label : svc.name,
      namespace: typeof svc.namespace === 'string' ? svc.namespace : null,
      instance_id: typeof svc.instance_id === 'string' ? svc.instance_id : null,
      criticality: CRITICALITIES.includes(svc.criticality) ? svc.criticality : 'normal',
    },
    kind,
    status,
    output: typeof obj.output === 'string' ? obj.output : null,
    checks: isObj(obj.checks) ? obj.checks : null,
    version: (typeof obj.version === 'string' || isNum(obj.version)) ? String(obj.version) : null,
    deploy: normalizeDeploy(obj.deploy),
    metrics: normalizeMetrics(obj.metrics, warnings),
    alerts: normalizeAlerts(obj.alerts),
    panels: normalizePanels(obj.panels, warnings),
    links: normalizeLinks(obj.links),
    ui: isObj(obj.ui) ? obj.ui : {},
  };

  return { ok: true, errors, warnings, value };
}

module.exports = {
  SCHEMA_ID,
  ARCHETYPES,
  CRITICALITIES,
  STATUSES,
  statusToState,
  validateDescriptor,
  isSafeHref,
  normalizeLinks,
};
