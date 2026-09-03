'use strict';

const { checkFleetAuth } = require('./fleet/auth');
const { validateSupervisionAudit } = require('./systemd-supervision');
const { upsertSystemdSupervisionAudit } = require('./db');

/**
 * Authenticated, observation-only Brokkr audit ingest.
 *
 * This endpoint deliberately uses a dedicated credential and has no localhost
 * bypass. It stores only a schema-valid, content-blind v1 projection; it never
 * executes systemctl or changes unit state.
 */
function handleSystemdSupervisionIngest(db, opts = {}) {
  const auth = checkFleetAuth(
    opts.authHeader || '',
    opts.token || '',
    opts.bindHost || '127.0.0.1',
    false,
  );
  if (!auth.ok) {
    return { status: auth.code || 401, body: { error: 'systemd supervision ingest is not configured' } };
  }

  const body = opts.body;
  if (!body || body.kind !== 'systemd-supervision-audit') {
    return { status: 400, body: { error: 'invalid systemd supervision evidence kind' } };
  }
  if (typeof body.schema_version !== 'string' || !/^v[0-9]{1,3}$/.test(body.schema_version)) {
    return { status: 400, body: { error: 'invalid systemd supervision evidence version' } };
  }
  if (body.schema_version !== 'v1') {
    return { status: 422, body: { error: 'unsupported systemd supervision evidence version' } };
  }

  const checked = validateSupervisionAudit(body);
  if (!checked.ok) {
    return {
      status: 400,
      body: { error: 'invalid systemd supervision audit', reasons: checked.errors.slice(0, 20) },
    };
  }

  try {
    const now = opts.now == null ? Date.now() : opts.now;
    const stored = upsertSystemdSupervisionAudit(db, body, new Date(now).toISOString());
    if (!stored.ok) {
      return { status: 409, body: { error: 'systemd supervision replay rejected', reason: stored.code } };
    }
    return {
      status: 200,
      body: { ok: true, replay: stored.replay, observed_at: body.observed_at },
    };
  } catch (error) {
    if (opts.logger && typeof opts.logger.error === 'function') {
      opts.logger.error({ err: error }, 'systemd supervision persistence failed');
    }
    return { status: 500, body: { error: 'persist failed' } };
  }
}

module.exports = { handleSystemdSupervisionIngest };
