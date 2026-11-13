'use strict';

const { REPOSITORIES } = require('./registry');
const { LIMITS, parseObjectiveArtifact } = require('./artifact');
const {
  admitObjectiveArtifact, pruneExpiredEvidence, writeAudit, isoNow, objectiveSourceId, recordRejectedRun, isRunSettled,
  newestAdmittedRunCreatedAt, isRejectionSuperseded,
} = require('./store');

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

class StageRejection extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

// Map a failed step to its bounded stage code. The original error message is
// discarded except for the transport's own scan-deadline signal.
async function stage(reasonCode, step) {
  try {
    return await step();
  } catch (error) {
    if (error?.message === 'github-scan-deadline-exceeded') throw error;
    throw new StageRejection(reasonCode);
  }
}

function sourceStatus({ unavailable, rejected, superseded = 0, incomplete, admitted, current }) {
  if (unavailable) return 'unavailable';
  if (rejected - superseded > 0) return 'rejected';
  if (incomplete) return 'incomplete';
  if (admitted > 0) return 'committed';
  // Superseded rejections mean the scan handled candidates and found nothing
  // admissible that was new, which is current rather than no-artifacts.
  return current || superseded > 0 ? 'current' : 'no-artifacts';
}

/**
 * Collect only completed, allowlisted schedule/manual workflow artifacts.
 * `transport` is an internal adapter over authenticated read-only GitHub data;
 * tests inject it. The archive's manifest never supplies this run provenance.
 *
 * Each source gets exactly one collector-level audit row per cycle, written
 * last, by precedence unavailable > rejected > incomplete > committed >
 * current (complete scan, nothing new) > no-artifacts. A rejection of a run
 * created strictly before the newest tracked admitted run (evaluated at the
 * end of the source's cycle) is superseded and does not count as rejected;
 * it is still recorded and retried.
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
  let supersededRejections = 0;
  let unavailable = 0;
  let skipped = 0;
  let incomplete = false;
  const sources = [];
  for (const source of REPOSITORIES) {
    const isSettled = (runId, attempt) => isRunSettled(db, source.owner, source.name, runId, attempt);
    const tally = { unavailable: false, rejected: 0, superseded: 0, incomplete: false, admitted: 0, current: false };
    // Creation time of each rejected run this cycle; null when provenance is unknown.
    const rejectedCreatedAt = [];
    const finish = () => {
      if (rejectedCreatedAt.length > 0) {
        const newestAdmitted = newestAdmittedRunCreatedAt(db, source.owner, source.name);
        tally.superseded = rejectedCreatedAt.filter((at) => isRejectionSuperseded(at, newestAdmitted)).length;
        supersededRejections += tally.superseded;
      }
      const status = sourceStatus(tally);
      auditAttempt(db, isoNow(clock()), source, 'admit', status);
      sources.push({ repository: source.name, status });
    };
    let listing;
    try {
      listing = await transport.listArtifacts({
        owner: source.owner,
        repository: source.name,
        workflowPath: source.workflowPath,
        branch: 'main',
        events: [...TRUSTED_EVENTS],
        artifactName: 'code-health-v1',
        isSettled,
      });
    } catch {
      listing = null;
    }
    const candidates = Array.isArray(listing) ? listing : listing?.candidates;
    if (!Array.isArray(candidates)) {
      unavailable += 1;
      tally.unavailable = true;
      finish();
      continue;
    }
    if (!Array.isArray(listing) && listing.incomplete === true) tally.incomplete = true;
    if (!Array.isArray(listing) && Number.isSafeInteger(listing.settledRuns) && listing.settledRuns > 0) tally.current = true;
    for (const candidate of candidates) {
      // Defence in depth for transports that ignore the predicate: a settled
      // attempt is never downloaded or re-parsed.
      if (isSettled(candidate?.run?.id, candidate?.run?.attempt)) {
        skipped += 1;
        tally.current = true;
        continue;
      }
      let provenance = null;
      try {
        provenance = await stage('transport-provenance-invalid', () => validateTransportMetadata(candidate, source));
        // The transport receives only a provider artifact ID and fixed repository;
        // producer-controlled download URLs are never accepted or fetched here.
        const archiveBytes = await stage('artifact-download-failed', async () => {
          const bytes = await transport.downloadArtifact({
            owner: source.owner,
            repository: source.name,
            artifactId: provenance.artifactId,
          });
          if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('artifact bytes are unavailable');
          return bytes;
        });
        if (archiveBytes.byteLength !== provenance.artifactSize) throw new StageRejection('artifact-size-mismatch');
        const parsed = await stage('artifact-parse-rejected', () => parseObjectiveArtifact(Buffer.from(archiveBytes), provenance));
        const result = await stage('admission-rejected', () => admitObjectiveArtifact(db, parsed, provenance, clock()));
        admitted += result.admitted;
        replayed += result.replayed;
        tally.admitted += result.admitted;
        if (result.admitted === 0) tally.current = true;
      } catch (error) {
        if (error?.message === 'github-scan-deadline-exceeded') {
          tally.incomplete = true;
          break;
        }
        rejected += 1;
        tally.rejected += 1;
        rejectedCreatedAt.push(provenance?.runCreatedAt ?? null);
        const reasonCode = error instanceof StageRejection ? error.reasonCode : 'admission-rejected';
        recordRejectedRun(db, {
          repoOwner: source.owner,
          repoName: source.name,
          runId: provenance?.runId ?? candidate?.run?.id,
          attempt: provenance?.attempt ?? candidate?.run?.attempt,
          reasonCode,
          artifactId: provenance?.artifactId ?? null,
          runCreatedAt: provenance?.runCreatedAt ?? null,
        }, clock());
      }
    }
    if (tally.incomplete) incomplete = true;
    finish();
  }
  return {
    status: rejected - supersededRejections > 0 ? (admitted + replayed > 0 ? 'partial' : 'rejected')
      : unavailable > 0 || incomplete ? 'partial'
        : admitted > 0 ? 'committed'
          : sources.some((item) => item.status === 'current') ? 'current' : 'no-artifacts',
    expired,
    admitted,
    replayed,
    skipped,
    rejected,
    supersededRejections,
    unavailable,
    incomplete,
    sources,
  };
}

module.exports = { DEFAULT_OBJECTIVE_SOURCE_CONFIG, TRUSTED_EVENTS, validateTransportMetadata, collectObjectiveReports };
