'use strict';

/**
 * Post-boot service health check (issue #7).
 *
 * Runs ~90s after boot and then every five minutes as a systemd oneshot
 * (systemd/heimdall-boot-check.{service,timer}).
 * After a power outage or reboot, a service may be running-but-broken or may have failed
 * to start with no auto-restart. This check probes each registered service that should be
 * up on the LOCAL host (control-node), raises a Heimdall dashboard alert AND sends a Telegram
 * alert via Ratatoskr if any are down, and clears the alert once everything is healthy.
 *
 * The pure pieces (selectBootServices, buildAlertMessage) and the orchestrator
 * (performBootCheck, with injectable probe/notify/services) are unit-tested in
 * test/boot-check.test.js without touching the network.
 */

const HOST = 'control-node';
const DEFAULT_TIMEOUT_MS = 5000;
// A couple of services (heimdall, ratatoskr) are only reachable via the Tailscale IP,
// so the boot check tolerates the tailnet still settling: the timer fires at
// OnBootSec=90 and each down service is retried up to 4× (5s apart, ~15s) before it's
// declared down. This makes a false "down after boot" alert from a slow tailnet unlikely.
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 5000;
const ALERT_TITLE = 'Service(s) down after boot';

/**
 * Pure: pick the services a boot check on control-node should probe over HTTP.
 * Local, long-running HTTP services only:
 *   - host === 'control-node'        (local box; matches the hard-coded host id used elsewhere)
 *   - has a health_url             (something to probe)
 *   - no ssh_host                  (ssh_host ⇒ remote-only, e.g. mimir on the nas)
 *   - no type                      (type 'timer'/'static' have no JSON health endpoint)
 */
function selectBootServices(services) {
  return (services || []).filter(
    (s) => s && s.host === HOST && s.health_url && !s.ssh_host && !s.type
  );
}

/** Pure: build the Telegram/alert message body for a set of down services. */
function buildAlertMessage(down, total) {
  const lines = down.map((d) => `• ${d.name} (${d.url}) — ${d.error || 'down'}`);
  return (
    `🚨 Heimdall boot check: ${down.length}/${total} service(s) down on ${HOST} after boot:\n` +
    lines.join('\n')
  );
}

