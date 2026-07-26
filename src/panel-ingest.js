'use strict';

/**
 * panel-ingest.js — generic typed-panel ingestion (#57).
 *
 * A producer POSTs ONE JSON blob to `POST /api/panels` and a number / trend /
 * table / status appears on its service page — zero Heimdall code per panel.
 * Framework-independent (returns {status, body}) so it is unit-testable,
 * mirroring alert-ingest.js / fleet/ingest.js. Auth reuses the fleet fail-closed
 * Bearer check + the fleet token (no new credential).
 *
 * Validation is LENIENT: bad OPTIONAL fields are dropped and reported in
 * `warnings` (returned in the 200 body). It HARD-rejects only on:
 *   - missing/invalid `service` or `panel` id (charset `^[a-z0-9][a-z0-9-]{0,63}$`)
 *   - unknown `kind`
 *   - missing required kind-data
 *
 * Guardrails (enforced): label ≤120 chars; timeseries.points capped to last 500;
 * table.rows ≤200, cols ≤20; a service may hold at most 50 distinct panels.
 */

const { checkFleetAuth } = require('./fleet/auth');
const {
  upsertPanel, countPanelsForService, countPanels, countPanelServices, isRetiredPushedPanel,
} = require('./db');
const {
  MAX_LABEL, MAX_UNIT, MAX_POINTS, MAX_ROWS, MAX_COLS, MAX_CELL,
  normPoints, normTable, normalizeTypedPanelData,
} = require('./contract/panel-data');

