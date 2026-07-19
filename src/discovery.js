'use strict';

/**
 * discovery.js — config-driven service discovery for the v2 contract.
 *
 * For each service in heimdall.config.json, the poller tries, in order:
 *   1. the self-describing descriptor  (<base>/heimdall.json)        → full render
 *   2. the /health endpoint (health+json or {status,version})        → minimal render
 *   3. config-only                     (timers/static/unreachable)   → graceful card
 * and writes the result to `service_snapshots`. Pages read the snapshot; there's
 * no live fetch on render in the common case. `fetchJson` is injectable for tests.
 */

const { validateDescriptor } = require('./contract/schema');
const { upsertServiceSnapshot, getLatestTimerRun } = require('./db');
const { knownPanelsFor: defaultKnownPanelsFor } = require('./plugins/known-panels');

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_FETCH_BYTES = 256 * 1024; // 256 KiB — descriptor fetch body cap (DoS guard)
// A timer is "stale" once its next scheduled fire is this far in the past with
// no newer run — systemd hasn't fired it (disabled/failed/host asleep). Kept
// generous so a job that merely runs a little late doesn't flap. Timers never
// count toward the fleet-broken rollup (overview.js), so an eager stale is cheap.
const TIMER_STALE_GRACE_MS = 60 * 60 * 1000; // 1h past NextElapse

function deriveBase(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}

function descriptorUrlFor(svc) {
  if (svc.descriptor_url) return svc.descriptor_url;
  const base = svc.health_url ? deriveBase(svc.health_url) : null;
  return base ? `${base}/heimdall.json` : null;
}

function kindFromType(type) {
  if (type === 'timer') return 'timer';
  if (type === 'static') return 'static';
  return 'http-service';
}

function repoUrl(repo) {
  return repo ? `https://github.com/${repo}` : null;
}

/**
 * Map a systemd-timer's last-run record to a contract status (#97).
 *   - null   → no real outcome yet (never ran; note systemd's ExecMainStatus
 *              defaults to 0, so we must gate "pass" on an actual lastRun)
 *   - 'fail' → last invocation exited non-zero
 *   - 'warn' → overdue: next scheduled fire is well past due, no newer run
 *   - 'pass' → last run succeeded and it's on schedule
 */
function deriveTimerState(run, now = Date.now()) {
  if (!run || !run.lastRun) return null;
  if (run.exitOk === false) return 'fail';
  if (run.nextRun) {
    const overdue = now - Date.parse(run.nextRun);
    if (Number.isFinite(overdue) && overdue > TIMER_STALE_GRACE_MS) return 'warn';
  }
  if (run.exitOk === true) return 'pass';
  return null; // ran, on schedule, but exit outcome unknown → not a false pass/warn
}

/** Map a /health status string (or HTTP outcome) to a contract status. */
function normalizeHealthStatus(json, httpOk) {
  const s = json && typeof json.status === 'string' ? json.status.toLowerCase() : null;
  if (['pass', 'ok', 'up', 'healthy'].includes(s)) return 'pass';
  if (['warn', 'degraded'].includes(s)) return 'warn';
  if (['fail', 'down', 'error'].includes(s)) return 'fail';
  return httpOk ? 'pass' : 'fail';
}

/**
 * Read a fetch Response body, bounding it to MAX_FETCH_BYTES *bytes* without
 * buffering the whole thing first. Returns the decoded text, or null if the
 * body exceeds the cap (so callers fall through to the next tier).
 *   - Honours Content-Length: rejects early when it declares an oversize body.
 *   - Otherwise streams chunks, summing byteLength, and cancels the stream the
 *     moment the accumulated bytes exceed the cap (no full buffering).
 *   - Decodes the byte-bounded buffer with TextDecoder (true bytes, not UTF-16
 *     code units).
 */
async function readBoundedText(res, maxBytes) {
  const lenHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  if (lenHeader != null) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) return null; // reject early
  }

  // No readable stream (e.g. a mock) — fall back to text() but still byte-bound.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes > maxBytes ? null : text;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return null; // over cap — stop without buffering the rest
        }
        chunks.push(value);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
}

/**
 * Default JSON fetch with an abort timeout (Node 18+ global fetch).
 * Rejects responses whose body exceeds MAX_FETCH_BYTES (DoS guard): returns
 * { ok: false } so callers fall through to the next discovery tier.
 */
