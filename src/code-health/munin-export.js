'use strict';

const crypto = require('node:crypto');
const { loadApiKey } = require('../munin-projects');
const { muninRpc } = require('../munin-rpc');
const { EXPECTED_SLOTS } = require('./registry');
const { loadContract } = require('./contract');
const { writeAudit, isoNow, addCalendarMonths, pruneExpiredEvidence } = require('./store');

const DEFAULT_SUBJECTIVE_SOURCE_CONFIG = Object.freeze({ enabled: false });
const MAX_EXPORT_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_UNIQUE_RECORDS = 10000;
const MAX_CONTEXT_RECORDS = 500;
const CLASSIFICATIONS = new Set(['public', 'internal', 'client-confidential', 'client-restricted']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unwrapPage(result) {
  if (!result || result.isError) throw new Error('export unavailable');
  if (isRecord(result) && result.ok !== undefined) return result;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('export page has no JSON payload');
  try { return JSON.parse(text); } catch { throw new Error('export page JSON is malformed'); }
}

function validateSourceConfig(config) {
  if (!config || typeof config !== 'object' || config.enabled !== true
    || typeof config.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,159}$/.test(config.namespace)
    || config.namespace.endsWith('/') || config.namespace.split('/').some((part) => !part || part === '.' || part === '..')
    || typeof config.producerPrincipalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(config.producerPrincipalId)
    || typeof config.repoOwner !== 'string' || typeof config.repoName !== 'string'
    || !EXPECTED_SLOTS.has(config.repoName) || EXPECTED_SLOTS.get(config.repoName).source.owner !== config.repoOwner
    || config.rubricVersion !== 'changeability-1.0') {
    throw new Error('subjective source configuration is incomplete or outside the pinned source scope');
  }
}

function rpcArgs(config, cursor) {
  return {
    action: 'export',
    namespace: config.namespace,
    producer_principal_id: config.producerPrincipalId,
    repo_owner: config.repoOwner,
    repo_name: config.repoName,
    rubric_version: config.rubricVersion,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  };
}

function expectedFilterHash(config) {
  return sha256(canonical({
    namespace: config.namespace,
    producer: config.producerPrincipalId,
    filters: {
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      task_id: null,
      since: null,
      until: null,
      model: null,
      rubric_version: config.rubricVersion,
    },
  }));
}

async function callExport(config, cursor, rpcFn) {
  const args = rpcArgs(config, cursor);
  let result;
  if (typeof rpcFn === 'function') result = await rpcFn('memory_code_health', args);
  else {
    const apiKey = loadApiKey();
    if (!apiKey) return null;
    result = await muninRpc('memory_code_health', args, { apiKey, timeoutMs: 10000 });
  }
  return unwrapPage(result);
}

function validateRetentionPage(page, pageRecords) {
  if (!Array.isArray(page.retention)) throw new Error('export retention metadata is missing');
  const expectedIds = new Set(pageRecords.map((record) => record.record_id));
  const seen = new Set();
  for (const item of page.retention) {
    if (!isRecord(item) || typeof item.record_id !== 'string' || !expectedIds.has(item.record_id) || seen.has(item.record_id)
      || !isInstant(item.collected_at) || !isInstant(item.expires_at) || !isInstant(item.updated_at)
      || Date.parse(item.expires_at) <= Date.parse(item.collected_at) || !CLASSIFICATIONS.has(item.classification)) {
      throw new Error('export retention metadata is invalid or duplicated');
    }
    const maximumExpiry = Date.parse(addCalendarMonths(item.collected_at, 6));
    if (Date.parse(item.expires_at) > maximumExpiry) throw new Error('export record retention exceeds the six-month maximum');
    seen.add(item.record_id);
  }
  if (seen.size !== expectedIds.size) throw new Error('export retention metadata does not cover its records and context');
  return new Map(page.retention.map((item) => [item.record_id, item]));
}

function validatePageScope(page, config) {
  if (!isRecord(page) || page.ok !== true || page.action !== 'code_health'
    || !isRecord(page.export_scope) || page.export_scope.namespace !== config.namespace
    || page.export_scope.producer_principal_id !== config.producerPrincipalId
    || page.export_scope.filter_hash !== expectedFilterHash(config)
    || !isInstant(page.generated_at) || page.watermark !== page.generated_at || !isInstant(page.expires_at)
    || !Number.isSafeInteger(page.total_records) || page.total_records < 0 || page.total_records > MAX_UNIQUE_RECORDS
    || !Array.isArray(page.records) || page.records.length > PAGE_SIZE
    || !Array.isArray(page.context_records) || page.context_records.length > MAX_CONTEXT_RECORDS
    || Date.parse(page.expires_at) <= Date.parse(page.generated_at)
    || typeof page.complete !== 'boolean') throw new Error('export page is outside the bounded authenticated contract');
  return {
    generatedAt: page.generated_at,
    watermark: page.watermark,
    expiresAt: page.expires_at,
    totalRecords: page.total_records,
    exportScope: canonical(page.export_scope),
  };
}

