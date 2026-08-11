'use strict';

const { checkFleetAuth } = require('./auth');
const { validatePushPayload } = require('./validate');
const { recordFleetPush } = require('../db');
const { negotiationResponse } = require('./capabilities');

/**
 * Orchestrate a fleet push end-to-end (auth → validate → persist), independent
 * of the HTTP framework so it is unit-testable. Returns {status, body}.
 *
 * @param {object} db open database
 * @param {object} opts { authHeader, sourceIp, token, bindHost, body, now }
 */
function handlePush(db, opts) {
  const {
    authHeader = '', sourceIp = null, token = '', bindHost = '127.0.0.1',
    allowInsecureLoopback = false, body, now = Date.now(),
    configuredHostnames, aliases = {},
  } = opts;

  const auth = checkFleetAuth(authHeader, token, bindHost, allowInsecureLoopback);
  if (!auth.ok) return { status: auth.code || 401, body: { error: auth.error } };

  const result = validatePushPayload(body);
  if (!result.ok) return { status: 400, body: { error: 'invalid payload', details: result.errors } };

  const payload = result.value;
  const negotiation = payload.capability_contract;
  if (negotiation && negotiation.unsupportedRequired.length) {
    return {
      status: 422,
      body: {
        error: 'unsupported required capabilities',
        capability_contract: negotiationResponse(negotiation),
      },
    };
  }
  // Source IP from the connection is authoritative over any self-reported ip.
  if (sourceIp) payload.ip = sourceIp;
  // Reject a clock-skewed FUTURE ts (>2 min ahead) so a bad/malicious agent
  // clock can't pin the "latest" card values or distort charts — fall back to
  // the server-stamped received_at. (last_seen already uses received_at.)
  if (payload.ts && Date.parse(payload.ts) > now + 120000) delete payload.ts;

  const receivedAt = new Date(now).toISOString();
  try {
    recordFleetPush(db, payload, receivedAt, { configuredHostnames, aliases });
  } catch (err) {
    return { status: 500, body: { error: 'persist failed', detail: String(err && err.message || err) } };
  }
  return {
    status: 200,
    body: { ok: true, hostname: payload.hostname, received_at: receivedAt, capability_contract: negotiationResponse(negotiation) },
  };
}

module.exports = { handlePush };
