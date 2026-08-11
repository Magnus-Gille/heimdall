'use strict';

const http = require('http');
const assert = require('assert');
const {
  selectBootServices,
  buildAlertMessage,
  probeUrl,
  probeServiceWithRetry,
  performBootCheck,
} = require('../src/boot-check');

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

// Production-faithful schema (mirrors test/inference.test.js): AUTOINCREMENT id +
// UNIQUE host/metric/timestamp + alerts table.
function makeDb() {
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
      detail TEXT, resolved_at TEXT, acknowledged INTEGER DEFAULT 0,
      dedup_key TEXT, source TEXT, notification_sent_at TEXT,
      notification_attempts INTEGER NOT NULL DEFAULT 0,
      notification_last_error TEXT, notification_next_attempt_at TEXT,
      last_observed_at TEXT
    );
  `);
  const collectorTimestamp = '2026-06-20T00:00:00Z';
  const collectorRun = Math.floor(Date.parse(collectorTimestamp) / 1000);
  db.prepare('INSERT INTO metrics (timestamp, host, metric, value, unit) VALUES (?, ?, ?, ?, ?)')
    .run(collectorTimestamp, 'control-node', 'collector_success', 1, 'boolean');
  db.prepare('INSERT INTO metrics (timestamp, host, metric, value, unit) VALUES (?, ?, ?, ?, ?)')
    .run(collectorTimestamp, 'control-node', 'collector_last_run', collectorRun, 'epoch');
  return db;
}

const activeAlerts = (db) => db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL').all();
const metricVal = (db, metric) =>
  db.prepare("SELECT value FROM metrics WHERE metric = ? ORDER BY id DESC LIMIT 1").get(metric);

// Mirror of the real heimdall.config.json shape, with every kind of entry.
const SAMPLE_SERVICES = [
  { name: 'munin-memory', host: 'control-node', health_url: 'http://localhost:3030/health' },
  { name: 'mimir', host: 'nas', health_url: 'http://192.0.2.20:3031/health', ssh_host: '192.0.2.20' },
  { name: 'hugin', host: 'control-node', health_url: 'http://localhost:3032/health' },
  { name: 'heimdall', host: 'control-node', health_url: 'http://192.0.2.10:3033/api/health' },
  { name: 'skuld', host: 'control-node', type: 'timer', systemd_unit: 'skuld' },
  { name: 'ratatoskr', host: 'control-node', health_url: 'http://192.0.2.10:3034/health', systemd_unit: 'ratatoskr' },
  { name: 'tallriksvis', host: 'control-node', type: 'static', health_url: 'http://localhost/' },
];

function testSelectBootServices() {
  const picked = selectBootServices(SAMPLE_SERVICES).map((s) => s.name);
  assert.deepStrictEqual(picked, ['munin-memory', 'hugin', 'heimdall', 'ratatoskr']);
  // mimir excluded (ssh_host → remote-only), skuld excluded (timer), tallriksvis excluded (static)
  assert.ok(!picked.includes('mimir'), 'remote ssh_host service excluded');
  assert.ok(!picked.includes('skuld'), 'timer service excluded');
  assert.ok(!picked.includes('tallriksvis'), 'static service excluded');
  assert.deepStrictEqual(selectBootServices(null), [], 'null-safe');
  assert.deepStrictEqual(selectBootServices(undefined), [], 'undefined-safe');
  console.log('  PASS: selectBootServices filters to local HTTP services');
}

function testBuildAlertMessage() {
  const msg = buildAlertMessage(
    [{ name: 'hugin', url: 'http://localhost:3032/health', error: 'HTTP 502' }],
    4
  );
  assert.ok(msg.includes('1/4'), 'shows down/total count');
  assert.ok(msg.includes('hugin'), 'names the down service');
  assert.ok(msg.includes('HTTP 502'), 'includes the error');
  assert.ok(msg.includes('control-node'), 'names the host');
  console.log('  PASS: buildAlertMessage formats the down list');
}

async function testProbeUrlUp() {
  await startMockServer((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  try {
    const r = await probeUrl({ name: 'x', health_url: mockBase + '/health' });
    assert.strictEqual(r.up, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.error, null);
    assert.ok(r.latency_ms >= 0);
    console.log('  PASS: probeUrl reports a 200 as up');
  } finally {
    await stopMockServer();
  }
}

async function testProbeUrlDown() {
  await startMockServer((req, res) => { res.writeHead(503); res.end('down'); });
  try {
    const r = await probeUrl({ name: 'x', health_url: mockBase + '/health' });
    assert.strictEqual(r.up, false);
    assert.ok(r.error.includes('503'));
    console.log('  PASS: probeUrl reports a 503 as down');
  } finally {
    await stopMockServer();
  }
}

async function testProbeUrlUnreachable() {
  // Nothing listens on this port → connection refused.
  const r = await probeUrl({ name: 'x', health_url: 'http://127.0.0.1:19998/health' }, 2000);
  assert.strictEqual(r.up, false);
  assert.ok(r.error && r.error.length > 0, 'has an error message');
  console.log('  PASS: probeUrl reports an unreachable service as down');
}

async function testProbeRetryRecovers() {
  let calls = 0;
  const flaky = async () => { calls++; return { name: 'x', url: 'u', up: calls >= 2, error: calls < 2 ? 'timeout' : null }; };
  const r = await probeServiceWithRetry({ name: 'x' }, { probe: flaky, attempts: 3, delayMs: 1 });
  assert.strictEqual(r.up, true, 'recovers on retry');
  assert.strictEqual(calls, 2, 'stopped retrying once up');
  assert.strictEqual(r.attempts, 2);
  console.log('  PASS: probeServiceWithRetry recovers a slow-to-settle service');
}

async function testProbeRetryStaysDown() {
  let calls = 0;
  const dead = async () => { calls++; return { name: 'x', url: 'u', up: false, error: 'refused' }; };
  const r = await probeServiceWithRetry({ name: 'x' }, { probe: dead, attempts: 2, delayMs: 1 });
  assert.strictEqual(r.up, false);
  assert.strictEqual(calls, 2, 'exhausted all attempts');
  assert.strictEqual(r.attempts, 2);
  console.log('  PASS: probeServiceWithRetry stays down after exhausting attempts');
}

// Mock probe driven by a name→up map; never touches the network.
const mockProbe = (upMap) => async (svc) => ({
  name: svc.name,
  url: svc.health_url,
  up: upMap[svc.name] !== false,
  error: upMap[svc.name] === false ? 'down' : null,
});

async function testPerformAllUp() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  const summary = await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(summary.checked, 4);
  assert.strictEqual(summary.down.length, 0);
  assert.strictEqual(summary.alerted, false);
  assert.strictEqual(summary.collectorHealthy, true);
  assert.strictEqual(calls.length, 0, 'no Telegram when all healthy');
  assert.strictEqual(activeAlerts(db).length, 0, 'no alert when all healthy');
  assert.strictEqual(metricVal(db, 'boot_check_healthy').value, 1);
  assert.strictEqual(metricVal(db, 'boot_check_down_count').value, 0);
  console.log('  PASS: performBootCheck — all healthy → no alert, no Telegram');
  db.close();
}

async function testCollectorWatchdogAlertsWhenTheCollectorStops() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  const summary = await performBootCheck(db, '2026-06-20T00:20:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(summary.collectorHealthy, false);
  assert.match(summary.collectorReason, /last ran/);
  const alerts = activeAlerts(db);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].title, 'Collector stopped or unhealthy');
  assert.strictEqual(alerts[0].dedup_key, 'heimdall:collector-watchdog');
  assert.strictEqual(calls.length, 1, 'independent boot check notifies while collector is stopped');
  assert.match(calls[0], /Collector stopped or unhealthy/);

  await performBootCheck(db, '2026-06-20T00:21:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(calls.length, 1, 'active watchdog alert remains deduplicated');

  db.prepare('UPDATE metrics SET timestamp = ?, value = ? WHERE metric = ?')
    .run('2026-06-20T00:22:00Z', 1, 'collector_success');
  db.prepare('UPDATE metrics SET timestamp = ?, value = ? WHERE metric = ?')
    .run('2026-06-20T00:22:00Z', Math.floor(Date.parse('2026-06-20T00:22:00Z') / 1000), 'collector_last_run');
  const recovered = await performBootCheck(db, '2026-06-20T00:23:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(recovered.collectorHealthy, true);
  assert.strictEqual(activeAlerts(db).length, 0);

  const refired = await performBootCheck(db, '2026-06-20T00:40:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(refired.collectorHealthy, false);
  assert.strictEqual(calls.length, 2, 'resolved watchdog notifies again when it re-fires');
  db.close();
}

async function testPerformSomeDown() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  const summary = await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({ hugin: false }),
    notify,
  });
  assert.strictEqual(summary.down.length, 1);
  assert.strictEqual(summary.down[0].name, 'hugin');
  assert.strictEqual(summary.alerted, true);
  assert.strictEqual(summary.notified, true);
  assert.strictEqual(calls.length, 1, 'one Telegram alert sent');
  assert.ok(calls[0].includes('hugin'), 'Telegram names the down service');
  const alerts = activeAlerts(db);
  assert.strictEqual(alerts.length, 1, 'one dashboard alert raised');
  assert.ok(alerts[0].title.toLowerCase().includes('boot'));
  assert.ok(alerts[0].notification_sent_at, 'immediate boot notification marks the durable outbox sent');
  assert.strictEqual(metricVal(db, 'boot_check_healthy').value, 0);
  assert.strictEqual(metricVal(db, 'boot_check_down_count').value, 1);
  console.log('  PASS: performBootCheck — a down service → alert + Telegram');
  db.close();
}

async function testPerformResolvesOnRecovery() {
  const db = makeDb();
  const notify = async () => {};
  await performBootCheck(db, '2026-06-20T00:00:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({ hugin: false }), notify });
  assert.strictEqual(activeAlerts(db).length, 1, 'alert raised while down');
  await performBootCheck(db, '2026-06-20T00:01:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({}), notify });
  assert.strictEqual(activeAlerts(db).length, 0, 'alert resolved once healthy again');
  console.log('  PASS: performBootCheck — alert clears on recovery');
  db.close();
}

async function testPerformResolvesWhenOnlyDownServiceIsRemovedFromRegistry() {
  const db = makeDb();
  const notify = async () => {};
  const withVerdandi = [
    ...SAMPLE_SERVICES,
    { name: 'verdandi', host: 'control-node', health_url: 'http://localhost:3036/health' },
  ];

  await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: withVerdandi,
    probe: mockProbe({ verdandi: false }),
    notify,
  });
  assert.strictEqual(activeAlerts(db).length, 1, 'alert raised while the service is monitored and down');

  const summary = await performBootCheck(db, '2026-06-20T00:05:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({}),
    notify,
  });
  assert.strictEqual(summary.checked, 4, 'next pass uses the current registry');
  assert.strictEqual(summary.down.length, 0, 'no monitored service remains down');
  assert.strictEqual(activeAlerts(db).length, 0, 'stale alert resolves without manual mutation');
  assert.strictEqual(metricVal(db, 'boot_check_healthy').value, 1);
  assert.strictEqual(metricVal(db, 'boot_check_down_count').value, 0);
  console.log('  PASS: performBootCheck — removing the sole deliberately unmonitored service resolves the stale alert');
  db.close();
}

async function testPerformDoesNotRenotifyWhileStillDown() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  await performBootCheck(db, '2026-06-20T00:00:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({ hugin: false }), notify });
  await performBootCheck(db, '2026-06-20T00:05:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({ hugin: false }), notify });
  assert.strictEqual(activeAlerts(db).length, 1, 'repeat failure stays deduplicated');
  assert.strictEqual(calls.length, 1, 'repeat failure does not spam Telegram');
  console.log('  PASS: performBootCheck — repeated failures refresh one alert without re-notifying');
  db.close();
}

async function testPerformNotifiesAgainAfterRecoveryAndRecurrence() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  await performBootCheck(db, '2026-06-20T00:00:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({ hugin: false }), notify });
  await performBootCheck(db, '2026-06-20T00:05:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({}), notify });
  await performBootCheck(db, '2026-06-20T00:10:00Z', { services: SAMPLE_SERVICES, probe: mockProbe({ hugin: false }), notify });
  assert.strictEqual(activeAlerts(db).length, 1, 'recurrence creates one fresh active alert');
  assert.strictEqual(calls.length, 2, 'recurrence after recovery notifies again');
  console.log('  PASS: performBootCheck — recovery resets notification suppression');
  db.close();
}

async function testPerformNoChatIdNoThrow() {
  const db = makeDb();
  // notify omitted (null) — mirrors HEIMDALL_NOTIFY_CHAT_ID unset.
  const summary = await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({ hugin: false }),
  });
  assert.strictEqual(summary.alerted, true);
  assert.strictEqual(summary.notified, false, 'no Telegram when notify is null');
  assert.strictEqual(activeAlerts(db).length, 1, 'dashboard alert still raised without Telegram');
  console.log('  PASS: performBootCheck — missing chat id still alerts, never throws');
  db.close();
}

async function testPerformNotifyFailureDoesNotAbort() {
  const db = makeDb();
  const notify = async () => { throw new Error('private-token=do-not-store'); };
  const summary = await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: SAMPLE_SERVICES,
    probe: mockProbe({ hugin: false }),
    notify,
  });
  assert.strictEqual(summary.alerted, true);
  assert.strictEqual(summary.notified, false, 'notify failure recorded as not-notified');
  const alerts = activeAlerts(db);
  assert.strictEqual(alerts.length, 1, 'dashboard alert raised despite Telegram failure');
  assert.strictEqual(alerts[0].notification_last_error, 'transport-error');
  assert.ok(alerts[0].notification_next_attempt_at, 'failed boot delivery remains retryable');
  assert.ok(!JSON.stringify(alerts[0]).includes('do-not-store'), 'raw transport error is not persisted');
  console.log('  PASS: performBootCheck — a Telegram failure never aborts the check');
  db.close();
}

async function testPerformThrowingProbeTreatedAsDown() {
  const db = makeDb();
  const calls = [];
  const notify = async (text) => { calls.push(text); };
  // A probe that throws must not abort the whole check — it should count as down,
  // and metrics + alert must still be written.
  const throwingProbe = async (svc) => {
    if (svc.name === 'hugin') throw new Error('boom');
    return { name: svc.name, url: svc.health_url, up: true, error: null };
  };
  const summary = await performBootCheck(db, '2026-06-20T00:00:00Z', {
    services: SAMPLE_SERVICES,
    probe: throwingProbe,
    notify,
  });
  assert.strictEqual(summary.checked, 4, 'all services still accounted for');
  assert.strictEqual(summary.down.length, 1);
  assert.strictEqual(summary.down[0].name, 'hugin');
  assert.strictEqual(summary.down[0].error, 'boom', 'thrown error captured');
  assert.strictEqual(activeAlerts(db).length, 1, 'alert still raised despite a throwing probe');
  assert.strictEqual(calls.length, 1, 'Telegram still sent');
  assert.strictEqual(metricVal(db, 'boot_check_down_count').value, 1, 'metrics still written');
  console.log('  PASS: performBootCheck — a throwing probe is treated as down, never aborts');
  db.close();
}

async function main() {
  console.log('Boot Health Check Tests:');
  testSelectBootServices();
  testBuildAlertMessage();
  await testProbeUrlUp();
  await testProbeUrlDown();
  await testProbeUrlUnreachable();
  await testProbeRetryRecovers();
  await testProbeRetryStaysDown();
  await testPerformAllUp();
  await testCollectorWatchdogAlertsWhenTheCollectorStops();
  await testPerformSomeDown();
  await testPerformResolvesOnRecovery();
  await testPerformResolvesWhenOnlyDownServiceIsRemovedFromRegistry();
  await testPerformDoesNotRenotifyWhileStillDown();
  await testPerformNotifiesAgainAfterRecoveryAndRecurrence();
  await testPerformNoChatIdNoThrow();
  await testPerformNotifyFailureDoesNotAbort();
  await testPerformThrowingProbeTreatedAsDown();
  console.log('\nAll boot health check tests passed.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
