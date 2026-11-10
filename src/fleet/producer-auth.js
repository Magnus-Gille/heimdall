'use strict';

const { timingSafeEqual } = require('node:crypto');
const { canonicalHost } = require('../host-identity');
const { HOSTNAME_RE } = require('./validate');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRODUCER_KEYS = new Set(['id', 'token', 'hosts', 'services']);

/**
 * Parse and validate the complete host-owned producer registry. Any invalid
 * record rejects the whole registry so a typo cannot silently reduce a scope.
 * Returned producer objects never include credential values.
 */
function loadProducerRegistry(raw, legacyFleetToken = '') {
  const registry = parseProducerRegistry(raw, legacyFleetToken);
  if (!registry.ok) return registry;
  return { ok: true, producers: registry.producers.map(({ id, hosts, services }) => ({ id, hosts, services })) };
}

function parseProducerRegistry(raw, legacyFleetToken = '') {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false };

  const ids = new Set();
  const tokens = new Set();
  const producers = [];

  for (const record of parsed) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false };
    if (Object.keys(record).some((key) => !PRODUCER_KEYS.has(key))) return { ok: false };
    if (typeof record.id !== 'string' || !ID_RE.test(record.id) || ids.has(record.id)) return { ok: false };
    if (typeof record.token !== 'string' || !record.token.trim() || /[\r\n]/.test(record.token)
      || tokens.has(record.token) || constantTimeEqual(record.token, legacyFleetToken)) return { ok: false };

    const hosts = validateScopeList(record, 'hosts', HOSTNAME_RE);
    const services = validateScopeList(record, 'services', SERVICE_RE);
    if (!hosts || !services || (!hosts.length && !services.length)) return { ok: false };

    ids.add(record.id);
    tokens.add(record.token);
    producers.push({ id: record.id, token: record.token, hosts, services });
  }

  return { ok: true, producers };
}

function validateScopeList(record, key, pattern) {
  if (!Object.hasOwn(record, key)) return [];
  const values = record[key];
  if (!Array.isArray(values) || values.length === 0) return null;
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !pattern.test(value) || seen.has(value)) return null;
    seen.add(value);
  }
  return [...seen];
}

/** Authenticate to one configured producer identity without loopback bypass. */
function authenticateProducer(authHeader, rawRegistry, legacyFleetToken = '') {
  const registry = parseProducerRegistry(rawRegistry, legacyFleetToken);
  if (!registry.ok) return { ok: false, status: 503, error: 'producer ingest is not configured' };

  const provided = bearerValue(authHeader);
  let matched = null;
  for (const producer of registry.producers) {
    if (constantTimeEqual(provided, producer.token)) matched = producer;
  }
  if (!matched) return { ok: false, status: 401, error: 'Unauthorized' };
  return {
    ok: true,
    producer: { id: matched.id, hosts: matched.hosts, services: matched.services },
  };
}

function authorizeProducerHost(producer, hostname, aliases = {}) {
  const target = canonicalHost(hostname, aliases);
  const allowed = producer && Array.isArray(producer.hosts) && producer.hosts.some(
    (hostnameScope) => canonicalHost(hostnameScope, aliases) === target,
  );
  return allowed ? { ok: true } : { ok: false, status: 403, error: 'producer is not authorized for this host' };
}

function authorizeProducerService(producer, service) {
  const allowed = producer && Array.isArray(producer.services) && producer.services.includes(service);
  return allowed ? { ok: true } : { ok: false, status: 403, error: 'producer is not authorized for this service' };
}

function isOperatorReadToken(authHeader, legacyFleetToken) {
  return typeof legacyFleetToken === 'string' && legacyFleetToken.length > 0
    && constantTimeEqual(bearerValue(authHeader), legacyFleetToken);
}

function bearerValue(authHeader) {
  return typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : '';
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// --- Rejection logging (HEIM-103) -------------------------------------------
// Log lines are built ONLY from fixed enums, the registry-assigned producer id
// and the (pattern-checked) claimed host/service. The token, the Authorization
// header and any parse error text are never passed in, so they cannot leak.
// Claimed host/service values are client-controlled, so they are additionally
// redacted when they equal or contain any configured credential.

const REJECTION_WINDOW_MS = 60_000;
const REJECTION_MAX_KEYS = 256;
const REDACTED = '[redacted]';
const REASONS = {
  503: 'registry-unavailable',
  401: 'unknown-token',
};

/**
 * Build a predicate-based redactor from the raw registry JSON and the legacy
 * fleet token. Tokens are collected leniently (even from an otherwise invalid
 * registry) and are only ever compared against, never emitted.
 */
function createSecretRedactor(rawRegistry, legacyFleetToken = '') {
  const secrets = [];
  if (typeof legacyFleetToken === 'string' && legacyFleetToken) secrets.push(legacyFleetToken);
  try {
    const parsed = JSON.parse(rawRegistry);
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (r && typeof r === 'object' && typeof r.token === 'string' && r.token) secrets.push(r.token);
      }
    }
  } catch { /* unparseable registry: only the legacy token is known */ }
  const lowered = secrets.map((s) => s.toLowerCase());
  return function redact(value) {
    if (typeof value !== 'string' || !value) return value;
    const v = value.toLowerCase();
    return secrets.some((s, i) => value.includes(s) || v.includes(lowered[i])) ? REDACTED : value;
  };
}

