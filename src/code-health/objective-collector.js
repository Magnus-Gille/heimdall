'use strict';

const { REPOSITORIES } = require('./registry');
const { LIMITS, parseObjectiveArtifact } = require('./artifact');
const { admitObjectiveArtifact, pruneExpiredEvidence, writeAudit, isoNow, objectiveSourceId } = require('./store');

const DEFAULT_OBJECTIVE_SOURCE_CONFIG = Object.freeze({ enabled: false });
const TRUSTED_EVENTS = new Set(['schedule', 'workflow_dispatch']);

function validInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateTransportMetadata(candidate, source) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid transport metadata');
  const { workflow, run, artifact } = candidate;
  if (!workflow || workflow.path !== source.workflowPath
    || !run || run.repository_owner !== source.owner || run.repository_name !== source.name
    || run.branch !== 'main' || !TRUSTED_EVENTS.has(run.event) || run.status !== 'completed'
    || !Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.attempt) || run.attempt < 1
    || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || !validInstant(run.created_at)
    || !artifact || !Number.isSafeInteger(artifact.id) || artifact.id < 1
    || artifact.name !== 'code-health-v1' || !Number.isSafeInteger(artifact.size_in_bytes)
    || artifact.size_in_bytes < 1 || artifact.size_in_bytes > LIMITS.archiveBytes
    || !validInstant(artifact.created_at)
    || artifact.workflow_run_id !== run.id || artifact.workflow_run_attempt !== run.attempt) {
    throw new Error('transport provenance does not match the code-health source gate');
  }
  return Object.freeze({
    repositoryOwner: run.repository_owner,
    repositoryName: run.repository_name,
    headSha: run.head_sha,
    runId: run.id,
    attempt: run.attempt,
    event: run.event,
    runCreatedAt: run.created_at,
    artifactId: artifact.id,
    artifactCreatedAt: artifact.created_at,
    artifactSize: artifact.size_in_bytes,
  });
}

function auditAttempt(db, now, source, operation, status) {
  writeAudit(db, { eventAt: now, sourceId: objectiveSourceId(source.owner, source.name), sourceKind: 'objective', operation, status,
    repoOwner: source.owner, repoName: source.name, recordCount: 0 });
}

/**
 * Collect only completed, allowlisted schedule/manual workflow artifacts.
 * `transport` is an internal adapter over authenticated read-only GitHub data;
 * tests inject it. The archive's manifest never supplies this run provenance.
 */
async function collectObjectiveReports({
  db,
  config = DEFAULT_OBJECTIVE_SOURCE_CONFIG,
  transport = null,
  clock = () => new Date(),
} = {}) {
  if (!db) throw new TypeError('database is required');
  const now = isoNow(clock());
  const expired = pruneExpiredEvidence(db, now);
  if (config?.enabled !== true) return { status: 'disabled', expired };
  if (!transport || typeof transport.listArtifacts !== 'function' || typeof transport.downloadArtifact !== 'function') {
    for (const source of REPOSITORIES) auditAttempt(db, now, source, 'admit', 'unconfigured');
    return { status: 'unconfigured', reason: 'authenticated-transport-not-configured', expired, admitted: 0, rejected: 0 };
  }

  let admitted = 0;
  let replayed = 0;
  let rejected = 0;
  let unavailable = 0;
  for (const source of REPOSITORIES) {
    let candidates;
    try {
      candidates = await transport.listArtifacts({
        owner: source.owner,
        repository: source.name,
        workflowPath: source.workflowPath,
        branch: 'main',
        events: [...TRUSTED_EVENTS],
        artifactName: 'code-health-v1',
      });
    } catch {
      unavailable += 1;
      auditAttempt(db, isoNow(clock()), source, 'admit', 'unavailable');
      continue;
    }
    if (!Array.isArray(candidates)) {
      unavailable += 1;
      auditAttempt(db, isoNow(clock()), source, 'admit', 'unavailable');
      continue;
    }
    if (candidates.length === 0) auditAttempt(db, isoNow(clock()), source, 'admit', 'no-artifacts');
    for (const candidate of candidates) {
      let provenance;
      try {
        provenance = validateTransportMetadata(candidate, source);
        // The transport receives only a provider artifact ID and fixed repository;
        // producer-controlled download URLs are never accepted or fetched here.
        const archiveBytes = await transport.downloadArtifact({
          owner: source.owner,
          repository: source.name,
          artifactId: provenance.artifactId,
        });
        if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) throw new Error('artifact bytes are unavailable');
        if (archiveBytes.byteLength !== provenance.artifactSize) throw new Error('artifact size does not match provider metadata');
        const parsed = await parseObjectiveArtifact(Buffer.from(archiveBytes), provenance);
        const result = await admitObjectiveArtifact(db, parsed, provenance, clock());
        admitted += result.admitted;
        replayed += result.replayed;
      } catch {
        rejected += 1;
        auditAttempt(db, isoNow(clock()), source, 'admit', 'rejected');
      }
    }
  }
  return {
    status: rejected > 0 ? (admitted + replayed > 0 ? 'partial' : 'rejected') : unavailable > 0 ? 'partial' : admitted + replayed > 0 ? 'committed' : 'no-artifacts',
    expired,
    admitted,
    replayed,
    rejected,
    unavailable,
  };
}

module.exports = { DEFAULT_OBJECTIVE_SOURCE_CONFIG, TRUSTED_EVENTS, validateTransportMetadata, collectObjectiveReports };
