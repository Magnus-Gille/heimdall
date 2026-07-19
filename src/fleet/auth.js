'use strict';

const { timingSafeEqual } = require('node:crypto');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Fail-closed Bearer auth for the fleet ingest endpoint. A token is REQUIRED by
 * default — even on a loopback bind, because a reverse proxy, Cloudflare Tunnel,
 * or `tailscale serve` forwarding to loopback would otherwise expose an
 * unauthenticated ingest to the network. Tokenless operation is only permitted
 * when explicitly opted into via HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK=1 AND the
 * bind is loopback (local single-host dev).
 *
 * @param {string} authHeader value of the Authorization header ('' if none)
 * @param {string} token configured HEIMDALL_FLEET_TOKEN ('' = unset)
 * @param {string} bindHost the server bind host (HEIMDALL_BIND)
 * @param {boolean} allowInsecureLoopback opt-in to tokenless loopback dev
 * @returns {{ok: boolean, code?: number, error?: string}}
 */
function checkFleetAuth(authHeader, token, bindHost, allowInsecureLoopback = false) {
  if (!token) {
    if (allowInsecureLoopback && LOOPBACK_HOSTS.has(bindHost)) return { ok: true };
    return {
      ok: false,
      code: 401,
      error: 'Fleet ingest requires HEIMDALL_FLEET_TOKEN (or HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK=1 for loopback-only dev)',
    };
  }
  const provided = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : '';
  if (constantTimeEqual(provided, token)) return { ok: true };
  return { ok: false, code: 401, error: 'Unauthorized' };
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

module.exports = { checkFleetAuth, LOOPBACK_HOSTS };
