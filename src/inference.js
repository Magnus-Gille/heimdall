'use strict';

/**
 * M5 inference-observability collector.
 *
 * Polls the BosGame M5 home-server gateway for liveness (`GET /healthz`) and the
 * capability ledger (`GET /ledger`), derives observability metrics, stores them
 * via the metrics table, and raises/clears an alert when the gateway is down.
 *
 * Mirrors mcp-probe.js. The gateway contract is documented in
 * `gateway-api-contract.md` in the home-server-inference-evaluation repo.
 *
 * SCOPE: until the M5 ships there is no gateway to poll, so `collectInferenceHealth`
 * is not yet registered in the collector loop / dashboard — that wiring is the M5
 * boot-day step. The pure summary + probe are unit-tested against a mock gateway.
 */

const GATEWAY_DEFAULT = process.env.HOMESERVER_GATEWAY_URL || 'http://127.0.0.1:8080';
const TIMEOUT_MS = 5000;

/**
 * Pure: collapse a `/ledger` response ({ report, recent }) into observability metrics.
 * Safe on missing/empty input.
 */
function summarizeLedger(ledger) {
  const report = Array.isArray(ledger && ledger.report) ? ledger.report : [];
  const recent = Array.isArray(ledger && ledger.recent) ? ledger.recent : [];

  const byVerdict = { viable: 0, marginal: 0, not_viable: 0, unknown: 0 };
  let frozen = 0;
  let attempts = 0;
  let passes = 0;
  let partials = 0;
  let latSum = 0, latN = 0;
  let tpsSum = 0, tpsN = 0;

  for (const r of report) {
    if (Object.prototype.hasOwnProperty.call(byVerdict, r.verdict)) byVerdict[r.verdict]++;
    if (r.frozen) frozen++;
    attempts += r.attempts || 0;
    passes += r.passes || 0;
    partials += r.partials || 0;
    if (typeof r.avgLatencyMs === 'number') { latSum += r.avgLatencyMs; latN++; }
    if (typeof r.avgTokPerSec === 'number') { tpsSum += r.avgTokPerSec; tpsN++; }
  }

  // "unverified" outcomes (no deterministic verifier ran for that delegation path — e.g.
  // freeform mcp-ask queries, shadow-measure probes) are NOT failures; they were simply never
  // graded. Excluding them from the denominator keeps the rate meaningful: counting them as
  // fails understated a genuinely healthy gateway (8 pass / 2 fail / 10 unverified read as a
  // misleading 40% instead of the true 80% verified pass rate).
  const recentPass = recent.filter((d) => d.outcome === 'pass').length;
  const recentVerified = recent.filter((d) => d.outcome === 'pass' || d.outcome === 'fail').length;
  const recentUnverifiedCount = recent.filter((d) => d.outcome !== 'pass' && d.outcome !== 'fail').length;

  return {
    pairs: report.length,                                   // distinct (task_type, model) pairs tracked
    byVerdict,                                              // viable/marginal/not_viable/unknown tallies
    frozen,                                                 // pairs latched by freeze-on-failure
    attempts,
    // Pooled success rate matching the gateway ledger's own formula (ledger.ts):
    // partial outcomes count as half-credit, so Heimdall never diverges from routing semantics.
    successRate: attempts > 0 ? (passes + 0.5 * partials) / attempts : null,
    avgLatencyMs: latN > 0 ? Math.round(latSum / latN) : null,
    avgTokPerSec: tpsN > 0 ? Math.round((tpsSum / tpsN) * 10) / 10 : null,
    recentCount: recent.length,
    recentPassRate: recentVerified > 0 ? recentPass / recentVerified : null,
    recentUnverifiedCount,
  };
}

/**
 * Probe the gateway: /healthz liveness + /ledger summary.
 * @returns {Promise<{healthy:boolean, latency_ms:number, summary:object|null, error:string|null}>}
 */
async function probeInference(baseUrl = GATEWAY_DEFAULT, apiKey = process.env.HOMESERVER_GATEWAY_API_KEY) {
  const base = String(baseUrl).replace(/\/$/, '');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const health = await fetch(`${base}/healthz`, { signal: ctrl.signal });
    if (!health.ok) {
      return { healthy: false, latency_ms: Date.now() - start, summary: null, error: `healthz HTTP ${health.status}` };
    }
    const healthBody = await health.json().catch(() => ({}));
    const healthy = !!(healthBody && healthBody.ok === true);

    // Ledger summary is best-effort (requires auth); a healthy gateway with an
    // unreadable ledger is still "healthy" but we record the ledger error.
    let summary = null;
    let ledgerError = null;
    try {
      const led = await fetch(`${base}/ledger`, { headers, signal: ctrl.signal });
      if (led.ok) summary = summarizeLedger(await led.json());
      else ledgerError = `ledger HTTP ${led.status}`;
    } catch (e) {
      ledgerError = e instanceof Error ? e.message : String(e);
    }

    return {
      healthy,
      latency_ms: Date.now() - start,
      summary,
      error: healthy ? ledgerError : 'healthz ok:false',
    };
  } catch (err) {
    return {
      healthy: false,
      latency_ms: Date.now() - start,
      summary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe, store metrics, and manage the gateway-down alert.
 *
 * The failure streak is derived from the DB (the last two `inference_healthy` rows),
 * NOT module memory: Heimdall's collector runs as a per-cycle systemd oneshot, so a
 * module-level counter resets every cycle and would never reach 2. (mcp-probe.js has
 * this same latent bug — worth a separate fix.)
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string} timestamp - ISO timestamp; MUST differ per cycle (metrics are unique per host+metric+timestamp)
 * @param {string} [baseUrl]
 * @param {string} [apiKey]
 */
async function collectInferenceHealth(db, timestamp, baseUrl, apiKey) {
  const { insertMetrics } = require('./db');

  const r = await probeInference(baseUrl, apiKey);
  const s = r.summary;

  const rows = [
    { timestamp, host: 'm5', metric: 'inference_healthy', value: r.healthy ? 1 : 0, unit: 'boolean', metadata: null },
    { timestamp, host: 'm5', metric: 'inference_latency_ms', value: r.latency_ms, unit: 'ms', metadata: null },
  ];
  if (s) {
    rows.push(
      { timestamp, host: 'm5', metric: 'inference_ledger_pairs', value: s.pairs, unit: 'count', metadata: { byVerdict: s.byVerdict } },
      { timestamp, host: 'm5', metric: 'inference_frozen_pairs', value: s.frozen, unit: 'count', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_success_rate', value: s.successRate, unit: 'ratio', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_avg_tok_per_sec', value: s.avgTokPerSec, unit: 'tok/s', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_avg_latency_ms', value: s.avgLatencyMs, unit: 'ms', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_recent_count', value: s.recentCount, unit: 'count', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_recent_pass_rate', value: s.recentPassRate, unit: 'ratio', metadata: null },
      { timestamp, host: 'm5', metric: 'inference_recent_unverified_count', value: s.recentUnverifiedCount, unit: 'count', metadata: null },
    );
  }
  rows.push({ timestamp, host: 'm5', metric: 'inference_error', value: null, unit: 'text', metadata: r.error ? { error: r.error } : null });
  insertMetrics(db, rows);

  // Alerting moved to the generic alert engine (src/alert-engine.js, collector
  // §9b): it evaluates the declared `inference_healthy` rule on the `m5-gateway`
  // descriptor against the metrics written above — same 2-streak semantics.

  return r;
}

module.exports = { summarizeLedger, probeInference, collectInferenceHealth };