async function defaultFetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    let json = null;
    try {
      const text = await readBoundedText(res, MAX_FETCH_BYTES);
      if (text == null) {
        // Body exceeds cap — treat as unusable, fall through to next tier.
        return { ok: false, status: res.status, json: null };
      }
      json = JSON.parse(text);
    } catch { /* non-JSON body or parse error */ }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Poll a single service config entry → a snapshot object (does not write). */
async function pollService(svc, deps = {}) {
  const { fetchJson = defaultFetchJson, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS, knownPanels = defaultKnownPanelsFor, timerState = null } = deps;
  const fetchedAt = new Date(now).toISOString();
  const name = svc.name;
  const descUrl = descriptorUrlFor(svc);

  // Tier 1 — full self-describing descriptor
  if (descUrl) {
    try {
      const r = await fetchJson(descUrl, timeoutMs);
      if (r && r.ok && r.json) {
        const v = validateDescriptor(r.json);
        if (v.ok) {
          return {
            service: name, kind: v.value.kind, status: v.value.status,
            descriptor: v.value, fetchedAt, reachable: true,
            schemaVersion: v.value.schema, source: 'descriptor',
            error: v.warnings.length ? v.warnings.join('; ') : null,
          };
        }
      }
    } catch { /* fall through */ }
  }

  // Tier 2 — /health
  if (svc.health_url) {
    try {
      const r = await fetchJson(svc.health_url, timeoutMs);
      if (r && r.ok) {
        const status = normalizeHealthStatus(r.json, r.ok);
        const version = r.json && (r.json.version || r.json.releaseId)
          ? String(r.json.version || r.json.releaseId) : null;
        const panels = knownPanels(name);
        const descriptor = {
          service: { name, label: name, criticality: 'normal' },
          kind: kindFromType(svc.type),
          status,
          version,
          deploy: version ? { deployed_commit: version, host: svc.host || null } : null,
          metrics: [], panels,
          links: { health: svc.health_url, repo: repoUrl(svc.repo) },
        };
        return {
          service: name, kind: descriptor.kind, status, descriptor,
          fetchedAt, reachable: true, schemaVersion: null, source: 'health', error: null,
        };
      }
    } catch { /* fall through */ }
  }

  // Tier 3 — config-only (timers/static, or genuinely unreachable)
  const kind = kindFromType(svc.type);
  const tier3Panels = knownPanels(name);

  // Timers have no endpoint, but systemd knows their last-run outcome (#97):
  // surface pass/fail/stale from the timer_* metrics drift.js collected, so a
  // failing nightly job stops looking identical to a healthy one.
  let timerStatus = null;
  let timerDetail = null;
  if (svc.type === 'timer' && typeof timerState === 'function') {
    const run = timerState(svc);
    if (run) {
      timerStatus = deriveTimerState(run, now);
      timerDetail = { lastRun: run.lastRun || null, nextRun: run.nextRun || null, lastResult: run.lastResult || null };
    }
  }

  const descriptor = {
    service: { name, label: name, criticality: 'normal' },
    kind, status: timerStatus, metrics: [], panels: tier3Panels,
    links: { repo: repoUrl(svc.repo) },
  };
  if (timerDetail) descriptor.timer = timerDetail;

  return {
    service: name, kind, status: timerStatus,
    descriptor,
    fetchedAt, reachable: false, schemaVersion: null, source: 'config',
    error: (svc.type === 'timer' || svc.type === 'static') ? null : 'unreachable',
  };
}

/** Poll all services sequentially and persist each snapshot. Returns the snapshots. */
async function pollAll(db, services, deps = {}) {
  // Default timer-state lookup reads the timer_* metrics from the db (#97);
  // tests inject their own. Bound here because pollService has no db handle.
  const timerState = deps.timerState
    || ((svc) => { try { return getLatestTimerRun(db, svc.name); } catch { return null; } });
  const mergedDeps = { ...deps, timerState };
  const results = [];
  for (const svc of services || []) {
    const snap = await pollService(svc, mergedDeps);
    try { upsertServiceSnapshot(db, snap); } catch { /* best-effort persist */ }
    results.push(snap);
  }
  return results;
}

module.exports = {
  pollService, pollAll, descriptorUrlFor, deriveBase, kindFromType, normalizeHealthStatus,
  defaultFetchJson, MAX_FETCH_BYTES, deriveTimerState,
};
