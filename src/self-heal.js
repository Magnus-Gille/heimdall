'use strict';

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
const MAX_EVIDENCE_REFS = 8;
const MAX_RECENT_DIAGNOSES = 16;

const STATE_SCHEMA_VERSION = 'v1';
const SUPPORTED_EVIDENCE_SCHEMA_VERSION = 'v1';
const SAFE_ID = /^[a-z][a-z0-9-]{2,62}$/;
const OPAQUE_REF = /^ref:[a-z][a-z0-9-]{2,120}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function toUtcSecond(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  return {
    submittedAt: value.submittedAt,
    mode: value.mode === 'diagnosis-only' ? value.mode : 'diagnosis-only',
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
      const iso = toUtcSecond(submittedAtMs);
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

function taskTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function generateTaskId(serviceName, nowMs) {
  return `${taskTimestamp(nowMs)}-heal-${serviceName}`;
}

function makeEvidenceRef(service, subject) {
  const token = String(subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const ref = `ref:heim-self-heal-${service}-${token}`;
  if (!OPAQUE_REF.test(ref)) throw new Error(`opaque evidence ref invalid: ${ref}`);
  return ref;
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
    SELECT checked_at, service, host, deployed_commit
    FROM service_versions
    WHERE service = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(service);
}

function latestRestartMetricRow(db, service) {
  return db.prepare(`
    SELECT timestamp, value
    FROM metrics
    WHERE metric = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `).get(`service_restarts_24h_${service.replace(/[^a-zA-Z0-9_]/g, '_')}`);
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
    diagnosticRef: makeEvidenceRef(service, 'health'),
  };
}

function defaultRestartEvidenceLoader(db, service) {
  const row = latestRestartMetricRow(db, service);
  if (!row) return null;
  return {
    schemaVersion: SUPPORTED_EVIDENCE_SCHEMA_VERSION,
    serviceId: service,
    observedAt: row.timestamp,
    restartCount24h: row.value,
    diagnosticRef: makeEvidenceRef(service, 'restarts'),
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
  if (!SAFE_ID.test(evidence.serviceId) || !SAFE_ID.test(evidence.instanceId) || !validUtcSecond(evidence.observedAt)) {
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

function validateRestartEvidence(evidence, expectedService, nowMs) {
  if (!evidence) {
    return reject('restart-unavailable', 'unknown evidence: restart storm evidence unavailable');
  }
  const version = evidence.schemaVersion || evidence.schema_version;
  if (version !== SUPPORTED_EVIDENCE_SCHEMA_VERSION) {
    return reject('unsupported-version', 'unknown evidence: unsupported version');
  }
  if (evidence.serviceId !== expectedService || !validUtcSecond(evidence.observedAt) || !OPAQUE_REF.test(evidence.diagnosticRef)) {
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

function buildDiagnosisTaskContent({ service, host, unit, evidenceRefs }) {
  if (!SAFE_ID.test(service) || !SAFE_ID.test(host) || !isSafeUnitName(unit)) {
    throw new Error('validated service identity required');
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || evidenceRefs.length > MAX_EVIDENCE_REFS) {
    throw new Error('opaque evidence ref list invalid');
  }
  for (const ref of evidenceRefs) {
    if (!OPAQUE_REF.test(ref)) throw new Error(`opaque evidence ref invalid: ${ref}`);
  }

  return `## Task: Diagnose unhealthy ${service}

- **Runtime:** claude
- **Context:** scratch
- **Timeout:** 120000
- **Submitted by:** heimdall-self-heal
- **Reply-to:** none
- **Reply-format:** full
- **Task-type:** self-heal-diagnosis
- **Mode:** diagnosis-only
- **Actuation:** typed actuation blocked pending a reviewed allowlisted adapter
- **Dependency:** grimnir #183
- **Service:** ${service}
- **Host identity:** ${host}
- **Unit identity:** ${unit}
- **Evidence refs:** ${evidenceRefs.join(', ')}

### Prompt
Diagnose the unhealthy service using only the validated identities and bounded evidence refs above.
Do not mutate infrastructure, restart services, or broaden the task beyond diagnosis.
If this envelope is insufficient for a safe diagnosis, stop and report that it is blocked.

### Output
Report:
- diagnosis summary
- confidence
- whether typed actuation remains blocked
- operator follow-up`;
}

async function submitDiagnosisTask(rpc, service, target, evidenceRefs, nowMs) {
  const taskId = generateTaskId(service, nowMs);
  const content = buildDiagnosisTaskContent({
    service,
    host: target.host,
    unit: target.unit,
    evidenceRefs,
  });
  const submittedAt = toUtcSecond(nowMs);

  const result = await rpc('memory_write', {
    namespace: `tasks/${taskId}`,
    key: 'status',
    content,
    tags: ['pending', 'runtime:claude', 'type:heal', 'mode:diagnosis-only', `service:${service}`],
  });

  return { ok: !!result, taskId, submittedAt, content };
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

  state.circuitBreaker.recentDiagnoses = pruneRecentDiagnoses(
    state.circuitBreaker.recentDiagnoses,
    nowMs,
  );

  let tasksSubmitted = 0;
  const decisions = [];

  for (const service of services) {
    const healthEvidenceResult = validateHealthEvidence(
      healthEvidenceLoader(db, service, { nowMs }),
      service,
      nowMs,
    );

    if (!healthEvidenceResult.ok) {
      raiseBlockedAlert(db, service, healthEvidenceResult.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: healthEvidenceResult.reason, actuation: 'blocked' });
      continue;
    }

    const healthEvidence = healthEvidenceResult.value;

    if (healthEvidence.outcome === 'ok') {
      if (state.failures[service]) {
        logger.log(`  self-heal: ${service} recovered (was at ${state.failures[service]} consecutive failures)`);
      }
      delete state.failures[service];
      delete state.lastDiagnosis[service];
      delete state.diagnosisOutcomes[service];
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

    const restartEvidenceResult = validateRestartEvidence(
      restartEvidenceLoader(db, service, { nowMs }),
      service,
      nowMs,
    );
    if (!restartEvidenceResult.ok) {
      raiseBlockedAlert(db, service, restartEvidenceResult.detail);
      decisions.push({ service, diagnosis: 'blocked', reason: restartEvidenceResult.reason, actuation: 'blocked' });
      continue;
    }

    if (state.failures[service] < MIN_CONSECUTIVE_FAILURES) {
      decisions.push({ service, diagnosis: 'waiting', actuation: 'blocked' });
      continue;
    }

    const lastDiagnosis = state.lastDiagnosis[service];
    if (lastDiagnosis) {
      const elapsedMs = nowMs - Date.parse(lastDiagnosis.submittedAt);
      if (elapsedMs < COOLDOWN_MS) {
        raiseBlockedAlert(db, service, 'unknown evidence: cooldown active');
        decisions.push({ service, diagnosis: 'blocked', reason: 'cooldown', actuation: 'blocked' });
        continue;
      }
      if (state.diagnosisOutcomes[service]) {
        raiseBlockedAlert(db, service, 'unknown evidence: repeated failure after prior diagnosis-only run');
        decisions.push({ service, diagnosis: 'blocked', reason: 'repeated-failure', actuation: 'blocked' });
        continue;
      }
    }

    const evidenceRefs = [healthEvidence.diagnosticRef, restartEvidenceResult.value.diagnosticRef];
    let submission;
    try {
      submission = await submitDiagnosisTask(
        rpc,
        service,
        targetResult.value,
        evidenceRefs,
        nowMs,
      );
    } catch (err) {
      raiseBlockedAlert(db, service, `unknown evidence: ${err.message}`);
      decisions.push({ service, diagnosis: 'blocked', reason: 'invalid-envelope', actuation: 'blocked' });
      continue;
    }

    if (!submission.ok) {
      raiseBlockedAlert(db, service, 'unknown evidence: diagnosis submission failed');
      decisions.push({ service, diagnosis: 'blocked', reason: 'submission-failed', actuation: 'blocked' });
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
