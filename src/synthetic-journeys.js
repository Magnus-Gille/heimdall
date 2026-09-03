'use strict';

const { randomBytes } = require('node:crypto');
const { checkFleetAuth } = require('./fleet/auth');
const {
  insertSyntheticJourney, getSyntheticJourneyHistory,
  createAlert, resolveAlertByDedupKey,
} = require('./db');

const MUNIN_URL = 'http://127.0.0.1:3030/mcp';
const MIMIR_SENTINEL_PATH = '/list/__heimdall_content_free_probe__';
const FUTURE_SKEW_MS = 5000;
const MAX_LATENCY_MS = 10 * 60 * 1000;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const ERROR_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TOP_KEYS = new Set([
  'kind', 'schema_version', 'journey_id', 'producer', 'attempt_id', 'version',
  'started_at', 'observed_at', 'max_age_seconds', 'outcome', 'runner_outcome',
  'latency_ms', 'error_class', 'trace_id', 'steps', 'extensions',
]);
const STEP_KEYS = new Set(['id', 'outcome', 'latency_ms', 'error_class']);

const JOURNEY_SPECS = Object.freeze({
  'heimdall-munin-read': Object.freeze({
    label: 'Heimdall → Munin authenticated read', producer: 'heimdall',
    steps: Object.freeze(['connect', 'authenticate', 'read']), latencyTargetMs: 1500,
  }),
  'heimdall-mimir-metadata': Object.freeze({
    label: 'Heimdall → Mimir metadata/readability', producer: 'heimdall',
    steps: Object.freeze(['connect', 'authenticate', 'metadata-read']), latencyTargetMs: 1500,
  }),
  'hugin-gateway-preflight': Object.freeze({
    label: 'Hugin → gateway preflight', producer: 'hugin',
    steps: Object.freeze(['preflight', 'gateway-admission']), latencyTargetMs: 5000,
  }),
  'gateway-model-readiness': Object.freeze({
    label: 'Gateway → model readiness', producer: 'gille-inference',
    steps: Object.freeze(['gateway-readiness', 'model-readiness']), latencyTargetMs: 5000,
  }),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isUtc(value) {
  if (typeof value !== 'string' || !UTC_RE.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = new Date(parsed).toISOString();
  return value.includes('.') ? normalized === value : normalized.replace('.000Z', 'Z') === value;
}

function closedObject(value, allowed, path, errors) {
  if (!isObject(value)) { errors.push(`${path}:object`); return false; }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}:unknown-field`);
  return true;
}

function validNullableLatency(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_LATENCY_MS);
}

function validateJourneyOutcome(value) {
  const errors = [];
  if (!closedObject(value, TOP_KEYS, 'journey', errors)) return { ok: false, errors };
  const spec = JOURNEY_SPECS[value.journey_id];
  if (value.kind !== 'synthetic-journey-outcome') errors.push('journey:kind');
  if (value.schema_version !== 'v1') errors.push('journey:version');
  if (!spec) errors.push('journey:id');
  if (!spec || value.producer !== spec.producer) errors.push('journey:producer');
  if (typeof value.attempt_id !== 'string' || !SAFE_TEXT_RE.test(value.attempt_id)) errors.push('journey:attempt');
  if (typeof value.version !== 'string' || !SAFE_TEXT_RE.test(value.version)) errors.push('journey:producer-version');
  if (!isUtc(value.started_at) || !isUtc(value.observed_at)
      || (isUtc(value.started_at) && isUtc(value.observed_at)
        && Date.parse(value.started_at) > Date.parse(value.observed_at))) errors.push('journey:timestamps');
  if (!Number.isSafeInteger(value.max_age_seconds) || value.max_age_seconds < 1 || value.max_age_seconds > 86400) errors.push('journey:max-age');
  if (!['pass', 'fail', 'partial', 'unknown'].includes(value.outcome)) errors.push('journey:outcome');
  if (!['ok', 'failed'].includes(value.runner_outcome)) errors.push('journey:runner-outcome');
  if (!validNullableLatency(value.latency_ms)) errors.push('journey:latency');
  if (value.error_class !== null && (typeof value.error_class !== 'string' || !ERROR_RE.test(value.error_class))) errors.push('journey:error-class');
  if (value.trace_id !== null && (typeof value.trace_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.trace_id))) errors.push('journey:trace-id');
  if (!Array.isArray(value.extensions) || value.extensions.length !== 0) errors.push('journey:extensions');

  const seen = new Set();
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) errors.push('journey:steps');
  else value.steps.forEach((step, index) => {
    const path = `step-${index}`;
    if (!closedObject(step, STEP_KEYS, path, errors)) return;
    if (!spec || !spec.steps.includes(step.id) || seen.has(step.id)) errors.push(`${path}:id`);
    seen.add(step.id);
    if (!['pass', 'fail', 'skipped'].includes(step.outcome)) errors.push(`${path}:outcome`);
    if (!validNullableLatency(step.latency_ms)) errors.push(`${path}:latency`);
    if (step.error_class !== null && (typeof step.error_class !== 'string' || !ERROR_RE.test(step.error_class))) errors.push(`${path}:error-class`);
    if (step.outcome === 'pass' && (step.error_class !== null || step.latency_ms === null)) errors.push(`${path}:pass-shape`);
  });

  if (spec && Array.isArray(value.steps)) {
    const complete = spec.steps.every((id) => seen.has(id)) && seen.size === spec.steps.length;
    const allPass = complete && value.steps.every((step) => step.outcome === 'pass');
    const anyFail = value.steps.some((step) => step.outcome === 'fail');
    if (value.outcome === 'pass' && (value.runner_outcome !== 'ok' || !allPass || value.error_class !== null)) errors.push('journey:pass-consistency');
    if (value.outcome === 'fail' && (value.runner_outcome !== 'ok' || !complete || !anyFail || value.error_class === null)) errors.push('journey:fail-consistency');
    if (value.outcome === 'partial' && (value.runner_outcome !== 'ok' || complete)) errors.push('journey:partial-consistency');
    if (value.runner_outcome === 'failed' && (value.outcome !== 'unknown' || value.error_class === null)) errors.push('journey:runner-consistency');
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 50) };
}

function projectJourneyOutcome(value, options = {}) {
  const checked = validateJourneyOutcome(value);
  if (!checked.ok) return { state: 'unknown', freshness: value == null ? 'missing' : 'invalid', failureDomain: null, validationErrors: checked.errors };
  const now = options.now == null ? Date.now() : Number(options.now);
  if (!Number.isFinite(now)) return { state: 'unknown', freshness: 'invalid-clock', failureDomain: 'runner', validationErrors: ['projection:clock'] };
  const age = now - Date.parse(value.observed_at);
  const freshness = age < -FUTURE_SKEW_MS ? 'future' : (age >= value.max_age_seconds * 1000 ? 'stale' : 'fresh');
  const state = freshness === 'fresh' ? value.outcome : 'stale';
  const failureDomain = value.runner_outcome === 'failed' ? 'runner'
    : (value.outcome === 'fail' || value.outcome === 'partial' ? 'dependency' : null);
  return { ...value, state, freshness, failureDomain, validationErrors: [] };
}

function percentileNearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function computeJourneyObjectives(rows, options = {}) {
  const minSamples = Number.isSafeInteger(options.minSamples) ? Math.max(1, options.minSamples) : 12;
  const successTarget = Number.isFinite(options.successTarget) ? options.successTarget : 0.99;
  const latencyTargetMs = Number.isFinite(options.latencyTargetMs) ? options.latencyTargetMs : 2000;
  const now = options.now == null ? Date.now() : Number(options.now);
  const windowMs = Number.isFinite(options.windowMs) ? Math.max(1000, options.windowMs) : 24 * 60 * 60 * 1000;
  const observations = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!validateJourneyOutcome(row).ok || !Number.isFinite(now)) return false;
    const observed = Date.parse(row.observed_at);
    return observed <= now + FUTURE_SKEW_MS && observed >= now - windowMs;
  });
  // Runner failures are reported separately and cannot grade the dependency's
  // success/latency objectives. Excluding them also keeps an unconfigured probe
  // unknown instead of manufacturing a dependency breach.
  const samples = observations.filter((row) => row.runner_outcome === 'ok');
  const sampleCount = samples.length;
  const passing = samples.filter((row) => row.outcome === 'pass').length;
  const successRate = sampleCount ? passing / sampleCount : null;
  const latencies = samples.map((row) => row.latency_ms).filter(Number.isFinite);
  const p95LatencyMs = percentileNearestRank(latencies, 0.95);
  if (sampleCount < minSamples || latencies.length < minSamples) {
    return { state: 'unknown', sampleCount, observationCount: observations.length, minSamples, windowMs, successRate, p95LatencyMs, successTarget, latencyTargetMs };
  }
  const successPass = successRate >= successTarget;
  const latencyPass = p95LatencyMs <= latencyTargetMs;
  return { state: successPass && latencyPass ? 'pass' : 'fail', sampleCount, observationCount: observations.length, minSamples, windowMs, successRate, p95LatencyMs, successTarget, latencyTargetMs, successPass, latencyPass };
}

function nowIso(now) { return new Date(now()).toISOString(); }
function newIdentity(prefix) { return `${prefix}-${randomBytes(12).toString('hex')}`; }
function traceId() { return randomBytes(16).toString('hex'); }
function step(id, outcome, latencyMs, errorClass = null) {
  return { id, outcome, latency_ms: latencyMs, error_class: errorClass };
}

function baseOutcome(journeyId, now, version) {
  const timestamp = nowIso(now);
  return {
    kind: 'synthetic-journey-outcome', schema_version: 'v1', journey_id: journeyId,
    producer: 'heimdall', attempt_id: newIdentity('attempt'), version,
    started_at: timestamp, observed_at: timestamp, max_age_seconds: 900,
    outcome: 'unknown', runner_outcome: 'ok', latency_ms: 0,
    error_class: null, trace_id: traceId(), steps: [], extensions: [],
  };
}

function finish(base, now, startMs, values) {
  const endMs = now();
  return { ...base, observed_at: new Date(endMs).toISOString(), latency_ms: Math.max(0, Math.round(endMs - startMs)), ...values };
}

async function requestWithTimeout(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetchFn(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function readBoundedText(response, maxBytes = 64 * 1024) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          const error = new Error('response exceeds content-free probe limit');
          error.name = 'ResponseTooLarge';
          throw error;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(merged);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const error = new Error('response exceeds content-free probe limit');
    error.name = 'ResponseTooLarge';
    throw error;
  }
  return text;
}

async function discardResponseBody(response) {
  if (response.body && typeof response.body.cancel === 'function') {
    try { await response.body.cancel(); } catch { /* the outcome uses status only */ }
  }
}

function skippedSteps(ids, errorClass) {
  return ids.map((id) => step(id, 'skipped', null, errorClass));
}

async function runMuninReadJourney(options = {}) {
  const now = options.now || Date.now;
  const version = options.version || 'heimdall@1.0.0';
  const base = baseOutcome('heimdall-munin-read', now, version);
  const startMs = now();
  if (!options.apiKey) return finish(base, now, startMs, {
    outcome: 'unknown', runner_outcome: 'failed', error_class: 'runner-config',
    steps: skippedSteps(JOURNEY_SPECS[base.journey_id].steps, 'runner-unavailable'),
  });
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'memory_read', arguments: { namespace: 'probes/heimdall', key: 'content-free-read' } },
  });
  try {
    const res = await requestWithTimeout(options.fetchFn || fetch, MUNIN_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body,
    }, options.timeoutMs || 5000);
    const connect = step('connect', 'pass', 0);
    if (res.status === 401 || res.status === 403) {
      await discardResponseBody(res);
      return finish(base, now, startMs, {
        outcome: 'fail', error_class: 'auth-denied', steps: [connect, step('authenticate', 'fail', 0, 'auth-denied'), step('read', 'skipped', null, 'blocked-by-auth')],
      });
    }
    if (!res.ok) {
      await discardResponseBody(res);
      return finish(base, now, startMs, {
        outcome: 'fail', error_class: 'dependency-http', steps: [connect, step('authenticate', 'pass', 0), step('read', 'fail', 0, 'dependency-http')],
      });
    }
    const raw = await readBoundedText(res);
    const dataLine = raw.split('\n').filter((line) => line.startsWith('data: ')).at(-1);
    const rpc = JSON.parse(dataLine ? dataLine.slice(6) : raw);
    const textBlock = rpc && rpc.result && Array.isArray(rpc.result.content)
      ? rpc.result.content.find((item) => item && item.type === 'text') : null;
    const readback = textBlock && typeof textBlock.text === 'string' ? JSON.parse(textBlock.text) : null;
    if (rpc.error || rpc.result?.isError || !readback || readback.ok !== true || readback.found !== false) return finish(base, now, startMs, {
      outcome: 'fail', error_class: readback?.found === true ? 'probe-sentinel-present' : 'invalid-response',
      steps: [connect, step('authenticate', 'pass', 0), step('read', 'fail', 0, readback?.found === true ? 'probe-sentinel-present' : 'invalid-response')],
    });
    return finish(base, now, startMs, {
      outcome: 'pass', error_class: null,
      steps: [connect, step('authenticate', 'pass', 0), step('read', 'pass', 0)],
    });
  } catch (error) {
    const timeout = error && ['AbortError', 'TimeoutError'].includes(error.name);
    const errorClass = timeout ? 'timeout' : (error?.name === 'ResponseTooLarge' ? 'invalid-response' : 'dependency-network');
    return finish(base, now, startMs, {
      outcome: 'fail', error_class: errorClass,
      steps: [step('connect', 'fail', 0, errorClass), step('authenticate', 'skipped', null, 'blocked-by-connect'), step('read', 'skipped', null, 'blocked-by-connect')],
    });
  }
}

async function runMimirMetadataJourney(options = {}) {
  const now = options.now || Date.now;
  const version = options.version || 'heimdall@1.0.0';
  const base = baseOutcome('heimdall-mimir-metadata', now, version);
  const startMs = now();
  let url;
  try {
    const parsed = new URL(options.baseUrl || '');
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    url = new URL(MIMIR_SENTINEL_PATH, parsed.origin).toString();
  } catch {
    return finish(base, now, startMs, {
      outcome: 'unknown', runner_outcome: 'failed', error_class: 'runner-config',
      steps: skippedSteps(JOURNEY_SPECS[base.journey_id].steps, 'runner-unavailable'),
    });
  }
  if (!options.apiKey) return finish(base, now, startMs, {
    outcome: 'unknown', runner_outcome: 'failed', error_class: 'runner-config',
    steps: skippedSteps(JOURNEY_SPECS[base.journey_id].steps, 'runner-unavailable'),
  });
  try {
    const res = await requestWithTimeout(options.fetchFn || fetch, url, {
      method: 'GET', headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
    }, options.timeoutMs || 5000);
    const connect = step('connect', 'pass', 0);
    if (res.status === 401 || res.status === 403) {
      await discardResponseBody(res);
      return finish(base, now, startMs, {
        outcome: 'fail', error_class: 'auth-denied', steps: [connect, step('authenticate', 'fail', 0, 'auth-denied'), step('metadata-read', 'skipped', null, 'blocked-by-auth')],
      });
    }
    if (res.status === 404) {
      const raw = await readBoundedText(res, 2048);
      let missing;
      try { missing = JSON.parse(raw); } catch { missing = null; }
      if (missing?.error === 'Directory not found: /__heimdall_content_free_probe__') {
        return finish(base, now, startMs, {
          outcome: 'pass', error_class: null, steps: [connect, step('authenticate', 'pass', 0), step('metadata-read', 'pass', 0)],
        });
      }
      return finish(base, now, startMs, {
        outcome: 'fail', error_class: 'invalid-response', steps: [connect, step('authenticate', 'pass', 0), step('metadata-read', 'fail', 0, 'invalid-response')],
      });
    }
    await discardResponseBody(res);
    return finish(base, now, startMs, {
      outcome: 'fail', error_class: 'dependency-http', steps: [connect, step('authenticate', 'pass', 0), step('metadata-read', 'fail', 0, 'dependency-http')],
    });
  } catch (error) {
    const timeout = error && ['AbortError', 'TimeoutError'].includes(error.name);
    const errorClass = timeout ? 'timeout' : (error?.name === 'ResponseTooLarge' ? 'invalid-response' : 'dependency-network');
    return finish(base, now, startMs, {
      outcome: 'fail', error_class: errorClass,
      steps: [step('connect', 'fail', 0, errorClass), step('authenticate', 'skipped', null, 'blocked-by-connect'), step('metadata-read', 'skipped', null, 'blocked-by-connect')],
    });
  }
}

function evaluateJourneyAlerts(db, journeyId, options = {}) {
  const spec = JOURNEY_SPECS[journeyId];
  if (!spec) return { state: 'unknown' };
  const rows = getSyntheticJourneyHistory(db, journeyId, options.historyLimit || 288);
  const latest = rows[0] ? projectJourneyOutcome(rows[0], { now: options.now }) : null;
  const failureKey = `journey:${journeyId}:complete-failure`;
  if (latest && latest.freshness === 'fresh' && latest.outcome === 'fail') {
    createAlert(db, 'control-node', 'journey', 'critical', `${spec.label} failed`, latest.error_class || 'dependency-failure', { dedup_key: failureKey, source: 'synthetic-journey' });
  } else if (latest && latest.freshness === 'fresh' && latest.outcome === 'pass') {
    resolveAlertByDedupKey(db, failureKey);
  }

  const objective = computeJourneyObjectives(rows, {
    minSamples: options.minSamples,
    successTarget: options.successTarget,
    latencyTargetMs: options.latencyTargetMs || spec.latencyTargetMs,
    windowMs: options.windowMs,
    now: options.now,
  });
  const objectiveKey = `journey:${journeyId}:objective`;
  if (objective.state === 'fail') {
    createAlert(db, 'control-node', 'journey', 'warning', `${spec.label} objective breached`, `success=${objective.successRate}; p95_ms=${objective.p95LatencyMs}; samples=${objective.sampleCount}`, { dedup_key: objectiveKey, source: 'synthetic-journey' });
  } else if (objective.state === 'pass') resolveAlertByDedupKey(db, objectiveKey);
  return { latest, objective };
}

function ingestSyntheticJourney(db, options = {}) {
  if (options.body?.producer === 'heimdall') return { status: 403, body: { error: 'direct Heimdall journeys are not accepted over producer ingest' } };
  const producer = options.body?.producer;
  const token = options.tokens && typeof options.tokens === 'object' && Object.hasOwn(options.tokens, producer)
    ? options.tokens[producer] : '';
  const auth = checkFleetAuth(options.authHeader || '', token || '', options.bindHost || '127.0.0.1', false);
  if (!auth.ok) return { status: auth.code || 401, body: { error: 'synthetic journey ingest is not configured' } };
  const checked = validateJourneyOutcome(options.body);
  if (!checked.ok) return { status: 400, body: { error: 'invalid synthetic journey outcome', reasons: checked.errors.slice(0, 20) } };
  try {
    const stored = insertSyntheticJourney(db, options.body);
    if (!stored.ok) return { status: 409, body: { error: 'synthetic journey replay rejected', reason: stored.code } };
    return { status: 200, body: { ok: true, replay: stored.replay, journey_id: options.body.journey_id, attempt_id: options.body.attempt_id } };
  } catch (error) {
    options.logger?.error?.({ err: error }, 'synthetic journey persistence failed');
    return { status: 500, body: { error: 'persist failed' } };
  }
}

module.exports = {
  JOURNEY_SPECS, MUNIN_URL, MIMIR_SENTINEL_PATH,
  validateJourneyOutcome, projectJourneyOutcome, computeJourneyObjectives,
  runMuninReadJourney, runMimirMetadataJourney, evaluateJourneyAlerts,
  ingestSyntheticJourney,
};
