'use strict';

const http = require('http');
const assert = require('assert');
const { summarizeLedger, probeInference } = require('../src/inference');

let mockServer;
let mockBase;

function startMockServer(handler) {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler);
    mockServer.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${mockServer.address().port}`;
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

const SAMPLE_LEDGER = {
  report: [
    { taskType: 'extract', modelId: 'm', verdict: 'viable', attempts: 5, passes: 4, frozen: true, avgLatencyMs: 800, avgTokPerSec: 12.4 },
    { taskType: 'classify', modelId: 'm', verdict: 'marginal', attempts: 3, passes: 1, frozen: false, avgLatencyMs: 1200, avgTokPerSec: 8.0 },
    { taskType: 'summarize', modelId: 'm', verdict: 'not_viable', attempts: 4, passes: 0, frozen: true, avgLatencyMs: null, avgTokPerSec: null },
  ],
  recent: [{ outcome: 'pass' }, { outcome: 'fail' }, { outcome: 'pass' }],
};

function testSummarizeLedger() {
  const s = summarizeLedger(SAMPLE_LEDGER);
  assert.strictEqual(s.pairs, 3);
  assert.deepStrictEqual(s.byVerdict, { viable: 1, marginal: 1, not_viable: 1, unknown: 0 });
  assert.strictEqual(s.frozen, 2);
  assert.strictEqual(s.attempts, 12);
  assert.ok(Math.abs(s.successRate - 5 / 12) < 1e-9);
  assert.strictEqual(s.avgLatencyMs, 1000);   // null-latency pair excluded
  assert.strictEqual(s.avgTokPerSec, 10.2);
  assert.strictEqual(s.recentCount, 3);
  assert.ok(Math.abs(s.recentPassRate - 2 / 3) < 1e-9);
  assert.strictEqual(s.recentUnverifiedCount, 0);
  console.log('  PASS: summarizeLedger derives metrics');
}

function testSummarizeEmpty() {
  const s = summarizeLedger({});
  assert.strictEqual(s.pairs, 0);
  assert.strictEqual(s.successRate, null);
  assert.strictEqual(s.avgTokPerSec, null);
  assert.strictEqual(s.recentPassRate, null);
  assert.strictEqual(s.recentUnverifiedCount, 0);
  assert.deepStrictEqual(s.byVerdict, { viable: 0, marginal: 0, not_viable: 0, unknown: 0 });
  // Also tolerant of null/undefined input.
  assert.strictEqual(summarizeLedger(null).pairs, 0);
  console.log('  PASS: summarizeLedger is safe on empty/null input');
}

// Real production `recent` arrays are NOT all pass/fail — unverified delegations (mcp-ask
// freeform queries, shadow-measure probes with no deterministic verifier) outnumber graded
// ones. Those must NOT count as failures in the denominator, or the dashboard reports a
// misleadingly low pass rate for a gateway that is actually healthy.
function testSummarizeLedgerRecentExcludesUnverified() {
  const s = summarizeLedger({
    report: [],
    recent: [
      { outcome: 'pass' }, { outcome: 'pass' }, { outcome: 'pass' }, { outcome: 'pass' },
      { outcome: 'pass' }, { outcome: 'pass' }, { outcome: 'pass' }, { outcome: 'pass' },
      { outcome: 'fail' }, { outcome: 'fail' },
      { outcome: 'unverified' }, { outcome: 'unverified' }, { outcome: 'unverified' }, { outcome: 'unverified' },
      { outcome: 'unverified' }, { outcome: 'unverified' }, { outcome: 'unverified' }, { outcome: 'unverified' },
      { outcome: 'unverified' }, { outcome: 'unverified' },
    ],
  });
  assert.strictEqual(s.recentCount, 20);
  assert.strictEqual(s.recentUnverifiedCount, 10);
  // 8 pass / 10 fail-or-pass (the unverified 10 are excluded from the denominator) = 0.8,
  // NOT 8/20 = 0.4 — the bug this guards against.
  assert.ok(Math.abs(s.recentPassRate - 0.8) < 1e-9, `recentPassRate ${s.recentPassRate} should be 0.8`);
  console.log('  PASS: summarizeLedger excludes unverified outcomes from recentPassRate');
}

function testSummarizeLedgerRecentAllUnverified() {
  const s = summarizeLedger({ report: [], recent: [{ outcome: 'unverified' }, { outcome: 'unverified' }] });
  assert.strictEqual(s.recentCount, 2);
  assert.strictEqual(s.recentUnverifiedCount, 2);
  // No verified outcomes at all → rate is unknown, not 0.
  assert.strictEqual(s.recentPassRate, null);
  console.log('  PASS: summarizeLedger reports null (not 0) pass rate when nothing is verified');
}

function testSummarizePartials() {
  // (passes + 0.5*partials)/attempts = (1 + 1)/4 = 0.5 — NOT the pass-only 1/4.
  const s = summarizeLedger({
    report: [{ verdict: 'marginal', attempts: 4, passes: 1, partials: 2, fails: 1 }],
    recent: [],
  });
  assert.ok(Math.abs(s.successRate - 0.5) < 1e-9, `successRate ${s.successRate} should be 0.5 (partials half-credit)`);
  console.log('  PASS: successRate counts partials as half-credit (matches ledger.ts)');
}

async function testProbeHealthy() {
  await startMockServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/ledger') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SAMPLE_LEDGER));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const r = await probeInference(mockBase, 'owner-key');
    assert.strictEqual(r.healthy, true);
    assert.strictEqual(r.error, null);
    assert.ok(r.summary && r.summary.pairs === 3);
    assert.ok(r.latency_ms >= 0);
    console.log('  PASS: probe reports healthy + ledger summary');
  } finally {
    await stopMockServer();
  }
}

async function testProbeHealthzDown() {
  await startMockServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Service Unavailable');
  });
  try {
    const r = await probeInference(mockBase, 'owner-key');
    assert.strictEqual(r.healthy, false);
    assert.strictEqual(r.summary, null);
    assert.ok(r.error.includes('503'));
    console.log('  PASS: probe detects unhealthy gateway');
  } finally {
    await stopMockServer();
  }
}

async function testProbeHealthyButLedgerForbidden() {
  await startMockServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'route_not_allowed' } }));
    }
  });
  try {
    const r = await probeInference(mockBase, 'guest-key');
    assert.strictEqual(r.healthy, true);     // liveness ok
    assert.strictEqual(r.summary, null);      // but ledger unreadable
    assert.ok(r.error && r.error.includes('403'));
    console.log('  PASS: healthy gateway with unreadable ledger is still healthy');
  } finally {
    await stopMockServer();
  }
}

// Matches the production metrics schema (AUTOINCREMENT id + UNIQUE host/metric/timestamp),
// so same-timestamp re-inserts collide exactly as they do on the Pi.
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
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
  else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(SAMPLE_LEDGER)); }
}
// NOTE: inference alert streak/recovery/reload behaviour moved out of
// collectInferenceHealth into the generic alert engine — covered by
// test/alert-engine.test.js. collectInferenceHealth now only writes metrics.

async function testCollectPersistsSummaryMetrics() {
  const db = makeMetricsDb();
  await startMockServer(healthyServer);
  try {
    delete require.cache[require.resolve('../src/inference')];
    const { collectInferenceHealth } = require('../src/inference');
    await collectInferenceHealth(db, '2026-06-17T02:00:00Z', mockBase);
    const names = db.prepare("SELECT metric FROM metrics WHERE host='m5'").all().map((r) => r.metric);
    for (const m of [
      'inference_healthy', 'inference_latency_ms', 'inference_success_rate', 'inference_avg_tok_per_sec',
      'inference_avg_latency_ms', 'inference_recent_count', 'inference_recent_pass_rate',
      'inference_recent_unverified_count', 'inference_frozen_pairs',
    ]) {
      assert.ok(names.includes(m), `metric ${m} should be persisted`);
    }
    console.log('  PASS: collect persists the full summary metric set');
  } finally {
    await stopMockServer();
    db.close();
  }
}

async function main() {
  console.log('M5 Inference Collector Tests:');
  testSummarizeLedger();
  testSummarizeEmpty();
  testSummarizePartials();
  testSummarizeLedgerRecentExcludesUnverified();
  testSummarizeLedgerRecentAllUnverified();
  await testProbeHealthy();
  await testProbeHealthzDown();
  await testProbeHealthyButLedgerForbidden();
  await testCollectPersistsSummaryMetrics();
  console.log('\nAll inference collector tests passed.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
