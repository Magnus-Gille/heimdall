'use strict';

const crypto = require('node:crypto');
const { loadContract } = require('./contract');
const { EXPECTED_SLOTS } = require('./registry');
const { canonical } = require('./artifact');
const { REJECTION_REASONS } = require('./collection-status');

const OBJECTIVE_RETENTION_MONTHS = 6;
// A rejected run is retried, and its row refreshed, on every cycle while it is
// among the newest unsettled runs in the listing window. One that has not been
// retried for this long can no longer be recovered by the collector, so it must
// stop reading as a current rejection.
const REJECTED_RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
const ALLOWED_WINDOWS = new Set([30, 90, 365]);
const MAX_CORRECTION_CONTEXT = 500;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('collection clock is invalid');
  date.setUTCMilliseconds(0);
  return date.toISOString().replace('.000Z', 'Z');
}

function addCalendarMonths(iso, count) {
  const date = new Date(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function objectiveSourceId(repoOwner, repoName) {
  return `objective:${repoOwner}/${repoName}`;
}

function writeAudit(db, { eventAt, sourceId = null, sourceKind, operation, status, repoOwner = null, repoName = null, recordCount = 0 }) {
  db.prepare(`INSERT INTO code_health_audit
    (event_at, source_id, source_kind, operation, status, repo_owner, repo_name, record_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventAt, sourceId, sourceKind, operation, status, repoOwner, repoName, recordCount);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function instantOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

// Admitted run rows outlive the 30-day listing window by months, so pruning
// cannot make an in-window run look unhandled.
function upsertAdmittedRun(db, owner, name, provenance, now) {
  db.prepare(`INSERT INTO code_health_objective_runs (
      repo_owner, repo_name, run_id, attempt, outcome, reason_code, artifact_id,
      run_created_at, first_handled_at, last_handled_at, expires_at
    ) VALUES (?, ?, ?, ?, 'admitted', NULL, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_owner, repo_name, run_id, attempt) DO UPDATE SET
      outcome = 'admitted', reason_code = NULL,
      artifact_id = COALESCE(excluded.artifact_id, code_health_objective_runs.artifact_id),
      run_created_at = COALESCE(excluded.run_created_at, code_health_objective_runs.run_created_at),
      last_handled_at = excluded.last_handled_at, expires_at = excluded.expires_at`)
    .run(owner, name, provenance.runId, provenance.attempt, positiveId(provenance.artifactId),
      instantOrNull(provenance.runCreatedAt), now, now, addCalendarMonths(now, OBJECTIVE_RETENTION_MONTHS));
}

/**
 * Record a rejected run attempt. It stays unsettled (retried every cycle), and
 * an attempt that was already admitted is never downgraded. The row lives only
 * `REJECTED_RUN_RETENTION_MS` past its latest retry, so the rejected rows on
 * record are the ones the collector is still retrying.
 */
function recordRejectedRun(db, { repoOwner, repoName, runId, attempt, reasonCode, artifactId = null, runCreatedAt = null }, nowValue = new Date()) {
  if (!REJECTION_REASONS.includes(reasonCode)) throw new TypeError('rejection reason is not in the bounded set');
  if (positiveId(runId) == null || positiveId(attempt) == null) return false;
  const now = isoNow(nowValue);
  return db.prepare(`INSERT INTO code_health_objective_runs (
      repo_owner, repo_name, run_id, attempt, outcome, reason_code, artifact_id,
      run_created_at, first_handled_at, last_handled_at, expires_at
    ) VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_owner, repo_name, run_id, attempt) DO UPDATE SET
      reason_code = excluded.reason_code,
      artifact_id = COALESCE(excluded.artifact_id, code_health_objective_runs.artifact_id),
      run_created_at = COALESCE(excluded.run_created_at, code_health_objective_runs.run_created_at),
      last_handled_at = excluded.last_handled_at, expires_at = excluded.expires_at
    WHERE code_health_objective_runs.outcome = 'rejected'`)
    .run(repoOwner, repoName, runId, attempt, reasonCode, positiveId(artifactId), instantOrNull(runCreatedAt),
      now, now, isoNow(new Date(Date.parse(now) + REJECTED_RUN_RETENTION_MS))).changes > 0;
}

/** A run attempt is settled once its artifact was admitted (replays included). */
function isRunSettled(db, repoOwner, repoName, runId, attempt) {
  if (positiveId(runId) == null || positiveId(attempt) == null) return false;
  return !!db.prepare(`SELECT 1 FROM code_health_objective_runs
    WHERE repo_owner = ? AND repo_name = ? AND run_id = ? AND attempt = ? AND outcome = 'admitted'`)
    .get(repoOwner, repoName, runId, attempt);
}

/**
 * The creation time of the newest tracked admitted run of a repository, or
 * null. Only run rows count; snapshot collection times are this collector's
 * clock and never stand in for a run creation time here. Ordered as instants,
 * so mixed fractional-second precision cannot win by string order.
 */
function newestAdmittedRunCreatedAt(db, repoOwner, repoName) {
  return db.prepare(`SELECT run_created_at AS at FROM code_health_objective_runs
    WHERE repo_owner = ? AND repo_name = ? AND outcome = 'admitted' AND run_created_at IS NOT NULL
    ORDER BY julianday(run_created_at) DESC, run_created_at DESC LIMIT 1`)
    .get(repoOwner, repoName)?.at ?? null;
}

/**
 * A rejection is superseded when the rejected run was created strictly before
 * the newest tracked admitted run. It fails closed: an unknown or invalid
 * creation time on either side, or an equal or later one, is not superseded.
 */
function isRejectionSuperseded(rejectedRunCreatedAt, newestAdmittedCreatedAt) {
  if (instantOrNull(rejectedRunCreatedAt) == null || instantOrNull(newestAdmittedCreatedAt) == null) return false;
  return Date.parse(rejectedRunCreatedAt) < Date.parse(newestAdmittedCreatedAt);
}

/**
 * The newest known admission time for a repository: the later of
 *
 * - the creation time of the newest admitted run, and
 * - the latest collection time among snapshots whose run has no such row
 *   (snapshots stored before run bookkeeping existed).
 *
 * A snapshot's collection time is this collector's clock, which is never
 * earlier than the run it came from, so the second term cannot make a source
 * look staler than it is. It is used only for untracked runs because a tracked
 * old run that was collected late must not look fresh. Every admission since
 * run bookkeeping writes the run row in the same transaction, so that term
 * stops growing at the upgrade. Returns null when nothing is known.
 */
function lastAdmittedRunAt(db, repoOwner, repoName) {
  const tracked = newestAdmittedRunCreatedAt(db, repoOwner, repoName);
  const untracked = db.prepare(`SELECT MAX(s.collected_at) AS at FROM code_health_objective_snapshots s
    WHERE s.repo_owner = ? AND s.repo_name = ? AND NOT EXISTS (
      SELECT 1 FROM code_health_objective_runs r
      WHERE r.repo_owner = s.repo_owner AND r.repo_name = s.repo_name
        AND r.run_id = s.source_run_id AND r.attempt = s.source_attempt
        AND r.outcome = 'admitted' AND r.run_created_at IS NOT NULL)`)
    .get(repoOwner, repoName)?.at ?? null;
  if (tracked == null || untracked == null) return tracked ?? untracked;
  return Date.parse(untracked) > Date.parse(tracked) ? untracked : tracked;
}

function recordReferences(record) {
  const values = [record.source_observation_ref, record.supersedes_record_id];
  if (Array.isArray(record.observation_refs)) values.push(...record.observation_refs);
  return [...new Set(values.filter((value) => typeof value === 'string'))];
}

function objectiveRowsById(db, owner, name, now, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT snapshot_id, payload_json, expires_at
    FROM code_health_objective_snapshots
    WHERE repo_owner = ? AND repo_name = ? AND expires_at > ?
      AND snapshot_id IN (${ids.map(() => '?').join(',')})`)
    .all(owner, name, now, ...ids);
}

function loadCorrectionContext(db, owner, name, now, incoming) {
  const incomingById = new Map(incoming.map((snapshot) => [snapshot.snapshot_id, snapshot]));
  const queued = incoming.map((snapshot) => snapshot.supersedes_ref).filter(Boolean);
  const seen = new Set();
  const context = [];
  while (queued.length > 0) {
    const batch = [...new Set(queued.splice(0))].filter((id) => !seen.has(id));
    if (batch.length === 0) continue;
    for (const id of batch) seen.add(id);
    if (seen.size > MAX_CORRECTION_CONTEXT) throw new Error('objective correction context exceeds its bound');
    const databaseIds = batch.filter((id) => !incomingById.has(id));
    const rows = objectiveRowsById(db, owner, name, now, databaseIds);
    const byId = new Map(rows.map((row) => [row.snapshot_id, JSON.parse(row.payload_json)]));
    for (const id of batch) {
      const parent = incomingById.get(id) ?? byId.get(id);
      if (!parent) throw new Error('objective correction target is not retained in this source repository');
      if (!incomingById.has(id)) context.push(parent);
      if (parent.supersedes_ref) queued.push(parent.supersedes_ref);
    }
  }
  return context;
}

async function admitObjectiveArtifact(db, parsed, provenance, nowValue = new Date()) {
  const now = isoNow(nowValue);
  const collectedAt = now;
  const expiresAt = addCalendarMonths(collectedAt, OBJECTIVE_RETENTION_MONTHS);
  const { repository, snapshots } = parsed;
  const owner = repository.owner;
  const name = repository.name;
  const incoming = [];
  const replayed = [];
  const select = db.prepare(`SELECT payload_sha256 FROM code_health_objective_snapshots WHERE snapshot_id = ?`);
  for (const snapshot of snapshots) {
    const serialized = canonical(snapshot);
    const digest = sha256(serialized);
    const prior = select.get(snapshot.snapshot_id);
    if (prior) {
      if (prior.payload_sha256 !== digest) throw new Error('objective snapshot ID collision');
      replayed.push(snapshot);
    } else incoming.push({ snapshot, serialized, digest });
  }

  const contract = await loadContract();
  const correctionContext = loadCorrectionContext(db, owner, name, now, incoming.map((entry) => entry.snapshot));
  const validation = contract.validateObjectiveSeries(
    contract.objectiveSchema,
    incoming.map((entry) => entry.snapshot),
    { context: correctionContext },
  );
  if (!validation.valid) throw new Error('objective series failed frozen correction validation');
  const registered = EXPECTED_SLOTS.get(name).slots;
  const reported = new Set(snapshots.flatMap((snapshot) => Object.values(snapshot.metrics).map((metric) => metric.slot_ref)));
  const omitted = registered.filter((slot) => !reported.has(slot.slot_ref));
  const artifactSha = parsed.archive.sha256;
  const runCreatedAt = isoNow(provenance.artifactCreatedAt);
  const insertSnapshot = db.prepare(`INSERT INTO code_health_objective_snapshots (
    snapshot_id, repo_owner, repo_name, commit_sha, observed_at, collected_at, expires_at,
    source_run_id, source_attempt, artifact_sha256, payload_sha256, payload_json,
    supersedes_ref, correction_ref
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertGap = db.prepare(`INSERT OR IGNORE INTO code_health_objective_gaps (
    repo_owner, repo_name, source_run_id, source_attempt, slot_ref,
    gap_at, collected_at, expires_at, reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'missing-expected-slot')`);
  const transaction = db.transaction(() => {
    for (const { snapshot, serialized, digest } of incoming) {
      insertSnapshot.run(snapshot.snapshot_id, owner, name, snapshot.commit, snapshot.observed_at, collectedAt, expiresAt,
        provenance.runId, provenance.attempt, artifactSha, digest, serialized, snapshot.supersedes_ref, snapshot.correction_ref);
    }
    for (const slot of omitted) {
      insertGap.run(owner, name, provenance.runId, provenance.attempt, slot.slot_ref, runCreatedAt, collectedAt, expiresAt);
    }
    // Settle the run attempt atomically with its admission, replays included.
    upsertAdmittedRun(db, owner, name, provenance, collectedAt);
    // A replay-only admission stores nothing new and writes no audit row; the
    // collector records one cycle-level status per source instead.
    if (incoming.length > 0) {
      writeAudit(db, { eventAt: collectedAt, sourceId: objectiveSourceId(owner, name), sourceKind: 'objective', operation: 'admit', status: 'committed',
        repoOwner: owner, repoName: name, recordCount: incoming.length });
    }
  });
  transaction();
  return { status: 'committed', admitted: incoming.length, replayed: replayed.length, unknownSlots: omitted.length };
}

function pruneExpiredEvidence(db, nowValue = new Date()) {
  const now = isoNow(nowValue);
  const transaction = db.transaction(() => {
    const objective = db.prepare('DELETE FROM code_health_objective_snapshots WHERE expires_at <= ?').run(now).changes;
    const gaps = db.prepare('DELETE FROM code_health_objective_gaps WHERE expires_at <= ?').run(now).changes;
    const runs = db.prepare('DELETE FROM code_health_objective_runs WHERE expires_at <= ?').run(now).changes;
    let subjective = db.prepare('DELETE FROM code_health_subjective_records WHERE expires_at <= ?').run(now).changes;
    const sources = db.prepare('SELECT DISTINCT source_id FROM code_health_subjective_records').all();
    const remove = db.prepare('DELETE FROM code_health_subjective_records WHERE source_id = ? AND record_id = ?');
    for (const { source_id: sourceId } of sources) {
      let changed = true;
      while (changed) {
        changed = false;
        const rows = db.prepare(`SELECT record_id, record_role, payload_json FROM code_health_subjective_records
          WHERE source_id = ?`).all(sourceId).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
        const byId = new Map(rows.map((row) => [row.record_id, row]));
        for (const row of rows) {
          if (recordReferences(row.payload).some((reference) => !byId.has(reference))) {
            subjective += remove.run(sourceId, row.record_id).changes;
            changed = true;
          }
        }
      }
      const rows = db.prepare(`SELECT record_id, record_role, payload_json FROM code_health_subjective_records
        WHERE source_id = ?`).all(sourceId).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
      const byId = new Map(rows.map((row) => [row.record_id, row]));
      const required = new Set();
      const queue = rows.filter((row) => row.record_role === 'record').flatMap((row) => recordReferences(row.payload));
      while (queue.length) {
        const recordId = queue.shift();
        if (required.has(recordId)) continue;
        const row = byId.get(recordId);
        if (!row) continue;
        required.add(recordId);
        queue.push(...recordReferences(row.payload));
      }
      for (const row of rows) {
        if (row.record_role === 'context' && !required.has(row.record_id)) {
          subjective += remove.run(sourceId, row.record_id).changes;
        }
      }
    }
    if (objective + gaps + runs + subjective > 0) {
      writeAudit(db, { eventAt: now, sourceKind: 'retention', operation: 'expire', status: 'committed',
        recordCount: objective + gaps + runs + subjective });
    }
    return { objective, gaps, runs, subjective };
  });
  return transaction();
}

function currentStatus(contract, schema, snapshot, metricName, asOf) {
  return contract.currentMetricStatus(schema, snapshot, metricName, asOf);
}

async function getObjectiveHistory(db, {
  repoOwner,
  repoName,
  days = 90,
  asOf: asOfValue = new Date(),
} = {}) {
  if (!ALLOWED_WINDOWS.has(days)) throw new TypeError('history window must be 30, 90, or 365 days');
  const expected = EXPECTED_SLOTS.get(repoName);
  if (!expected || expected.source.owner !== repoOwner) throw new TypeError('repository is not in the registered code-health sources');
  const asOf = isoNow(asOfValue);
  const since = new Date(Date.parse(asOf) - days * 86400000).toISOString();
  const records = db.prepare(`SELECT snapshot_id, observed_at, collected_at, expires_at, source_run_id, source_attempt, payload_json
    FROM code_health_objective_snapshots
    WHERE repo_owner = ? AND repo_name = ? AND expires_at > ? AND observed_at >= ?
    ORDER BY observed_at ASC, collected_at ASC, source_run_id ASC, snapshot_id ASC`).all(repoOwner, repoName, asOf, since);
  const gaps = db.prepare(`SELECT source_run_id, source_attempt, slot_ref, gap_at, collected_at, expires_at, reason
    FROM code_health_objective_gaps
    WHERE repo_owner = ? AND repo_name = ? AND expires_at > ? AND gap_at >= ?
    ORDER BY gap_at ASC, collected_at ASC, source_run_id ASC, slot_ref ASC`).all(repoOwner, repoName, asOf, since);
  const snapshots = records.map((row) => ({ row, snapshot: JSON.parse(row.payload_json) }));
  const superseded = new Set(snapshots.map(({ snapshot }) => snapshot.supersedes_ref).filter(Boolean));
  const contract = await loadContract();
  const bySlot = new Map(expected.slots.map((slot) => [slot.slot_ref, []]));
  for (const { row, snapshot } of snapshots) {
    for (const [metricName, metric] of Object.entries(snapshot.metrics)) {
      const points = bySlot.get(metric.slot_ref);
      if (!points) continue;
      points.push({
        kind: 'snapshot',
        snapshot_id: snapshot.snapshot_id,
        supersedes_ref: snapshot.supersedes_ref,
        correction_ref: snapshot.correction_ref,
        observed_at: metric.observed_at,
        collected_at: row.collected_at,
        source_run_id: row.source_run_id,
        source_attempt: row.source_attempt,
        commit: snapshot.commit,
        metric: metricName,
        status: metric.status,
        current_status: currentStatus(contract, contract.objectiveSchema, snapshot, metricName, asOf),
        unit: metric.unit,
        language: metric.source?.language ?? null,
        platform: metric.source?.platform ?? null,
        feature_refs: metric.source?.feature_refs ?? [],
        tool: metric.source?.tool ? { name: metric.source.tool.name, version: metric.source.tool.version } : null,
        config_digest: metric.source?.config_digest?.value ?? null,
        scope_digest: metric.source?.scope_digest?.value ?? null,
        metric_version: metric.source?.metric_version ?? null,
        scope_version: metric.source?.scope_version ?? null,
        series_key: metric.status === 'measured' ? contract.seriesKey(contract.objectiveSchema, snapshot, metricName) : null,
        payload: metric.payload,
        reason: metric.reason,
        prior_snapshot_ref: metric.prior_snapshot_ref ?? null,
        superseded: superseded.has(snapshot.snapshot_id),
      });
    }
  }
  for (const gap of gaps) {
    const points = bySlot.get(gap.slot_ref);
    if (points) points.push({
      kind: 'gap',
      observed_at: gap.gap_at,
      collected_at: gap.collected_at,
      source_run_id: gap.source_run_id,
      source_attempt: gap.source_attempt,
      status: 'unknown',
      current_status: 'unknown',
      reason: gap.reason,
      series_key: null,
      payload: null,
    });
  }
  const slots = expected.slots.map((registeredSlot) => {
    const allPoints = bySlot.get(registeredSlot.slot_ref);
    allPoints.sort((a, b) => a.observed_at.localeCompare(b.observed_at)
      || a.collected_at.localeCompare(b.collected_at)
      || a.source_run_id - b.source_run_id);
    const currentCandidates = allPoints.filter((point) => point.kind === 'gap' || !point.superseded);
    // Full-scope producers may emit a static not-collected snapshot for metrics
    // outside the current run. Keep it in history, but do not let it hide a
    // substantive point; gaps and every other status remain authoritative.
    const substantiveCandidates = currentCandidates.filter((point) => !(point.kind === 'snapshot'
      && point.status === 'unknown' && point.reason === 'not-collected'));
    const latestPool = substantiveCandidates.length ? substantiveCandidates : currentCandidates;
    const latestEventAt = latestPool.length ? latestPool[latestPool.length - 1].observed_at : null;
    const latestCandidates = latestEventAt == null ? [] : latestPool.filter((point) => point.observed_at === latestEventAt);
    let latest;
    if (latestCandidates.length === 0) latest = { status: 'unknown', current_status: 'unknown', reason: 'no-retained-sample', series_key: null, payload: null };
    else if (latestCandidates.length > 1) latest = { status: 'unknown', current_status: 'unknown', reason: 'conflicting-samples-at-same-time', series_key: null, payload: null };
    else latest = latestCandidates[0];
    return { ...registeredSlot, latest, points: allPoints };
  });
  return { repo_owner: repoOwner, repo_name: repoName, window_days: days, since, as_of: asOf, retention_months: 6, slots };
}

function readObjectiveSourceState(db, { repoOwner, repoName, enabled = false, configured = false } = {}) {
  const expected = EXPECTED_SLOTS.get(repoName);
  if (!expected || expected.source.owner !== repoOwner) throw new TypeError('repository is not in the registered code-health sources');
  const sourceId = objectiveSourceId(repoOwner, repoName);
  const lastAttempt = db.prepare(`SELECT event_at, status FROM code_health_audit
    WHERE source_id = ? AND source_kind = 'objective' AND operation = 'admit'
    ORDER BY id DESC LIMIT 1`).get(sourceId) ?? null;
  const lastSuccess = db.prepare(`SELECT MAX(collected_at) AS collected_at
    FROM code_health_objective_snapshots WHERE repo_owner = ? AND repo_name = ?`).get(repoOwner, repoName)?.collected_at ?? null;
  const rejection = db.prepare(`SELECT last_handled_at, reason_code FROM code_health_objective_runs
    WHERE repo_owner = ? AND repo_name = ? AND outcome = 'rejected'
    ORDER BY last_handled_at DESC, run_id DESC, attempt DESC LIMIT 1`).get(repoOwner, repoName) ?? null;
  // Rejected rows live 24 hours past their latest retry, so this set stays
  // bounded by the listing window.
  const rejectedCreatedAt = db.prepare(`SELECT run_created_at FROM code_health_objective_runs
    WHERE repo_owner = ? AND repo_name = ? AND outcome = 'rejected'`).all(repoOwner, repoName);
  const rejectedRuns = rejectedCreatedAt.length;
  const newestAdmitted = newestAdmittedRunCreatedAt(db, repoOwner, repoName);
  const supersededRejectedRuns = rejectedCreatedAt
    .filter((row) => isRejectionSuperseded(row.run_created_at, newestAdmitted)).length;
  const status = enabled !== true ? 'disabled'
    : configured !== true ? 'unconfigured'
      : lastAttempt?.status ?? 'not-collected';
  const errorCodes = {
    rejected: 'objective-report-rejected',
    unavailable: 'source-unavailable',
    unconfigured: 'authenticated-transport-not-configured',
    incomplete: 'source-collection-incomplete',
  };
  return {
    source_id: sourceId,
    status,
    last_attempt_at: lastAttempt?.event_at ?? null,
    last_attempt_status: lastAttempt?.status ?? null,
    last_success_at: lastSuccess,
    last_error_code: errorCodes[lastAttempt?.status] ?? null,
    last_rejection_at: rejection?.last_handled_at ?? null,
    last_rejection_code: REJECTION_REASONS.includes(rejection?.reason_code) ? rejection.reason_code : null,
    rejected_runs: rejectedRuns,
    superseded_rejected_runs: supersededRejectedRuns,
    last_admitted_run_at: lastAdmittedRunAt(db, repoOwner, repoName),
  };
}

module.exports = {
  OBJECTIVE_RETENTION_MONTHS,
  REJECTED_RUN_RETENTION_MS,
  addCalendarMonths,
  writeAudit,
  admitObjectiveArtifact,
  pruneExpiredEvidence,
  getObjectiveHistory,
  objectiveSourceId,
  readObjectiveSourceState,
  recordRejectedRun,
  isRunSettled,
  lastAdmittedRunAt,
  newestAdmittedRunCreatedAt,
  isRejectionSuperseded,
  isoNow,
};
