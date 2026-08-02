'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { muninRpc: muninRpcShared } = require('./munin-rpc');
const { createAlert, resolveAlert } = require('./db');
const { loadServicesWithMeta, loadConfig } = require('./config/services');
const { isDocumentationIpv4, isExampleHost } = require('./config/live-config');
const { canonicalHost, loadHostAliases } = require('./host-identity');
const { isSafeUnitName } = require('./drift');

const STATE_FILE = path.join(os.homedir(), '.heimdall', 'self-heal-state.json');
const HEALABLE_SERVICES = ['munin-memory', 'hugin', 'ratatoskr', 'skuld', 'mimir'];
const MIN_CONSECUTIVE_FAILURES = 2;
const COOLDOWN_MS = 60 * 60 * 1000;
const HEALTH_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
const RESTART_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
const RESTART_STORM_THRESHOLD = 3;
const MAX_CONTEXT_REFS = 8;
const MAX_RECENT_DIAGNOSES = 16;
const PENDING_RESERVATION_TTL_MS = 10 * 60 * 1000;

const STATE_SCHEMA_VERSION = 'v1';
const SUPPORTED_EVIDENCE_SCHEMA_VERSION = 'v1';
const SNAPSHOT_SCHEMA_VERSION = 'v1';
const SNAPSHOT_NAMESPACE = 'observations/self-heal';
const SNAPSHOT_KEY = 'snapshot';
const SAFE_ID = /^[a-z][a-z0-9-]{2,62}$/;
const OPAQUE_REF = /^ref:[a-z][a-z0-9-]{2,120}$/;
const HUGIN_CONTEXT_REF = /^(?:[a-z0-9][a-z0-9-]*\/)+[a-z0-9][a-z0-9-]*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EVIDENCE_IDENTITY = /^ref:(heim-sh-(sv|mt)-r([1-9]\d*)-t(\d{14})-d([a-f0-9]{12}))$/;

function toUtcSecond(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeLegacySubmittedAt(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function loadApiKey() {
  if (process.env.MUNIN_API_KEY) return process.env.MUNIN_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'repos', 'heimdall', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'repos', 'munin-memory', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  return null;
}

function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    failures: {},
    lastDiagnosis: {},
    diagnosisOutcomes: {},
    circuitBreaker: { recentDiagnoses: [] },
  };
}

function normalizeDiagnosisEntry(value) {
  if (!value || typeof value !== 'object') return null;
  if (!validUtcSecond(value.submittedAt)) return null;
  if (value.mode !== 'diagnosis-only') return null;
  return {
    submittedAt: value.submittedAt,
    mode: value.mode,
    taskId: typeof value.taskId === 'string' && value.taskId ? value.taskId : null,
  };
}

function normalizeState(raw) {
  const next = defaultState();
  if (!raw || typeof raw !== 'object') return next;

  if (raw.failures && typeof raw.failures === 'object') {
    for (const [service, count] of Object.entries(raw.failures)) {
      if (SAFE_ID.test(service) && Number.isInteger(count) && count >= 0) next.failures[service] = count;
    }
  }

  if (raw.lastDiagnosis && typeof raw.lastDiagnosis === 'object') {
    for (const [service, entry] of Object.entries(raw.lastDiagnosis)) {
      const normalized = normalizeDiagnosisEntry(entry);
      if (SAFE_ID.test(service) && normalized) next.lastDiagnosis[service] = normalized;
    }
  } else if (raw.lastHeal && typeof raw.lastHeal === 'object') {
    for (const [service, submittedAtMs] of Object.entries(raw.lastHeal)) {
      const iso = normalizeLegacySubmittedAt(submittedAtMs);
      if (SAFE_ID.test(service) && validUtcSecond(iso)) {
        next.lastDiagnosis[service] = { submittedAt: iso, mode: 'diagnosis-only', taskId: null };
      }
    }
  }

  if (raw.diagnosisOutcomes && typeof raw.diagnosisOutcomes === 'object') {
    for (const [service, entry] of Object.entries(raw.diagnosisOutcomes)) {
      const normalized = normalizeDiagnosisEntry(entry);
      if (SAFE_ID.test(service) && normalized) next.diagnosisOutcomes[service] = normalized;
    }
  }

  for (const [service, entry] of Object.entries(next.lastDiagnosis)) {
    if (!next.diagnosisOutcomes[service]) next.diagnosisOutcomes[service] = { ...entry };
  }

  const recent = raw.circuitBreaker && Array.isArray(raw.circuitBreaker.recentDiagnoses)
    ? raw.circuitBreaker.recentDiagnoses
    : [];
  next.circuitBreaker.recentDiagnoses = recent
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      if (!SAFE_ID.test(entry.service) || !validUtcSecond(entry.submittedAt)) return null;
      return { service: entry.service, submittedAt: entry.submittedAt };
    })
    .filter(Boolean)
    .slice(-MAX_RECENT_DIAGNOSES);

  return next;
}

