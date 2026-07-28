'use strict';
const { checkFleetAuth } = require('./fleet/auth');
const { validateMaintenanceExecutionResult } = require('./maintenance-execution-result');
const { upsertMaintenanceExecutionResult, markUnsupportedMaintenanceExecutionResult } = require('./db');

// Observation-only endpoint. A missing dedicated token is a deliberate 401,
// keeping the merged code inert until a future owner deployment configures it.
function handleMaintenanceExecutionIngest(db, opts = {}) {
  // This is intentionally stricter than generic fleet telemetry: evidence
  // becomes part of an autonomy audit trail, so even localhost never bypasses
  // its dedicated token.
  const auth = checkFleetAuth(opts.authHeader || '', opts.token || '', opts.bindHost || '127.0.0.1', false);
  if (!auth.ok) return { status: auth.code || 401, body: { error: 'maintenance evidence ingest is not configured' } };
  const body = opts.body;
  if (!body || body.kind !== 'maintenance-execution-result') {
    return { status: 400, body: { error: 'invalid maintenance evidence kind' } };
  }
  if (typeof body.schema_version !== 'string' || !/^v[0-9]{1,3}$/.test(body.schema_version)) {
    return { status: 400, body: { error: 'invalid maintenance evidence version' } };
  }
  const sourceId = body.source && body.source.source_id;
  if (body.schema_version !== 'v1') {
    if (sourceId !== undefined && sourceId !== 'brokkr-maintenance') {
      return { status: 400, body: { error: 'invalid maintenance evidence source' } };
    }
    try { markUnsupportedMaintenanceExecutionResult(db, 'brokkr-maintenance', body.schema_version, new Date(opts.now == null ? Date.now() : opts.now).toISOString()); } catch { return { status: 500, body: { error: 'persist failed' } }; }
    return { status: 422, body: { error: 'unsupported maintenance evidence version' } };
  }
  if (sourceId !== 'brokkr-maintenance') return { status: 400, body: { error: 'invalid maintenance evidence source' } };
  const result = validateMaintenanceExecutionResult(body, opts.now == null ? Date.now() : opts.now);
  if (!result.ok) return { status: 400, body: { error: 'invalid maintenance execution result', reason: result.reason } };
  try {
    const stored = upsertMaintenanceExecutionResult(db, result.value, new Date(opts.now == null ? Date.now() : opts.now).toISOString());
    if (!stored.ok) return { status: 409, body: { error: 'maintenance evidence replay rejected', reason: stored.code } };
    return { status: 200, body: { ok: true, replay: stored.replay, source_id: result.value.source.source_id } };
  } catch { return { status: 500, body: { error: 'persist failed' } }; }
}
module.exports = { handleMaintenanceExecutionIngest };
