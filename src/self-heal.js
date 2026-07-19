'use strict';

/**
 * self-heal.js — Autonomous service recovery for Grimnir
 *
 * When a service health check fails for 2+ consecutive collection cycles,
 * submits a Hugin task to investigate and attempt recovery.
 *
 * Rate-limited: max 1 heal task per service per hour.
 * Scope: investigate → restart → report. Never destructive.
 *
 * This is the first "autonomous improvement by design" signal in Grimnir —
 * Heimdall detects, Hugin acts, Munin coordinates.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { muninRpc: muninRpcShared } = require('./munin-rpc');

const STATE_FILE = path.join(os.homedir(), '.heimdall', 'self-heal-state.json');

// Services eligible for self-healing (excludes heimdall itself — can't heal yourself)
const HEALABLE_SERVICES = ['munin-memory', 'hugin', 'ratatoskr', 'skuld', 'mimir'];

// Minimum consecutive failures before triggering (2 cycles = ~10 min)
const MIN_CONSECUTIVE_FAILURES = 2;

// Cooldown: don't submit another heal task for the same service within this window
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function loadApiKey() {
  if (process.env.MUNIN_API_KEY) return process.env.MUNIN_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'repos', 'heimdall', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'repos', 'munin-memory', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  return null;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { failures: {}, lastHeal: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const muninRpc = (method, args) => muninRpcShared(method, args, { apiKey: loadApiKey(), timeoutMs: 10000, label: 'self-heal' });

/**
 * Generate a task ID for the heal task.
 */
function generateTaskId(serviceName) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}-heal-${serviceName}`;
}

/**
 * Build the Hugin task prompt for investigating a failed service.
 */
function buildHealPrompt(serviceName) {
  const isRemote = serviceName === 'mimir';
  const sshHost = process.env.HEIMDALL_STORAGE_SSH_HOST || '192.0.2.20';
  const sshUser = process.env.HEIMDALL_STORAGE_SSH_USER || 'heimdall';
  const sshPrefix = isRemote ? `ssh ${sshUser}@${sshHost} ` : '';
  const host = isRemote ? `storage node (${sshHost})` : 'control-node';

  return `You are Heimdall's autonomous recovery agent. A Grimnir service has been unhealthy for 10+ minutes.

## Service: ${serviceName}
## Host: ${host}

## Investigation steps (do ALL of these):

1. Check systemd status:
   ${sshPrefix}systemctl status ${serviceName}.service

2. Read recent journal logs (last 50 lines):
   ${sshPrefix}journalctl -u ${serviceName}.service -n 50 --no-pager

3. Check if the process is running:
   ${sshPrefix}pgrep -a -f ${serviceName} || echo "No process found"

4. Check disk space:
   ${sshPrefix}df -h /

5. Check memory:
   ${sshPrefix}free -h

## Decision:

Based on the logs and status:

- If the service crashed and logs show a recoverable error (OOM, uncaught exception, socket timeout):
  → Restart it: ${sshPrefix}sudo systemctl restart ${serviceName}.service
  → Wait 5 seconds, then check status again
  → Report what you did and whether it recovered

- If the service is running but the health endpoint is failing:
  → Report the symptoms but do NOT restart (may be a code bug, not a crash)

- If there's a deeper issue (disk full, config error, missing dependency):
  → Report the diagnosis but do NOT attempt fixes beyond a restart

## Output:

Write a clear report to stdout with:
- What you found
- What action you took (if any)
- Whether the service recovered
- Any recommended follow-up for the operator`;
}

/**
 * Check service health from the most recent metrics in the DB.
 * Returns true if the service responded to its health check, false if unreachable.
 */
function isServiceHealthy(db, serviceName) {
  // Check service_versions table — if deployed_commit is null, health check failed
  const row = db.prepare(`
    SELECT deployed_commit FROM service_versions
    WHERE service = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(serviceName);

  if (!row) return true; // No data yet — assume healthy
  return row.deployed_commit != null;
}