function loadState(stateFile = STATE_FILE) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    return defaultState();
  }
}

function saveState(state, stateFile = STATE_FILE) {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(normalizeState(state), null, 2));
}

const muninRpc = (method, args) => muninRpcShared(method, args, {
  apiKey: loadApiKey(),
  timeoutMs: 10000,
  label: 'self-heal',
});

function validUtcSecond(value) {
  if (typeof value !== 'string' || !UTC_SECOND.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value;
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const iso = new Date(parsed).toISOString();
  return value === iso || value === iso.replace('.000Z', 'Z');
}

function taskTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function generateTaskId(serviceName, nowMs) {
  return `${taskTimestamp(nowMs)}-heal-${serviceName}`;
}

function compactUtcSecond(value) {
  return value.replace(/[^\d]/g, '').slice(0, 14);
}

function makeEvidenceRef(kind, { rowId, observedAt, digestParts = [] }) {
  if (!['sv', 'mt'].includes(kind)) throw new Error(`opaque evidence kind invalid: ${kind}`);
  if (!Number.isInteger(rowId) || rowId <= 0 || !validUtcTimestamp(observedAt)) {
    throw new Error('opaque evidence identity invalid');
  }

  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([kind, rowId, observedAt, ...digestParts]))
    .digest('hex')
    .slice(0, 12);
  const ref = `ref:heim-sh-${kind}-r${rowId}-t${compactUtcSecond(observedAt)}-d${digest}`;
  if (!OPAQUE_REF.test(ref)) throw new Error(`opaque evidence ref invalid: ${ref}`);
  return ref;
}

function parseEvidenceIdentity(ref) {
  if (typeof ref !== 'string') return null;
  const match = ref.match(EVIDENCE_IDENTITY);
  if (!match) return null;
  const rowId = Number.parseInt(match[3], 10);
  if (!Number.isInteger(rowId) || rowId <= 0) return null;
  return {
    opaqueRef: ref,
    slug: match[1],
    kind: match[2],
    rowId,
    compactObservedAt: match[4],
    digest: match[5],
  };
}

function buildObservationSnapshot(observationType, evidence) {
  const identity = parseEvidenceIdentity(evidence && evidence.diagnosticRef);
  if (!identity) throw new Error('snapshot identity invalid');

  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    source: 'heimdall-self-heal',
    observation_type: observationType,
    service_id: evidence.serviceId,
    observed_at: evidence.observedAt,
    opaque_ref: evidence.diagnosticRef,
    identity: {
      kind: identity.kind,
      row_id: identity.rowId,
      observed_at: evidence.observedAt,
      digest: identity.digest,
    },
  };

  if (observationType === 'service-health') {
    snapshot.instance_id = evidence.instanceId;
    snapshot.outcome = evidence.outcome;
  } else if (observationType === 'restart-budget') {
    snapshot.instance_id = evidence.instanceId;
    snapshot.restart_count_24h = evidence.restartCount24h;
  } else {
    throw new Error(`snapshot type invalid: ${observationType}`);
  }

  return {
    namespace: `${SNAPSHOT_NAMESPACE}/${identity.slug}`,
    key: SNAPSHOT_KEY,
    content: JSON.stringify(snapshot),
  };
}

function decodeMuninRead(result) {
  const text = result && result.content && result.content[0] && typeof result.content[0].text === 'string'
    ? result.content[0].text
    : null;
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { found: true, content: text, updatedAt: null };
  }

  if (!parsed || typeof parsed !== 'object') return { found: true, content: text, updatedAt: null };
  if (parsed.found === false) return { found: false, content: null, updatedAt: null };
  if (typeof parsed.content === 'string') {
    return {
      found: true,
      content: parsed.content,
      updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  }

  return { found: true, content: text, updatedAt: null };
}

function asContextRef(namespace, key) {
  return `${namespace}/${key}`;
}