function safeLabel(value, pattern) {
  if (value === REDACTED) return REDACTED;
  return typeof value === 'string' && value.length <= 253 && pattern.test(value) ? value : '-';
}

/**
 * Create a rate-limited rejection logger. The first rejection per
 * (status, reason, producer, target, endpoint) in a window is logged
 * immediately; later ones are only counted and reported as
 * `suppressed_since_last` by the next rejection of the same key, or when the
 * expired bucket is evicted. The key table is bounded; keys that do not fit go
 * to an explicit aggregate `ingest_rejected_overflow` line with a count.
 */
function createRejectionLogger({ log = (line) => console.warn(line), now = Date.now, windowMs = REJECTION_WINDOW_MS, maxKeys = REJECTION_MAX_KEYS } = {}) {
  const buckets = new Map();
  let overflow = null; // { start, count }
  const emit = (obj) => log(JSON.stringify(obj));
  const summary = (entry, suppressed) => (suppressed
    ? { ...entry, suppressed_since_last: suppressed, window_s: windowMs / 1000 } : entry);

  function evictExpired(t) {
    for (const [k, b] of buckets) {
      if (t - b.start < windowMs) continue;
      buckets.delete(k);
      if (b.suppressed) emit(summary(b.entry, b.suppressed));
    }
  }

  function flushOverflow(t) {
    if (!overflow || t - overflow.start < windowMs) return;
    if (overflow.count > 1) emit({ event: 'ingest_rejected_overflow', count: overflow.count, window_s: windowMs / 1000 });
    overflow = null;
  }

  function overflowHit(t) {
    if (overflow) { overflow.count += 1; return; }
    overflow = { start: t, count: 1 };
    emit({ event: 'ingest_rejected_overflow', count: 1, window_s: windowMs / 1000, note: 'rejection key table full; further rejections are aggregated' });
  }

  return function logRejection({ status, reason, producerId, target, endpoint, redact = (v) => v }) {
    const entry = {
      event: 'ingest_rejected',
      status,
      reason: reason || REASONS[status] || 'rejected',
      producer: safeLabel(redact(producerId), ID_RE),
      target: redact(target) === REDACTED ? REDACTED
        : (safeLabel(target, HOSTNAME_RE) !== '-' ? target : safeLabel(target, SERVICE_RE)),
      endpoint: typeof endpoint === 'string' && /^\/[a-z0-9/_-]{0,64}$/.test(endpoint) ? endpoint : '-',
    };
    const t = now();
    flushOverflow(t);
    const key = `${entry.status}|${entry.reason}|${entry.producer}|${entry.target}|${entry.endpoint}`;
    if (!buckets.has(key) && buckets.size >= maxKeys) {
      evictExpired(t);
      if (buckets.size >= maxKeys) { overflowHit(t); return; }
    }
    const bucket = buckets.get(key);
    if (bucket && t - bucket.start < windowMs) { bucket.suppressed += 1; return; }
    const suppressed = bucket ? bucket.suppressed : 0;
    buckets.set(key, { start: t, suppressed: 0, entry });
    emit(summary(entry, suppressed));
  };
}

const logIngestRejection = createRejectionLogger();

/** One startup line: registry ok (with producer count) or invalid (never why). */
function logRegistryStatus(raw, legacyFleetToken = '', log = { info: console.log, warn: console.warn }) {
  const registry = loadProducerRegistry(raw, legacyFleetToken);
  if (registry.ok) {
    log.info(`producer ingest registry ok: ${registry.producers.length} producer(s)`);
  } else {
    log.warn('producer ingest registry INVALID or missing: ingest is rejecting all producer writes with 503');
  }
  return registry.ok;
}

module.exports = {
  createRejectionLogger,
  createSecretRedactor,
  logIngestRejection,
  logRegistryStatus,
  loadProducerRegistry,
  authenticateProducer,
  authorizeProducerHost,
  authorizeProducerService,
  isOperatorReadToken,
};
