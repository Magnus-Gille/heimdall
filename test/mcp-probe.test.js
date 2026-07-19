'use strict';

const http = require('http');
const assert = require('assert');
const { probeMcp } = require('../src/mcp-probe');

let mockServer;
let mockPort;

function startMockServer(handler) {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler);
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) mockServer.close(resolve);
    else resolve();
  });
}

// mcp-probe.js hardcodes the MCP URL, so we monkey-patch http.request to redirect
// it at our mock server. The patch lives on the shared core `http` singleton, so it
// survives the require-cache deletes used below to simulate a fresh oneshot process.
const originalRequest = http.request;

function patchUrl(port) {
  http.request = function(url, opts, cb) {
    if (typeof url === 'string' && url.includes('3030/mcp')) {
      url = `http://127.0.0.1:${port}/mcp`;
    }
    return originalRequest.call(this, url, opts, cb);
  };
}

function restoreUrl() {
  http.request = originalRequest;
}

async function testProbeSuccess() {
  await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: message\ndata: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"munin-memory","version":"0.1.0"}},"jsonrpc":"2.0","id":1}\n\n');
  });
  patchUrl(mockPort);
  try {
    const result = await probeMcp();
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.error, null);
    assert.ok(result.latency_ms >= 0);
    console.log('  PASS: probe succeeds with valid response');
  } finally {
    restoreUrl();
    await stopMockServer();
  }
}

async function testProbeAuthError() {
  await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid_token","error_description":"Missing Authorization header"}');
  });
  patchUrl(mockPort);
  try {
    const result = await probeMcp();
    assert.strictEqual(result.healthy, false);
    assert.ok(result.error.includes('401'));
    console.log('  PASS: probe detects auth error');
  } finally {
    restoreUrl();
    await stopMockServer();
  }
}

async function testProbeConnectionRefused() {
  // Use a port that nothing listens on
  http.request = function(url, opts, cb) {
    if (typeof url === 'string' && url.includes('3030/mcp')) {
      url = 'http://127.0.0.1:19999/mcp';
    }
    return originalRequest.call(this, url, opts, cb);
  };
  try {
    const result = await probeMcp();
    assert.strictEqual(result.healthy, false);
    assert.ok(result.error.includes('ECONNREFUSED') || result.error.includes('connect'));
    console.log('  PASS: probe detects connection refused');
  } finally {
    restoreUrl();
  }
}

async function testProbeJsonRpcError() {
  await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: message\ndata: {"error":{"code":-32600,"message":"Invalid request"},"jsonrpc":"2.0","id":1}\n\n');
  });
  patchUrl(mockPort);
  try {
    const result = await probeMcp();
    assert.strictEqual(result.healthy, false);
    assert.ok(result.error.includes('Invalid request'));
    console.log('  PASS: probe detects JSON-RPC error');
  } finally {
    restoreUrl();
    await stopMockServer();
  }
}

// Matches the production metrics schema (AUTOINCREMENT id + UNIQUE host/metric/timestamp),
// so same-timestamp re-inserts collide exactly as they do on the Pi and the DB-derived
// streak must rely on distinct per-cycle timestamps (as the real collector emits).
function makeMetricsDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, host TEXT NOT NULL,
      metric TEXT NOT NULL, value REAL, unit TEXT, metadata TEXT
    );
    CREATE UNIQUE INDEX idx_metrics_unique ON metrics(host, metric, timestamp);
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, host TEXT NOT NULL,
      category TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT, resolved_at TEXT, acknowledged INTEGER DEFAULT 0
    );
  `);
  return db;
}

function downServer(req, res) { res.writeHead(503); res.end('down'); }
function healthyServer(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('event: message\ndata: {"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"munin-memory","version":"0.1.0"}},"jsonrpc":"2.0","id":1}\n\n');
}
// NOTE: MCP alert streak/recovery/reload/stale-clear behaviour moved out of
// collectMcpHealth into the generic alert engine — covered by
// test/alert-engine.test.js (it reproduces these against the metrics table,
// which is exactly what the engine reads). collectMcpHealth now only writes metrics.

async function main() {
  console.log('MCP Probe Tests:');
  await testProbeSuccess();
  await testProbeAuthError();
  await testProbeConnectionRefused();
  await testProbeJsonRpcError();
  console.log('\nAll MCP probe tests passed.');
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
