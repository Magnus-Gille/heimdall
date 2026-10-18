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

module.exports = {
  loadProducerRegistry,
  authenticateProducer,
  authorizeProducerHost,
  authorizeProducerService,
  isOperatorReadToken,
};
