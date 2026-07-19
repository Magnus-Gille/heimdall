'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCP_URL = 'http://127.0.0.1:3030/mcp';
const TIMEOUT_MS = 5000;

function loadApiKey() {
  if (process.env.MUNIN_API_KEY) return process.env.MUNIN_API_KEY;
  // Fallback: read from Munin's env file (collector may not have the env var set)
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'munin-memory', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  return null;
}

/**
 * Probe the Munin MCP HTTP transport with an initialize request.
 * Returns { healthy: boolean, latency_ms: number, error: string|null }
 */
function probeMcp() {
  const apiKey = loadApiKey();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'heimdall-probe', version: '1.0.0' },
    },
  });

  return new Promise((resolve) => {
    const start = Date.now();

    const req = http.request(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latency_ms = Date.now() - start;
        if (res.statusCode !== 200) {
          resolve({ healthy: false, latency_ms, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
          return;
        }
        // Response is SSE format: "event: message\ndata: {...}\n\n"
        try {
          let jsonStr = data;
          const dataMatch = data.match(/^data:\s*(.+)$/m);
          if (dataMatch) jsonStr = dataMatch[1];
          const parsed = JSON.parse(jsonStr);
          if (parsed.result && parsed.result.serverInfo) {
            resolve({ healthy: true, latency_ms, error: null });
          } else if (parsed.error) {
            resolve({ healthy: false, latency_ms, error: `JSON-RPC error: ${parsed.error.message || JSON.stringify(parsed.error)}` });
          } else {
            resolve({ healthy: false, latency_ms, error: 'Unexpected response format' });
          }
        } catch (parseErr) {
          resolve({ healthy: false, latency_ms, error: `Parse error: ${parseErr.message}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ healthy: false, latency_ms: Date.now() - start, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, latency_ms: TIMEOUT_MS, error: 'Timeout' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Run MCP probe, store metrics, and manage alerts.
 *
 * The failure streak is derived from the DB (the last two `mcp_healthy` rows), NOT
 * module memory: Heimdall's collector runs as a per-cycle systemd oneshot, so a
 * module-level counter resets every cycle and would never reach 2 (issue #26). This
 * mirrors `collectInferenceHealth` in src/inference.js.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string} timestamp - ISO timestamp; MUST differ per cycle (metrics are unique per host+metric+timestamp)
 */
async function collectMcpHealth(db, timestamp) {
  const { insertMetrics } = require('./db');

  const result = await probeMcp();

  // Store metrics. Alerting is no longer done here — the generic alert engine
  // (src/alert-engine.js, collector §9b) evaluates the declared `mcp_healthy`
  // rule on the `munin-mcp` descriptor (see mcpSnapshot) against these metrics.
  insertMetrics(db, [
    { timestamp, host: 'control-node', metric: 'mcp_healthy', value: result.healthy ? 1 : 0, unit: 'boolean', metadata: null },
    { timestamp, host: 'control-node', metric: 'mcp_latency_ms', value: result.latency_ms, unit: 'ms', metadata: null },
    { timestamp, host: 'control-node', metric: 'mcp_error', value: null, unit: 'text', metadata: result.error ? { error: result.error } : null },
  ]);

  return result;
}

const { SCHEMA_ID } = require('./contract/schema');

/**
 * Heimdall-built descriptor for the Munin MCP transport (the gateway doesn't
 * self-describe). Carries the declarative alert rule the generic engine evaluates
 * — replacing the old hardcoded streak logic that lived in collectMcpHealth.
 */
function buildMcpDescriptor(opts = {}) {
  return {
    _schema: SCHEMA_ID,
    service: { name: 'munin-mcp', label: 'Munin MCP', namespace: 'grimnir', instance_id: 'control-node', criticality: 'high' },
    kind: 'mcp',
    status: opts.status !== undefined ? opts.status : null,
    version: null,
    metrics: [],
    alerts: {
      rules: [{
        metric: 'mcp_healthy', op: '==', value: 0, streak: 2,
        severity: 'warning', title: 'MCP transport unhealthy',
        detail: 'Munin MCP transport down — Claude sessions on this Pi cannot access Munin tools.',
        error_metric: 'mcp_error',
      }],
      active_count: 0,
      firing: [],
    },
    panels: [],
    links: { repo: 'https://github.com/Magnus-Gille/munin-memory' },
    ui: { icon: 'plug', category: 'infra' },
  };
}

/** Snapshot for the MCP transport — status derived from the collected mcp_healthy metric. */
function mcpSnapshot(db, deps = {}) {
  const now = deps.now || Date.now();
  const getLatest = deps.getLatestMetrics || require('./db').getLatestMetrics;
  let healthy = null;
  try {
    for (const r of (db ? getLatest(db, 'control-node') : []) || []) {
      if (r && r.metric === 'mcp_healthy') healthy = r.value;
    }
  } catch { /* best-effort: no metrics yet */ }
  const status = healthy === 1 ? 'pass' : healthy === 0 ? 'fail' : null;
  return {
    service: 'munin-mcp', kind: 'mcp', status, descriptor: buildMcpDescriptor({ status }),
    fetchedAt: new Date(now).toISOString(), reachable: healthy != null,
    schemaVersion: SCHEMA_ID, source: 'plugin',
    error: healthy == null ? 'no mcp metrics collected yet' : null,
  };
}

module.exports = { probeMcp, collectMcpHealth, buildMcpDescriptor, mcpSnapshot };