const KINDS = new Set(['stat', 'timeseries', 'table', 'status']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUS_STATES = new Set(['pass', 'warn', 'fail']);

// Alias for readability inside this file (table cell / message clamp).
const MAX_STR = MAX_CELL;

const MAX_PANELS_PER_SERVICE = 50;  // max distinct panels per service (per-service cap)
const MAX_TOTAL_PANELS = 1000;      // max total panel rows across all services (global cap)
const MAX_PANEL_SERVICES = 100;     // max distinct service ids with panels (global cap)

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function clampStr(s, max) { return String(s).slice(0, max); }

/**
 * Validate + normalize a raw panel blob.
 * @returns {{ok:boolean, errors?:string[], warnings:string[], value?:object}}
 *   value: { service, panel, kind, label, unit, data } ready for upsert.
 */
function validatePanel(obj) {
  const warnings = [];
  if (!isObj(obj)) return { ok: false, errors: ['body must be a JSON object'], warnings };

  const service = typeof obj.service === 'string' ? obj.service : '';
  const panel = typeof obj.panel === 'string' ? obj.panel : '';
  const errors = [];
  if (!ID_RE.test(service)) errors.push('service must match ^[a-z0-9][a-z0-9-]{0,63}$');
  if (!ID_RE.test(panel)) errors.push('panel must match ^[a-z0-9][a-z0-9-]{0,63}$');

  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  if (!KINDS.has(kind)) errors.push(`unknown kind "${kind}" (expected: ${[...KINDS].join(', ')})`);

  // Stop here if identity/kind are unusable — kind-data checks depend on kind.
  if (errors.length) return { ok: false, errors, warnings };

  let label = typeof obj.label === 'string' ? obj.label : panel;
  if (label.length > MAX_LABEL) { warnings.push(`label truncated to ${MAX_LABEL} chars`); label = label.slice(0, MAX_LABEL); }

  let unit = typeof obj.unit === 'string' ? clampStr(obj.unit, MAX_UNIT) : null;

  // Required-field hard-rejection (kind-specific).
  if (kind === 'stat') {
    if (!isNum(obj.value)) errors.push('stat requires a numeric `value`');
  } else if (kind === 'timeseries') {
    if (!Array.isArray(obj.points)) errors.push('timeseries requires a `points` array');
    else {
      // Preliminary emptiness check uses a THROWAWAY warnings array so we don't
      // duplicate warnings on success (normalizeTypedPanelData re-runs normPoints
      // below). On rejection we surface the throwaway warnings on the real array.
      const tmpWarnings = [];
      const pts = normPoints(obj.points, tmpWarnings);
      if (!pts.length) {
        for (const w of tmpWarnings) warnings.push(w);
        errors.push('timeseries `points` has no valid {t,y} entries');
      }
    }
  } else if (kind === 'table') {
    if (!Array.isArray(obj.rows)) errors.push('table requires a `rows` array');
  } else if (kind === 'status') {
    if (!STATUS_STATES.has(obj.state)) errors.push("status requires `state` ∈ {pass, warn, fail}");
  }

  if (errors.length) return { ok: false, errors, warnings };

  // Shared normalizer (caps + clamps, no further rejections).
  const data = normalizeTypedPanelData(kind, obj, warnings);

  return { ok: true, warnings, value: { service, panel, kind, label, unit, data } };
}

/**
 * Auth → validate → upsert. Returns {status, body}.
 * @param {object} db open database
 * @param {object} opts { authHeader, token, bindHost, allowInsecureLoopback, body,
 *                         upsertPanelFn?, countPanelsFn? }
 */
function handlePanelIngest(db, opts = {}) {
  const {
    authHeader = '', token = '', bindHost = '127.0.0.1',
    allowInsecureLoopback = false, body,
    upsertPanelFn = upsertPanel,
    countPanelsFn = countPanelsForService,
    countTotalFn = countPanels,
    countServicesFn = countPanelServices,
  } = opts;

  // TODO: per-agent tokens to prevent cross-service writes (separate auth redesign).
  const auth = checkFleetAuth(authHeader, token, bindHost, allowInsecureLoopback);
  if (!auth.ok) {
    return {
      status: auth.code || 401,
      body: { error: 'panel ingest requires HEIMDALL_FLEET_TOKEN (or HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK=1 for loopback-only dev)' },
    };
  }

  const v = validatePanel(body);
  if (!v.ok) return { status: 400, body: { error: 'invalid panel', details: v.errors, warnings: v.warnings } };

  const p = v.value;

  // Acknowledge the retired low-signal Brokkr card without writing it back into
  // the store. Existing production data remains intact for an easy rollback,
  // while continued producer pushes cannot make the card visible again.
  if (isRetiredPushedPanel(p.service, p.panel)) {
    return {
      status: 200,
      body: {
        ok: true, retired: true, service: p.service, panel: p.panel, kind: p.kind,
        warnings: [...v.warnings, 'panel is retired and was not stored'],
      },
    };
  }

  try {
    const existing = db.prepare('SELECT 1 FROM panels WHERE service = ? AND panel = ?').get(p.service, p.panel);
    const isNew = !existing;

    // All count-based caps only apply when inserting a NEW (service, panel) pair.
    // Updates to an existing row are always allowed (preserves availability).
    if (isNew) {
      // Per-service cap.
      const svcCount = countPanelsFn(db, p.service);
      if (svcCount >= MAX_PANELS_PER_SERVICE) {
        return { status: 429, body: { error: `service "${p.service}" already has ${MAX_PANELS_PER_SERVICE} panels (max per service)` } };
      }

      // Global total-panels cap.
      const totalCount = countTotalFn(db);
      if (totalCount >= MAX_TOTAL_PANELS) {
        return { status: 429, body: { error: `fleet panel store is full (${MAX_TOTAL_PANELS} panels max across all services)` } };
      }

      // Global distinct-services cap (only relevant when this is a brand-new service).
      // A service represented only by a retired row does not consume a visible
      // service slot, so adding its first visible panel must still enforce the
      // distinct-service cap.
      if (svcCount === 0) {
        const svcCountGlobal = countServicesFn(db);
        if (svcCountGlobal >= MAX_PANEL_SERVICES) {
          return { status: 429, body: { error: `fleet panel store has reached the service limit (${MAX_PANEL_SERVICES} distinct services max)` } };
        }
      }
    }

    upsertPanelFn(db, { ...p, updated_at: Date.now() });
    return { status: 200, body: { ok: true, service: p.service, panel: p.panel, kind: p.kind, warnings: v.warnings } };
  } catch (err) {
    return { status: 500, body: { error: 'persist failed', detail: String((err && err.message) || err) } };
  }
}

/** Short, discoverable schema doc (served at GET /api/panels/schema). */
const PANEL_SCHEMA_DOC = {
  description: 'Generic typed-panel ingest. POST one of these blobs to /api/panels with the configured fleet credential in the Authorization header using the Bearer scheme; it renders on /services/<service> with no Heimdall code change. A panel is keyed by (service, panel); the latest push wins.',
  readback: 'GET /api/panels lists all stored panels (summary, no data). GET /api/panels?service=<id> with the fleet Bearer token returns that service’s full panels incl. data; without auth it returns summary rows. Some producer ids are aliased onto an owning service page (e.g. m5-inference → m5-gateway).',
  envelope: '{ service, panel, kind, label, unit?, ...kindData, detail? }',
  ids: 'service/panel must match ^[a-z0-9][a-z0-9-]{0,63}$',
  kinds: {
    stat: '{ value:number, unit?, delta?:{ value:number, dir?:"up"|"down" } }',
    timeseries: '{ points:[{t:string,y:number}], unit?, summary?:{ latest?, window?, n?, ...extra } } — points capped to last 500; extra scalar summary fields (boolean/number/string) are preserved & rendered generically (≤20 fields, keys ≤64 chars, string values ≤200 chars)',
    table: '{ cols?:string[], rows:[object] }  (rows ≤200, cols ≤20; non-object rows are discarded and reported in response warnings)',
    status: '{ state:"pass"|"warn"|"fail", message? }',
  },
  detail: 'optional nested table-kind object ({ kind:"table", rows:[...] }) rendered beneath the panel',
  limits: {
    label: MAX_LABEL, points: MAX_POINTS, rows: MAX_ROWS, cols: MAX_COLS,
    panelsPerService: MAX_PANELS_PER_SERVICE,
    totalPanels: MAX_TOTAL_PANELS,
    distinctServices: MAX_PANEL_SERVICES,
  },
  example: {
    service: 'm5-inference', panel: 'offloadability', kind: 'timeseries',
    label: 'Offloadability — nightly gate fire-rate', unit: 'percent',
    points: [{ t: '2026-06-26', y: 3.5 }, { t: '2026-06-27', y: 1.7 }],
    summary: { latest: 1.7, window: '24h', n: 60 },
    detail: { kind: 'table', rows: [{ model: 'qwen3-30b-instruct', disagree: '0/52' }, { model: 'gpt-oss-120b', disagree: '0/5' }] },
  },
};

module.exports = {
  handlePanelIngest, validatePanel, PANEL_SCHEMA_DOC,
  MAX_PANELS_PER_SERVICE, MAX_TOTAL_PANELS, MAX_PANEL_SERVICES,
};