async function writeAndProveMuninContent(rpc, writeArgs) {
  try {
    await rpc('memory_write', writeArgs);
  } catch {
    return false;
  }

  try {
    const readResult = decodeMuninRead(await rpc('memory_read', {
      namespace: writeArgs.namespace,
      key: writeArgs.key,
    }));
    return !!readResult && readResult.found && readResult.content === writeArgs.content;
  } catch {
    return false;
  }
}

async function persistObservationSnapshot(rpc, snapshot) {
  const ok = await writeAndProveMuninContent(rpc, {
    namespace: snapshot.namespace,
    key: snapshot.key,
    content: snapshot.content,
    tags: ['self-heal', 'diagnosis-context'],
    create_if_absent: true,
  });
  if (!ok) {
    throw new Error('snapshot persistence could not be proven');
  }

  return asContextRef(snapshot.namespace, snapshot.key);
}

function parseHuginTaskFields(content) {
  if (typeof content !== 'string' || content.trim() === '') return new Map();
  const header = content.split(/\n\n/u)[0];
  const fields = new Map();
  for (const line of header.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z -]*):\s*(.+)$/u);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

function extractContextRefsFromTaskContent(content) {
  const fields = parseHuginTaskFields(content);
  const raw = fields.get('Context-refs');
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const refs = raw.split(/,\s*/u).filter(Boolean);
  if (!refs.length || refs.length > MAX_CONTEXT_REFS) return null;
  if (refs.some((ref) => !HUGIN_CONTEXT_REF.test(ref))) return null;
  return refs;
}

function targetHost(value, isUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!isUrl) return value.trim();
  try { return new URL(value).hostname; } catch { return null; }
}

function hasPlaceholderRuntimeTarget(service) {
  for (const [field, isUrl] of [['health_url', true], ['ssh_host', false]]) {
    const host = targetHost(service && service[field], isUrl);
    if (host && (isDocumentationIpv4(host) || isExampleHost(host))) return true;
  }
  return false;
}

function blockedAlertTitle(service) {
  return `Self-heal blocked: ${service}`;
}

function raiseBlockedAlert(db, service, detail) {
  createAlert(
    db,
    'control-node',
    'service',
    'warning',
    blockedAlertTitle(service),
    detail,
    { dedup_key: `self-heal:${service}`, source: 'self-heal' },
  );
}

function resolveBlockedAlert(db, service) {
  resolveAlert(db, 'control-node', blockedAlertTitle(service));
}

function latestServiceVersionRow(db, service) {
  return db.prepare(`
    SELECT id, checked_at, service, host, deployed_commit
    FROM service_versions
    WHERE service = ?
    ORDER BY checked_at DESC, id DESC
    LIMIT 1
  `).get(service);
}

