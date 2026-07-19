'use strict';

// Hardcoded loopback, matching the four pre-consolidation copies. Intentionally
// NOT env-overridable: every caller attaches `Authorization: Bearer <apiKey>`, so
// a redirectable endpoint would be a token-exfiltration vector (a stray MUNIN_URL
// in ~/.heimdall/env would leak the key). Munin is always local on the Pi.
const MUNIN_URL = 'http://127.0.0.1:3030/mcp';

let rpcId = 0;

/**
 * Shared Munin JSON-RPC (tools/call) helper. Returns rpc.result, or null on
 * any failure (missing key, HTTP error, RPC error, abort/network error).
 * @param {string} method  Munin tool name (e.g. 'memory_read')
 * @param {object} args    tool arguments
 * @param {object} [opts]
 * @param {string|null} [opts.apiKey]   resolved Munin API key; null/absent => return null
 * @param {number} [opts.timeoutMs=8000]
 * @param {string|null} [opts.label]    when set, emit `  ${label}: ...` console.warn
 *                                      diagnostics; when null (default) stay silent
 */
async function muninRpc(method, args, opts = {}) {
  const { apiKey = null, timeoutMs = 8000, label = null } = opts;
  const warn = label ? (msg) => console.warn(`  ${label}: ${msg}`) : () => {};

  if (!apiKey) {
    warn('no Munin API key, skipping');
    return null;
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name: method, arguments: args },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(MUNIN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      warn(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const text = await res.text();
    let lastData = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) lastData = line.slice(6);
    }
    // Parse the SSE last-`data:` line if present, else the plain JSON body.
    const rpc = JSON.parse(lastData || text);
    if (rpc.error) {
      warn(`RPC error: ${JSON.stringify(rpc.error)}`);
      return null;
    }
    return rpc.result;
  } catch (err) {
    clearTimeout(timeout);
    warn(err.message);
    return null;
  }
}

module.exports = { muninRpc, MUNIN_URL };