/** Single HTTP liveness probe of one service's health_url. Never throws. */
async function probeUrl(svc, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(svc.health_url, { signal: controller.signal });
    return {
      name: svc.name,
      url: svc.health_url,
      up: resp.ok,
      status: resp.status,
      latency_ms: Date.now() - start,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      name: svc.name,
      url: svc.health_url,
      up: false,
      status: null,
      latency_ms: Date.now() - start,
      error: aborted ? `timeout after ${timeoutMs}ms` : (err && err.message) || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe a service, retrying a down result a few times — services may still be settling
 * shortly after boot, so one slow response shouldn't trigger a false alarm. `probe` is
 * injectable for testing.
 */
async function probeServiceWithRetry(svc, opts = {}) {
  const {
    probe = probeUrl,
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await probe(svc, timeoutMs);
    if (last.up) return { ...last, attempts: i + 1 };
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { ...last, attempts };
}

/**
 * Probe all eligible services, persist metrics, manage the boot-down alert, and
 * (optionally) push a Telegram alert. All side-effecting dependencies are injectable:
 *   - services: the registry        (default: loadServiceRegistry())
 *   - probe:    (svc) => Promise<result>  (default: probeServiceWithRetry wrapper)
 *   - notify:   (text) => Promise<void>   (default: null → Telegram skipped)
 *
 * A Telegram failure is logged but never aborts the check. createAlert/resolveAlert are
 * idempotent (dedupe on host+title), so periodic re-running is safe. Telegram is
 * sent only when the condition first becomes active, not on every failed probe.
 */
async function performBootCheck(db, timestamp, opts = {}) {
  const {
    insertMetrics,
    markCriticalAlertNotificationSent,
    markCriticalAlertNotificationFailed,
  } = require('./db');
  const { safeDeliveryError } = require('./notify');
  const { createAlert, resolveAlert } = require('./alerts');
  const {
    services = require('./drift').loadServiceRegistry(),
    probe = (svc) => probeServiceWithRetry(svc),
    notify = null,
  } = opts;

  const selected = selectBootServices(services);
  if (selected.length === 0) {
    // An empty selection usually means the config failed to load — don't false-alarm.
    console.warn('  Boot check: no local HTTP services to probe (config load issue?)');
  }

  // Guard each probe: a probe should never throw, but one that does must not abort
  // Promise.all and skip the metric/alert writes below — treat a throw as "down".
  const results = await Promise.all(
    selected.map(async (svc) => {
      try {
        return await probe(svc);
      } catch (err) {
        return { name: svc.name, url: svc.health_url, up: false, status: null, latency_ms: null, error: (err && err.message) || String(err) };
      }
    })
  );
  const down = results.filter((r) => !r.up);

  insertMetrics(db, [
    { timestamp, host: HOST, metric: 'boot_check_healthy', value: down.length === 0 ? 1 : 0, unit: 'boolean', metadata: null },
    { timestamp, host: HOST, metric: 'boot_check_down_count', value: down.length, unit: 'count', metadata: down.length ? { down: down.map((d) => d.name) } : null },
  ]);

  let notified = false;
  if (down.length > 0) {
    const message = buildAlertMessage(down, selected.length);
    const alreadyActive = !!db.prepare(
      'SELECT id FROM alerts WHERE host = ? AND title = ? AND resolved_at IS NULL'
    ).get(HOST, ALERT_TITLE);
    const alertId = createAlert(db, HOST, 'system', 'critical', ALERT_TITLE, message);
    if (notify && !alreadyActive) {
      try {
        await notify(message);
        markCriticalAlertNotificationSent(db, alertId, new Date().toISOString());
        notified = true;
      } catch (err) {
        const errorClass = safeDeliveryError(err);
        markCriticalAlertNotificationFailed(
          db,
          alertId,
          errorClass,
          new Date(Date.now() + 60_000).toISOString(),
        );
        console.error(`  Boot check: Telegram alert failed: ${errorClass}`);
      }
    }
  } else {
    resolveAlert(db, HOST, ALERT_TITLE); // idempotent — clear once everything is healthy
  }

  return {
    checked: selected.length,
    up: selected.length - down.length,
    down,
    alerted: down.length > 0,
    notified,
  };
}

async function run() {
  const { openDatabase } = require('./db');
  const { sendTelegram, parseChatId } = require('./notify');
  const { loadServicesWithMeta } = require('./config/services');
  const { assertSafeStartupTargets } = require('./config/live-config');
  const startupRegistry = loadServicesWithMeta();
  assertSafeStartupTargets(startupRegistry.services);
  const db = openDatabase(); // DB_PATH comes from the systemd unit's Environment=
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting boot health check`);

  try {
    let notify = null;
    const chatIdRaw = process.env.HEIMDALL_NOTIFY_CHAT_ID;
    if (chatIdRaw) {
      const chatId = parseChatId(chatIdRaw);
      if (chatId !== null) notify = (text) => sendTelegram(chatId, text);
      else console.error('  Boot check: HEIMDALL_NOTIFY_CHAT_ID is not a valid integer — Telegram disabled');
    } else {
      console.log('  Boot check: HEIMDALL_NOTIFY_CHAT_ID not set — Telegram disabled');
    }

    const summary = await performBootCheck(db, timestamp, { notify, services: startupRegistry.services });
    if (summary.alerted) {
      console.log(
        `  Boot check: ${summary.down.length}/${summary.checked} DOWN — ` +
        `${summary.down.map((d) => d.name).join(', ')}${summary.notified ? ' (alerted)' : ''}`
      );
    } else {
      console.log(`  Boot check: all ${summary.checked} services healthy`);
    }
  } catch (err) {
    console.error('  Boot check error:', (err && err.message) || err);
  }

  db.close();
  console.log(`[${new Date().toISOString()}] Boot check complete`);
}

// Only run when invoked as the entrypoint (node src/boot-check.js) — not when required by tests.
if (require.main === module) {
  run().catch((err) => {
    console.error('Boot check fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  selectBootServices,
  buildAlertMessage,
  probeUrl,
  probeServiceWithRetry,
  performBootCheck,
  run,
};