function latestRestartMetricRow(db, service) {
  const metricName = `service_restarts_24h_${service.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  return db.prepare(`
    SELECT id, timestamp, host, metric, value
    FROM metrics
    WHERE metric = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `).get(metricName);
}

function latestRestartMetricRowForHost(db, service, targetHost, aliases) {
  const metricName = `service_restarts_24h_${service.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const exact = db.prepare(`
    SELECT id, timestamp, host, metric, value
    FROM metrics
    WHERE metric = ?
      AND host = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `).get(metricName, targetHost);
  if (exact) return exact;

  const rows = db.prepare(`
    SELECT id, timestamp, host, metric, value
    FROM metrics
    WHERE metric = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 64
  `).all(metricName);
  return rows.find((row) => canonicalHost(row.host, aliases) === targetHost) || null;
}

function defaultHealthEvidenceLoader(db, service) {
  const row = latestServiceVersionRow(db, service);
  if (!row) return null;
  return {
    schemaVersion: SUPPORTED_EVIDENCE_SCHEMA_VERSION,
    serviceId: row.service,
    instanceId: row.host,
    observedAt: row.checked_at,
    outcome: row.deployed_commit == null ? 'failed' : 'ok',
    diagnosticRef: makeEvidenceRef('sv', {
      rowId: row.id,
      observedAt: row.checked_at,
      digestParts: [row.service, row.host],
    }),
  };
}

function defaultRestartEvidenceLoader(db, service, { targetHost, aliases } = {}) {
  const row = targetHost
    ? latestRestartMetricRowForHost(db, service, targetHost, aliases)
    : latestRestartMetricRow(db, service);
  if (!row) return null;
  return {
    schemaVersion: SUPPORTED_EVIDENCE_SCHEMA_VERSION,
    serviceId: service,
    instanceId: row.host,
    observedAt: row.timestamp,
    restartCount24h: row.value,
    diagnosticRef: makeEvidenceRef('mt', {
      rowId: row.id,
      observedAt: row.timestamp,
      digestParts: [service, row.host, row.metric],
    }),
  };
}

function reject(reason, detail) {
  return { ok: false, reason, detail };
}

function accept(value) {
  return { ok: true, value };
}

function validateHealthEvidence(evidence, expectedService, nowMs) {
  if (!evidence) return reject('no-data', 'unknown evidence: no data');
  const version = evidence.schemaVersion || evidence.schema_version;
  if (version !== SUPPORTED_EVIDENCE_SCHEMA_VERSION) {
    return reject('unsupported-version', 'unknown evidence: unsupported version');
  }
  if (!SAFE_ID.test(evidence.serviceId) || !SAFE_ID.test(evidence.instanceId) || !validUtcTimestamp(evidence.observedAt)) {
    return reject('malformed', 'unknown evidence: malformed');
  }
  if (evidence.serviceId !== expectedService) return reject('identity-mismatch', 'unknown evidence: identity mismatch');
  if (!['ok', 'failed'].includes(evidence.outcome) || !OPAQUE_REF.test(evidence.diagnosticRef)) {
    return reject('malformed', 'unknown evidence: malformed');
  }
  const ageMs = nowMs - Date.parse(evidence.observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return reject('malformed', 'unknown evidence: malformed');
  if (ageMs > HEALTH_EVIDENCE_MAX_AGE_MS) return reject('stale', 'unknown evidence: stale');
  return accept(evidence);
}

function validateRestartEvidence(evidence, expectedService, expectedHost, aliases, nowMs) {
  if (!evidence) {
    return reject('restart-unavailable', 'unknown evidence: restart storm evidence unavailable');
  }
  const version = evidence.schemaVersion || evidence.schema_version;
  if (version !== SUPPORTED_EVIDENCE_SCHEMA_VERSION) {
    return reject('unsupported-version', 'unknown evidence: unsupported version');
  }
  if (!SAFE_ID.test(evidence.serviceId) || !SAFE_ID.test(evidence.instanceId)
      || !validUtcTimestamp(evidence.observedAt) || !OPAQUE_REF.test(evidence.diagnosticRef)) {
    return reject('malformed', 'unknown evidence: malformed');
  }
  if (evidence.serviceId !== expectedService) {
    return reject('identity-mismatch', 'unknown evidence: identity mismatch');
  }
  if (canonicalHost(evidence.instanceId, aliases) !== expectedHost) {
    return reject('identity-mismatch', 'unknown evidence: identity mismatch');
  }
  if (!Number.isFinite(evidence.restartCount24h) || evidence.restartCount24h < 0) {
    return reject('malformed', 'unknown evidence: malformed');
  }
  const ageMs = nowMs - Date.parse(evidence.observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return reject('malformed', 'unknown evidence: malformed');
  if (ageMs > RESTART_EVIDENCE_MAX_AGE_MS) return reject('stale', 'unknown evidence: stale');
  if (evidence.restartCount24h >= RESTART_STORM_THRESHOLD) {
    return reject('restart-exhausted', 'unknown evidence: restart storm exhausted');
  }
  return accept(evidence);
}

function resolveRegistryContext({ configPath, grimnirPath, logger }) {
  const config = loadConfig(configPath);
  const aliases = loadHostAliases(config);
  const registry = loadServicesWithMeta({ configPath, grimnirPath, logger });
  return { aliases, registry };
}

function resolveHealTarget(serviceName, healthEvidence, registryContext) {
  if (!registryContext.registry || registryContext.registry.source !== 'grimnir') {
    return reject('config-missing', 'unknown evidence: validated registry missing');
  }
  const service = registryContext.registry.services.find((candidate) => candidate.name === serviceName);
  if (!service) return reject('config-missing', 'unknown evidence: validated registry missing');

  const hostId = canonicalHost(service.host, registryContext.aliases);
  const evidenceHostId = canonicalHost(healthEvidence.instanceId, registryContext.aliases);
  const unit = service.systemd_unit || service.name;

  if (!SAFE_ID.test(serviceName) || !SAFE_ID.test(hostId) || !isSafeUnitName(unit)) {
    return reject('identity-mismatch', 'unknown evidence: identity mismatch');
  }
  if (evidenceHostId !== hostId) return reject('identity-mismatch', 'unknown evidence: identity mismatch');
  if (!service.health_url && !service.ssh_host) return reject('config-missing', 'unknown evidence: validated registry missing');
  if (hasPlaceholderRuntimeTarget(service)) {
    return reject('placeholder', 'unknown evidence: placeholder runtime identity');
  }

  return accept({ service: serviceName, host: hostId, unit });
}

function pruneRecentDiagnoses(recent, nowMs) {
  return (Array.isArray(recent) ? recent : [])
    .filter((entry) => entry && SAFE_ID.test(entry.service) && validUtcSecond(entry.submittedAt))
    .filter((entry) => nowMs - Date.parse(entry.submittedAt) <= COOLDOWN_MS)
    .slice(-MAX_RECENT_DIAGNOSES);
}

function latestRecentDiagnosis(recent, service) {
  if (!Array.isArray(recent)) return null;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (entry && entry.service === service) return entry;
  }
  return null;
}

function ensureReservationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_heal_reservations (
      service TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      expires_at TEXT,
      submitted_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}

function normalizeReservationRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (!SAFE_ID.test(row.service) || !validUtcSecond(row.reserved_at) || !validUtcSecond(row.updated_at)) {
    return null;
  }
  if (!['pending', 'submitted'].includes(row.phase) || typeof row.task_id !== 'string' || row.task_id === '') {
    return null;
  }
  if (row.phase === 'pending' && !validUtcSecond(row.expires_at)) return null;
  if (row.phase === 'submitted' && row.expires_at != null) return null;
  if (row.submitted_at != null && !validUtcSecond(row.submitted_at)) return null;
  return {
    service: row.service,
    phase: row.phase,
    taskId: row.task_id,
    reservedAt: row.reserved_at,
    expiresAt: row.expires_at || null,
    submittedAt: row.submitted_at || null,
    updatedAt: row.updated_at,
  };
}

function reservationDetail(phase) {
  return phase === 'submitted'
    ? 'unknown evidence: diagnosis reservation submitted'
    : 'unknown evidence: diagnosis reservation pending';
}

function readReservationRow(db, service) {
  return db.prepare(`
    SELECT service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
    FROM self_heal_reservations
    WHERE service = ?
  `).get(service);
}

function runReservationTransaction(db, fn) {
  const tx = db.transaction(fn);
  try {
    return tx.immediate();
  } catch (err) {
    if (/SQLITE_BUSY|SQLITE_LOCKED/u.test(String(err && err.message))) {
      return reject('reservation-pending', reservationDetail('pending'));
    }
    throw err;
  }
}

function claimDiagnosisReservation(db, service, taskId, nowMs, ttlMs = PENDING_RESERVATION_TTL_MS) {
  ensureReservationTable(db);
  const nowIso = toUtcSecond(nowMs);
  const expiresAt = toUtcSecond(nowMs + ttlMs);
  const select = db.prepare(`
    SELECT service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
    FROM self_heal_reservations
    WHERE service = ?
  `);
  const insert = db.prepare(`
    INSERT INTO self_heal_reservations (
      service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
    ) VALUES (?, 'pending', ?, ?, ?, NULL, ?)
  `);
  const recover = db.prepare(`
    UPDATE self_heal_reservations
    SET phase = 'pending',
        task_id = ?,
        reserved_at = ?,
        expires_at = ?,
        submitted_at = NULL,
        updated_at = ?
    WHERE service = ?
      AND phase = 'pending'
      AND task_id = ?
      AND updated_at = ?
  `);

  const outcome = runReservationTransaction(db, () => {
    const current = normalizeReservationRow(select.get(service));
    if (!current) {
      const raw = select.get(service);
      if (raw) {
        return {
          ok: false,
          reason: 'reservation-invalid',
          detail: 'unknown evidence: diagnosis reservation invalid',
        };
      }
      insert.run(service, taskId, nowIso, expiresAt, nowIso);
      return { ok: true };
    }

    if (current.phase === 'pending' && nowMs >= Date.parse(current.expiresAt)) {
      const recovered = recover.run(
        taskId,
        nowIso,
        expiresAt,
        nowIso,
        service,
        current.taskId,
        current.updatedAt,
      );
      if (recovered.changes === 1) return { ok: true };
      const latest = normalizeReservationRow(select.get(service));
      return {
        ok: false,
        reason: latest && latest.phase === 'submitted' ? 'reservation-submitted' : 'reservation-pending',
        detail: reservationDetail(latest && latest.phase),
      };
    }

    return {
      ok: false,
      reason: current.phase === 'submitted' ? 'reservation-submitted' : 'reservation-pending',
      detail: reservationDetail(current.phase),
    };
  });
  return outcome.ok === false && outcome.detail ? outcome : outcome;
}

function markDiagnosisReservationSubmitted(db, service, taskId, nowMs) {
  ensureReservationTable(db);
  const nowIso = toUtcSecond(nowMs);
  const update = db.prepare(`
    UPDATE self_heal_reservations
    SET phase = 'submitted',
        expires_at = NULL,
        submitted_at = COALESCE(submitted_at, ?),
        updated_at = ?
    WHERE service = ?
      AND task_id = ?
      AND phase = 'pending'
  `);
  const select = db.prepare(`
    SELECT service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
    FROM self_heal_reservations
    WHERE service = ?
  `);

  const outcome = runReservationTransaction(db, () => {
    const result = update.run(nowIso, nowIso, service, taskId);
    if (result.changes === 1) return true;
    const current = normalizeReservationRow(select.get(service));
    return !!current && current.phase === 'submitted' && current.taskId === taskId;
  });
  return outcome === true;
}

function clearDiagnosisReservation(db, service) {
  ensureReservationTable(db);
  db.prepare('DELETE FROM self_heal_reservations WHERE service = ?').run(service);
}

function parseResetReservations(optionsResetReservations) {
  const fromOptions = Array.isArray(optionsResetReservations) ? optionsResetReservations : null;
  const fromEnv = typeof process.env.HEIMDALL_SELF_HEAL_RESET_RESERVATIONS === 'string'
    ? process.env.HEIMDALL_SELF_HEAL_RESET_RESERVATIONS.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  return new Set((fromOptions || fromEnv).filter((service) => SAFE_ID.test(service)));
}

function recoverDiagnosisReservation(db, service, nowMs) {
  ensureReservationTable(db);
  const current = normalizeReservationRow(readReservationRow(db, service));
  if (!current) return false;
  if (current.phase === 'pending' && current.expiresAt && nowMs >= Date.parse(current.expiresAt)) {
    clearDiagnosisReservation(db, service);
    return true;
  }
  if (current.phase === 'submitted' && current.submittedAt
      && nowMs - Date.parse(current.submittedAt) >= COOLDOWN_MS) {
    clearDiagnosisReservation(db, service);
    return true;
  }
  return false;
}

function buildDiagnosisTaskContent({ service, host, unit, contextRefs }) {
  if (!SAFE_ID.test(service) || !SAFE_ID.test(host) || !isSafeUnitName(unit)) {
    throw new Error('validated service identity required');
  }
  if (!Array.isArray(contextRefs) || contextRefs.length === 0 || contextRefs.length > MAX_CONTEXT_REFS) {
    throw new Error('Hugin context ref list invalid');
  }
  for (const ref of contextRefs) {
    if (!HUGIN_CONTEXT_REF.test(ref)) throw new Error(`Hugin context ref invalid: ${ref}`);
  }

  return `Task: Diagnose unhealthy ${service}
Runtime: claude
Context: scratch
Timeout: 120000
Submitted by: heimdall-self-heal
Reply-to: none
Reply-format: full
Task-type: self-heal-diagnosis
Mode: diagnosis-only
Actuation: typed actuation blocked pending a reviewed allowlisted adapter
Dependency: grimnir #183
Service: ${service}
Host identity: ${host}
Unit identity: ${unit}
Context-refs: ${contextRefs.join(', ')}

### Prompt
Diagnose the unhealthy service using only the validated identities and bounded context refs above.
Do not mutate infrastructure, restart services, or broaden the task beyond diagnosis.
If this envelope is insufficient for a safe diagnosis, stop and report that it is blocked.

### Output
Report:
- diagnosis summary
- confidence
- whether typed actuation remains blocked
- operator follow-up`;
}

async function submitDiagnosisTask(rpc, taskId, service, target, contextRefs, nowMs) {
  const content = buildDiagnosisTaskContent({
    service,
    host: target.host,
    unit: target.unit,
    contextRefs,
  });
  const parsedRefs = extractContextRefsFromTaskContent(content);
  if (!parsedRefs || parsedRefs.length !== contextRefs.length
      || parsedRefs.some((ref, index) => ref !== contextRefs[index])) {
    throw new Error('task context refs not resolvable by Hugin');
  }
  const submittedAt = toUtcSecond(nowMs);

  const ok = await writeAndProveMuninContent(rpc, {
    namespace: `tasks/${taskId}`,
    key: 'status',
    content,
    tags: ['pending', 'runtime:claude', 'type:heal', 'mode:diagnosis-only', `service:${service}`],
  });

  return { ok, taskId, submittedAt, content };
}

async function checkAndHeal(db, options = {}) {
  if (!/^(1|true)$/i.test(process.env.HEIMDALL_SELF_HEAL_ENABLED || '')) {
    console.log('  self-heal: disabled (set HEIMDALL_SELF_HEAL_ENABLED=1 to opt in)');
    return { enabled: false, tasksSubmitted: 0 };
  }

  const logger = options.logger || console;
  const services = Array.isArray(options.services) && options.services.length ? options.services : HEALABLE_SERVICES;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const state = normalizeState(options.state || loadState(options.stateFile || STATE_FILE));
  const save = typeof options.saveState === 'function'
    ? options.saveState
    : (next) => saveState(next, options.stateFile || STATE_FILE);
  const rpc = options.rpc || muninRpc;
  const healthEvidenceLoader = options.healthEvidenceLoader || defaultHealthEvidenceLoader;
  const restartEvidenceLoader = options.restartEvidenceLoader || defaultRestartEvidenceLoader;
  const registryContext = resolveRegistryContext(options);
  const pendingReservationTtlMs = Number.isFinite(options.pendingReservationTtlMs)
    ? options.pendingReservationTtlMs
    : PENDING_RESERVATION_TTL_MS;
  const resetReservations = parseResetReservations(options.resetReservations);

  ensureReservationTable(db);

  state.circuitBreaker.recentDiagnoses = pruneRecentDiagnoses(
    state.circuitBreaker.recentDiagnoses,
    nowMs,
  );

  let tasksSubmitted = 0;
  const decisions = [];

  for (const service of services) {
    if (resetReservations.has(service) && recoverDiagnosisReservation(db, service, nowMs)) {
      logger.log(`  self-heal: ${service} reservation reset by operator request`);
    }

    let healthEvidence;
    let healthEvidenceResult;
    try {
      healthEvidenceResult = validateHealthEvidence(
        healthEvidenceLoader(db, service, { nowMs }),
        service,
        nowMs,
      );
    } catch (err) {
      raiseBlockedAlert(db, service, `unknown evidence: ${err.message}`);
      decisions.push({ service, diagnosis: 'blocked', reason: 'invalid-evidence', actuation: 'blocked' });
      continue;
    }

    if (!healthEvidenceResult.ok) {
      raiseBlockedAlert(db, service, healthEvidenceResult.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: healthEvidenceResult.reason, actuation: 'blocked' });
      continue;
    }

    healthEvidence = healthEvidenceResult.value;

    if (healthEvidence.outcome === 'ok') {
      if (state.failures[service]) {
        logger.log(`  self-heal: ${service} recovered (was at ${state.failures[service]} consecutive failures)`);
      }
      delete state.failures[service];
      delete state.lastDiagnosis[service];
      delete state.diagnosisOutcomes[service];
      clearDiagnosisReservation(db, service);
      resolveBlockedAlert(db, service);
      decisions.push({ service, diagnosis: 'not-needed', actuation: 'blocked' });
      continue;
    }

    state.failures[service] = (state.failures[service] || 0) + 1;
    logger.log(`  self-heal: ${service} unhealthy (${state.failures[service]} consecutive)`);

    const targetResult = resolveHealTarget(service, healthEvidence, registryContext);
    if (!targetResult.ok) {
      raiseBlockedAlert(db, service, targetResult.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: targetResult.reason, actuation: 'blocked' });
      continue;
    }

    let restartEvidenceResult;
    try {
      restartEvidenceResult = validateRestartEvidence(
        restartEvidenceLoader(db, service, {
          nowMs,
          targetHost: targetResult.value.host,
          aliases: registryContext.aliases,
          healthEvidence,
        }),
        service,
        targetResult.value.host,
        registryContext.aliases,
        nowMs,
      );
    } catch (err) {
      raiseBlockedAlert(db, service, `unknown evidence: ${err.message}`);
      decisions.push({ service, diagnosis: 'blocked', reason: 'invalid-evidence', actuation: 'blocked' });
      continue;
    }
    if (!restartEvidenceResult.ok) {
      raiseBlockedAlert(db, service, restartEvidenceResult.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: restartEvidenceResult.reason, actuation: 'blocked' });
      continue;
    }

    if (state.failures[service] < MIN_CONSECUTIVE_FAILURES) {
      decisions.push({ service, diagnosis: 'waiting', actuation: 'blocked' });
      continue;
    }

    const cooldownAnchor = latestRecentDiagnosis(state.circuitBreaker.recentDiagnoses, service) || state.lastDiagnosis[service];
    if (cooldownAnchor) {
      const elapsedMs = nowMs - Date.parse(cooldownAnchor.submittedAt);
      if (elapsedMs < COOLDOWN_MS) {
        raiseBlockedAlert(db, service, 'unknown evidence: cooldown active');
        decisions.push({ service, diagnosis: 'blocked', reason: 'cooldown', actuation: 'blocked' });
        continue;
      }
    }

    const lastDiagnosis = state.lastDiagnosis[service];
    if (lastDiagnosis) {
      if (state.diagnosisOutcomes[service]) {
        raiseBlockedAlert(db, service, 'unknown evidence: repeated failure after prior diagnosis-only run');
        decisions.push({ service, diagnosis: 'blocked', reason: 'repeated-failure', actuation: 'blocked' });
        continue;
      }
    }

    const taskId = generateTaskId(service, nowMs);
    const reservation = claimDiagnosisReservation(
      db,
      service,
      taskId,
      nowMs,
      pendingReservationTtlMs,
    );
    if (!reservation.ok) {
      raiseBlockedAlert(db, service, reservation.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: reservation.reason, actuation: 'blocked' });
      continue;
    }

    let contextRefs;
    let submission;
    try {
      contextRefs = [];
      for (const snapshot of [
        buildObservationSnapshot('service-health', healthEvidence),
        buildObservationSnapshot('restart-budget', restartEvidenceResult.value),
      ]) {
        contextRefs.push(await persistObservationSnapshot(rpc, snapshot));
      }

      submission = await submitDiagnosisTask(
        rpc,
        taskId,
        service,
        targetResult.value,
        contextRefs,
        nowMs,
      );
    } catch (err) {
      clearDiagnosisReservation(db, service);
      raiseBlockedAlert(db, service, `unknown evidence: ${err.message}`);
      decisions.push({
        service,
        diagnosis: 'blocked',
        reason: /snapshot persistence/i.test(err.message) ? 'snapshot-unproven' : 'invalid-envelope',
        actuation: 'blocked',
      });
      continue;
    }

    if (!submission.ok) {
      raiseBlockedAlert(db, service, 'unknown evidence: diagnosis submission could not be confirmed; reservation held');
      decisions.push({ service, diagnosis: 'blocked', reason: 'submission-unconfirmed', actuation: 'blocked' });
      continue;
    }
    if (!markDiagnosisReservationSubmitted(db, service, taskId, nowMs)) {
      raiseBlockedAlert(db, service, 'unknown evidence: diagnosis reservation transition failed');
      decisions.push({ service, diagnosis: 'blocked', reason: 'reservation-transition', actuation: 'blocked' });
      continue;
    }

    state.lastDiagnosis[service] = {
      submittedAt: submission.submittedAt,
      mode: 'diagnosis-only',
      taskId: submission.taskId,
    };
    state.diagnosisOutcomes[service] = {
      submittedAt: submission.submittedAt,
      mode: 'diagnosis-only',
      taskId: submission.taskId,
    };
    state.circuitBreaker.recentDiagnoses.push({
      service,
      submittedAt: submission.submittedAt,
    });
    state.circuitBreaker.recentDiagnoses = pruneRecentDiagnoses(
      state.circuitBreaker.recentDiagnoses,
      nowMs,
    );
    tasksSubmitted++;
    resolveBlockedAlert(db, service);
    decisions.push({ service, diagnosis: 'submitted', actuation: 'blocked', reason: 'typed-adapter-missing' });

    await rpc('memory_log', {
      namespace: 'infrastructure/self-heal',
      content: `Diagnosis-only self-heal submitted for ${service}. Task: ${submission.taskId}. Dependency: grimnir #183.`,
      tags: ['self-heal', 'diagnosis-only', `service:${service}`],
    });
  }

  save(state);

  if (tasksSubmitted > 0) {
    logger.log(`  self-heal: ${tasksSubmitted} diagnosis-only task(s) submitted`);
  } else {
    const trackedFailures = Object.keys(state.failures).length;
    if (trackedFailures === 0) logger.log(`  self-heal: all ${services.length} services healthy`);
    else logger.log(`  self-heal: ${services.length - trackedFailures} healthy, ${trackedFailures} unhealthy tracked`);
  }

  return { enabled: true, tasksSubmitted, decisions };
}

module.exports = {
  checkAndHeal,
  buildDiagnosisTaskContent,
};
