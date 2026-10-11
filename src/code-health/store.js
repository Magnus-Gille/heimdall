'use strict';

const crypto = require('node:crypto');
const { loadContract } = require('./contract');
const { EXPECTED_SLOTS } = require('./registry');
const { canonical } = require('./artifact');

const OBJECTIVE_RETENTION_MONTHS = 6;
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
    writeAudit(db, { eventAt: collectedAt, sourceId: objectiveSourceId(owner, name), sourceKind: 'objective', operation: 'admit', status: 'committed',
      repoOwner: owner, repoName: name, recordCount: incoming.length });
  });
  transaction();
  return { status: 'committed', admitted: incoming.length, replayed: replayed.length, unknownSlots: omitted.length };
}

function pruneExpiredEvidence(db, nowValue = new Date()) {
  const now = isoNow(nowValue);
  const transaction = db.transaction(() => {
    const objective = db.prepare('DELETE FROM code_health_objective_snapshots WHERE expires_at <= ?').run(now).changes;
    const gaps = db.prepare('DELETE FROM code_health_objective_gaps WHERE expires_at <= ?').run(now).changes;
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
    if (objective + gaps + subjective > 0) {
      writeAudit(db, { eventAt: now, sourceKind: 'retention', operation: 'expire', status: 'committed',
        recordCount: objective + gaps + subjective });
    }
    return { objective, gaps, subjective };
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
  };
}

module.exports = {
  OBJECTIVE_RETENTION_MONTHS,
  addCalendarMonths,
  writeAudit,
  admitObjectiveArtifact,
  pruneExpiredEvidence,
  getObjectiveHistory,
  objectiveSourceId,
  readObjectiveSourceState,
  isoNow,
};