function sourceIdentity(config) {
  return sha256(canonical({ namespace: config?.namespace, producer: config?.producerPrincipalId,
    repoOwner: config?.repoOwner, repoName: config?.repoName, rubricVersion: config?.rubricVersion }));
}

function subjectiveReferences(record) {
  const values = [record.source_observation_ref, record.supersedes_record_id];
  if (Array.isArray(record.observation_refs)) values.push(...record.observation_refs);
  return [...new Set(values.filter((value) => typeof value === 'string'))];
}

function filterRetainedRows(rows) {
  const retained = new Map(rows.map((row) => [JSON.parse(row.payload_json).record_id, {
    ...row,
    record: JSON.parse(row.payload_json),
  }]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [recordId, row] of retained) {
      if (subjectiveReferences(row.record).some((reference) => !retained.has(reference))) {
        retained.delete(recordId);
        changed = true;
      }
    }
  }
  const primary = [...retained.values()].filter((row) => row.record_role === 'record');
  const neededContext = new Set();
  const queue = primary.flatMap((row) => subjectiveReferences(row.record));
  while (queue.length > 0) {
    const recordId = queue.shift();
    if (neededContext.has(recordId)) continue;
    const row = retained.get(recordId);
    if (!row) continue;
    neededContext.add(recordId);
    queue.push(...subjectiveReferences(row.record));
  }
  return [
    ...primary,
    ...[...retained.values()].filter((row) => row.record_role === 'context' && neededContext.has(row.record.record_id)),
  ];
}

function readExistingSource(db, sourceId) {
  const rows = db.prepare(`SELECT record_id, collected_at, expires_at, updated_at, classification,
      payload_sha256, payload_json
    FROM code_health_subjective_records WHERE source_id = ?`).all(sourceId);
  return new Map(rows.map((row) => [row.record_id, row]));
}

async function fetchCompleteExport(config, rpcFn) {
  const contract = await loadContract();
  const records = new Map();
  const contextRecords = new Map();
  const retention = new Map();
  const seenCursors = new Set();
  let cursor;
  let stable;
  let finalPage = null;
  for (let pageNumber = 0; pageNumber < MAX_EXPORT_PAGES; pageNumber += 1) {
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error('export cursor repeated');
      seenCursors.add(cursor);
    }
    const page = await callExport(config, cursor, rpcFn);
    if (page === null) throw new Error('export unavailable');
    const pageIdentity = validatePageScope(page, config);
    if (!stable) stable = pageIdentity;
    else if (stable.generatedAt !== pageIdentity.generatedAt || stable.watermark !== pageIdentity.watermark
      || stable.expiresAt !== pageIdentity.expiresAt || stable.totalRecords !== pageIdentity.totalRecords
      || stable.exportScope !== pageIdentity.exportScope) throw new Error('export page watermark or scope changed');

    const pageUnion = new Map();
    const pageRecordIds = new Set();
    const pageContextIds = new Set();
    for (const record of page.records) {
      contract.validateRecord(record);
      if (record.repo_owner !== config.repoOwner || record.repo_name !== config.repoName || record.rubric_version !== config.rubricVersion) {
        throw new Error('export record escaped the configured repository or rubric scope');
      }
      if (pageRecordIds.has(record.record_id) || records.has(record.record_id)) throw new Error('export repeated a record across pages');
      pageRecordIds.add(record.record_id);
      pageUnion.set(record.record_id, record);
      records.set(record.record_id, record);
    }
    for (const record of page.context_records) {
      contract.validateRecord(record);
      if (pageContextIds.has(record.record_id)) throw new Error('export repeated a context record within one page');
      pageContextIds.add(record.record_id);
      if (record.repo_owner !== config.repoOwner || record.repo_name !== config.repoName || record.rubric_version !== config.rubricVersion) {
        throw new Error('export context escaped the configured repository or rubric scope');
      }
      const current = contextRecords.get(record.record_id) ?? records.get(record.record_id);
      if (current && canonical(current) !== canonical(record)) throw new Error('export context reuses a record ID with different content');
      if (!records.has(record.record_id)) contextRecords.set(record.record_id, record);
      pageUnion.set(record.record_id, record);
    }
    const pageRetention = validateRetentionPage(page, [...pageUnion.values()]);
    for (const [recordId, metadata] of pageRetention) {
      const previous = retention.get(recordId);
      if (previous && canonical(previous) !== canonical(metadata)) throw new Error('export retention metadata changed across pages');
      retention.set(recordId, metadata);
    }
    if (contextRecords.size > MAX_CONTEXT_RECORDS || records.size + contextRecords.size > MAX_UNIQUE_RECORDS + MAX_CONTEXT_RECORDS) {
      throw new Error('export exceeds its total retained-record bound');
    }

    if (page.complete === true) {
      if (page.next_cursor !== null || page.reconciliation !== 'complete-authorized-retained-set') {
        throw new Error('final export page does not authorize complete-set reconciliation');
      }
      finalPage = page;
      break;
    }
    if (typeof page.next_cursor !== 'string' || page.next_cursor.length < 1 || page.next_cursor.length > 4096) {
      throw new Error('incomplete export page has no bounded continuation cursor');
    }
    if (page.reconciliation !== 'incomplete-do-not-remove-consumer-records') throw new Error('incomplete export page has an invalid reconciliation marker');
    cursor = page.next_cursor;
  }
  if (!finalPage) throw new Error('export exceeded the bounded page count without a complete page');
  if (records.size !== stable.totalRecords) throw new Error('complete export record count does not match its stable total');
  const recordsList = [...records.values()];
  const contextList = [...contextRecords.entries()].filter(([id]) => !records.has(id)).map(([, record]) => record);
  contract.validateRecords(recordsList, { contextRecords: contextList });
  const expectedRetention = new Set([...records.keys(), ...contextRecords.keys()]);
  if (retention.size !== expectedRetention.size || [...expectedRetention].some((id) => !retention.has(id))) {
    throw new Error('complete export retention metadata does not match the authorized retained set');
  }
  return { records: recordsList, contextRecords: contextList, retention, watermark: stable.watermark, totalRecords: stable.totalRecords };
}