/**
 * Main self-heal check. Called at the end of each collection cycle.
 *
 * @param {object} db - better-sqlite3 database instance (read-only access to metrics)
 */
async function checkAndHeal(db) {
  if (!/^(1|true)$/i.test(process.env.HEIMDALL_SELF_HEAL_ENABLED || '')) {
    console.log('  self-heal: disabled (set HEIMDALL_SELF_HEAL_ENABLED=1 to opt in)');
    return { enabled: false, tasksSubmitted: 0 };
  }

  const state = loadState();
  const now = Date.now();
  let tasksSubmitted = 0;

  for (const svc of HEALABLE_SERVICES) {
    const healthy = isServiceHealthy(db, svc);

    if (healthy) {
      // Clear failure counter on recovery
      if (state.failures[svc]) {
        const prevCount = state.failures[svc];
        delete state.failures[svc];
        if (prevCount >= MIN_CONSECUTIVE_FAILURES) {
          console.log(`  self-heal: ${svc} recovered (was at ${prevCount} consecutive failures)`);
        }
      }
      continue;
    }

    // Increment failure counter
    state.failures[svc] = (state.failures[svc] || 0) + 1;
    console.log(`  self-heal: ${svc} unhealthy (${state.failures[svc]} consecutive)`);

    // Not enough consecutive failures yet
    if (state.failures[svc] < MIN_CONSECUTIVE_FAILURES) {
      continue;
    }

    // Check cooldown
    const lastHealTime = state.lastHeal[svc] || 0;
    if (now - lastHealTime < COOLDOWN_MS) {
      const remainingMin = Math.ceil((COOLDOWN_MS - (now - lastHealTime)) / 60000);
      console.log(`  self-heal: ${svc} in cooldown (${remainingMin}min remaining)`);
      continue;
    }

    // Submit heal task to Hugin via Munin
    const taskId = generateTaskId(svc);
    const prompt = buildHealPrompt(svc);
    const submittedAt = new Date().toISOString();

    const taskContent = `## Task: Investigate and recover ${svc}

- **Runtime:** claude
- **Context:** scratch
- **Timeout:** 120000
- **Submitted by:** heimdall-self-heal
- **Submitted at:** ${submittedAt}
- **Reply-to:** none
- **Reply-format:** full

### Prompt
${prompt}`;

    const result = await muninRpc('memory_write', {
      namespace: `tasks/${taskId}`,
      key: 'status',
      content: taskContent,
      tags: ['pending', 'runtime:claude', 'type:heal', `service:${svc}`],
    });

    if (result) {
      state.lastHeal[svc] = now;
      tasksSubmitted++;
      console.log(`  self-heal: submitted task ${taskId} for ${svc}`);

      // Log the action to Munin for visibility
      await muninRpc('memory_log', {
        namespace: 'infrastructure/self-heal',
        content: `Auto-heal triggered for ${svc}: ${state.failures[svc]} consecutive health check failures. Task: ${taskId}`,
        tags: ['self-heal', 'automated', `service:${svc}`],
      });
    } else {
      console.warn(`  self-heal: failed to submit task for ${svc}`);
    }
  }

  saveState(state);

  if (tasksSubmitted > 0) {
    console.log(`  self-heal: ${tasksSubmitted} task(s) submitted`);
  } else {
    // Summary log: confirm self-heal ran when no other output was produced
    const trackedFailures = Object.keys(state.failures).length;
    if (trackedFailures === 0) {
      console.log(`  self-heal: all ${HEALABLE_SERVICES.length} services healthy`);
    } else {
      console.log(`  self-heal: ${HEALABLE_SERVICES.length - trackedFailures} healthy, ${trackedFailures} unhealthy tracked`);
    }
  }
  return { enabled: true, tasksSubmitted };
}

module.exports = { checkAndHeal, buildHealPrompt };