function ensureNoLocalCollision(existing, records, retention) {
  for (const record of [...records, ...retention.contextRecords]) {
    const prior = existing.get(record.record_id);
    if (!prior) continue;
    const nextHash = sha256(canonical(record));
    const metadata = retention.metadata.get(record.record_id);
    if (prior.payload_sha256 !== nextHash || prior.collected_at !== metadata.collected_at
      || prior.expires_at !== metadata.expires_at || prior.updated_at !== metadata.updated_at
      || prior.classification !== metadata.classification) throw new Error('Munin record ID collision or immutable retention metadata changed');
  }
}

async function reconcileSubjectiveEvidence(db, config, { rpc: rpcFn, now: nowValue = new Date() } = {}) {
  const now = isoNow(nowValue);
  const expired = pruneExpiredEvidence(db, now);
  if (config?.enabled !== true) return { status: 'disabled', expired };
  const sourceId = sourceIdentity(config);
  try {
    validateSourceConfig(config);
  }
  catch { writeAudit(db, { eventAt: now, sourceId, sourceKind: 'subjective', operation: 'reconcile', status: 'rejected',
    repoOwner: config?.repoOwner ?? null, repoName: config?.repoName ?? null, recordCount: 0 });
    return { status: 'rejected', reason: 'invalid-source-configuration' }; }
  try {
    const exportSet = await fetchCompleteExport(config, rpcFn);
    const existing = readExistingSource(db, sourceId);
    const retentionBundle = { metadata: exportSet.retention, contextRecords: exportSet.contextRecords };
    ensureNoLocalCollision(existing, exportSet.records, retentionBundle);
    const retainedRows = new Map();
    const roleById = new Map();
    for (const record of exportSet.contextRecords) { retainedRows.set(record.record_id, record); roleById.set(record.record_id, 'context'); }
    for (const record of exportSet.records) { retainedRows.set(record.record_id, record); roleById.set(record.record_id, 'record'); }
    const at = isoNow(nowValue);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM code_health_subjective_records WHERE source_id = ?').run(sourceId);
      const insert = db.prepare(`INSERT INTO code_health_subjective_records (
        source_id, record_id, record_kind, record_role, repo_owner, repo_name, task_id, attempt_id,
        observed_at, collected_at, expires_at, updated_at, classification, payload_sha256, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [recordId, record] of retainedRows) {
        const metadata = exportSet.retention.get(recordId);
        insert.run(sourceId, recordId, record.record_kind, roleById.get(recordId), record.repo_owner, record.repo_name,
          record.task_id, record.attempt_id, record.observed_at, metadata.collected_at, metadata.expires_at,
          metadata.updated_at, metadata.classification, sha256(canonical(record)), canonical(record));
      }
      db.prepare(`INSERT INTO code_health_subjective_sources (
        source_id, namespace, producer_principal_id, repo_owner, repo_name, rubric_version, watermark, total_records, reconciled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        watermark = excluded.watermark, total_records = excluded.total_records, reconciled_at = excluded.reconciled_at`)
        .run(sourceId, config.namespace, config.producerPrincipalId, config.repoOwner, config.repoName,
          config.rubricVersion, exportSet.watermark, exportSet.totalRecords, at);
      writeAudit(db, { eventAt: at, sourceId, sourceKind: 'subjective', operation: 'reconcile', status: 'committed',
        repoOwner: config.repoOwner, repoName: config.repoName, recordCount: retainedRows.size });
    });
    transaction();
    return { status: 'committed', expired, records: exportSet.records.length, contextRecords: exportSet.contextRecords.length,
      watermark: exportSet.watermark, sourceId };
  } catch {
    writeAudit(db, { eventAt: isoNow(nowValue), sourceId, sourceKind: 'subjective', operation: 'reconcile', status: 'incomplete',
      repoOwner: config.repoOwner, repoName: config.repoName, recordCount: 0 });
    return { status: 'incomplete', reason: 'export-not-reconciled', expired };
  }
}

async function readSubjectiveEvidence(db, config = DEFAULT_SUBJECTIVE_SOURCE_CONFIG, { now: nowValue = new Date() } = {}) {
  let validConfig = false;
  try { validateSourceConfig({ ...config, enabled: true }); validConfig = true; } catch { /* Surface the source state without exposing config-validation text. */ }
  const sourceId = config && typeof config === 'object' && !Array.isArray(config) ? sourceIdentity(config) : null;
  const source = sourceId
    ? db.prepare('SELECT * FROM code_health_subjective_sources WHERE source_id = ?').get(sourceId) ?? null
    : null;
  const lastAttempt = sourceId
    ? db.prepare(`SELECT event_at, status FROM code_health_audit
        WHERE source_id = ? AND source_kind = 'subjective' AND operation = 'reconcile'
        ORDER BY id DESC LIMIT 1`).get(sourceId) ?? null
    : null;
  const loadedRows = sourceId && validConfig ? db.prepare(`SELECT record_id, record_role, payload_json, collected_at, expires_at, updated_at, classification
    FROM code_health_subjective_records WHERE source_id = ? AND expires_at > ?
    ORDER BY observed_at, task_id, attempt_id, record_id LIMIT ?`)
    .all(sourceId, isoNow(nowValue), MAX_UNIQUE_RECORDS + MAX_CONTEXT_RECORDS + 1) : [];
  if (loadedRows.length > MAX_UNIQUE_RECORDS + MAX_CONTEXT_RECORDS) throw new Error('stored subjective evidence exceeds the read bound');
  const rows = filterRetainedRows(loadedRows);
  const records = rows.filter((row) => row.record_role === 'record').map((row) => ({
    record: JSON.parse(row.payload_json),
    retention: { collected_at: row.collected_at, expires_at: row.expires_at, updated_at: row.updated_at, classification: row.classification },
  }));
  const contextRecords = rows.filter((row) => row.record_role === 'context').map((row) => ({
    record: JSON.parse(row.payload_json),
    retention: { collected_at: row.collected_at, expires_at: row.expires_at, updated_at: row.updated_at, classification: row.classification },
  }));
  const contract = await loadContract();
  const aggregate = contract.aggregateRecords(records.map(({ record }) => record), {
    contextRecords: contextRecords.map(({ record }) => record),
  });
  const errorCodes = {
    rejected: 'invalid-source-configuration',
    incomplete: 'export-not-reconciled',
    unavailable: 'source-unavailable',
    unconfigured: 'authenticated-transport-not-configured',
  };
  const status = !validConfig ? (config?.enabled === true ? 'rejected' : 'unconfigured')
    : config.enabled !== true ? 'disabled'
      : lastAttempt?.status ?? 'not-collected';
  return {
    source,
    records,
    contextRecords,
    aggregate,
    collection: {
      status,
      last_attempt_at: lastAttempt?.event_at ?? null,
      last_attempt_status: lastAttempt?.status ?? null,
      last_success_at: source?.reconciled_at ?? null,
      last_error_code: !validConfig ? 'invalid-source-configuration' : errorCodes[lastAttempt?.status] ?? null,
    },
  };
}

module.exports = {
  DEFAULT_SUBJECTIVE_SOURCE_CONFIG,
  PAGE_SIZE,
  MAX_EXPORT_PAGES,
  validateSourceConfig,
  expectedFilterHash,
  fetchCompleteExport,
  reconcileSubjectiveEvidence,
  readSubjectiveEvidence,
};
