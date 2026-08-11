'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareCommits } = require('./drift-compare');

// Validate IP address (IPv4 only — Tailscale uses 100.x.x.x)
function isValidIP(str) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str) &&
    str.split('.').every(n => parseInt(n) >= 0 && parseInt(n) <= 255);
}

// Validate health URL — must be http(s) with no shell metacharacters
function isValidHealthURL(str) {
  return /^https?:\/\/[a-zA-Z0-9._:\-\/]+$/.test(str);
}

function classifyHealthPayload(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    return { status: 'malformed', reason: 'health response was not an object' };
  }
  if (typeof health.status === 'string' && /^(error|failed|failure|down|unhealthy)$/i.test(health.status)) {
    return { status: 'unhealthy', reason: `health status=${health.status}` };
  }
  return { status: 'healthy', reason: null };
}

function loadServiceRegistry() {
  // Single source of truth: derive from grimnir services.json + heimdall overlay
  // (#92). Falls back to the committed list if grimnir's file is unreadable.
  try {
    return require('./config/services').loadServices();
  } catch {
    return [];
  }
}

// systemd unit names allow letters, digits, and `:-_.\@`. Validate before any
// shell interpolation so a malformed registry entry can't inject commands.
function isSafeUnitName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9:._@-]+$/.test(name);
}

/**
 * Parse a `systemctl show` timestamp property to an ISO string, or null.
 * systemd emits localized strings like "Thu 2026-07-02 03:00:00 CEST" — Node's
 * Date can't parse the "CEST"/"CET" abbreviation, so getTimerStatus runs
 * systemctl with TZ=UTC (→ "... UTC", which Node DOES parse). This handles the
 * n/a / zero / unparseable cases gracefully.
 */
function parseSystemdTimestamp(raw) {
  if (!raw || raw === 'n/a' || raw.startsWith('0')) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Get timer status for a systemd timer service (oneshot + timer pair).
 * Returns { lastRun, lastResult, nextRun, activeState } or null on failure.
 */
function getTimerStatus(unitName) {
  if (!isSafeUnitName(unitName)) return null;
  // Force UTC so systemctl emits parseable "... UTC" timestamps (see
  // parseSystemdTimestamp) instead of a locale abbreviation Node can't parse.
  const opts = { encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC' } };
  try {
    // Get timer info (next trigger)
    const timerRaw = execSync(
      `systemctl show ${unitName}.timer --property=NextElapseUSec,LastTriggerUSec 2>/dev/null`,
      opts
    ).trim();
    // Get service info (last run result)
    const svcRaw = execSync(
      `systemctl show ${unitName}.service --property=ActiveState,ExecMainStatus,ExecMainStartTimestamp 2>/dev/null`,
      opts
    ).trim();

    const props = {};
    for (const line of [...timerRaw.split('\n'), ...svcRaw.split('\n')]) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }

    const lastTrigger = props.LastTriggerUSec || props.ExecMainStartTimestamp || null;
    const nextElapse = props.NextElapseUSec || null;
    const exitCode = parseInt(props.ExecMainStatus) || 0;
    const activeState = props.ActiveState || 'unknown';

    return {
      lastRun: parseSystemdTimestamp(lastTrigger),
      lastResult: exitCode === 0 ? 'ok' : `exit ${exitCode}`,
      exitOk: exitCode === 0,
      nextRun: parseSystemdTimestamp(nextElapse),
      activeState,
    };
  } catch {
    return null;
  }
}

/**
 * Get the deployed commit for a local repo by reading HEAD.
 * Used for timer/oneshot services that don't have a health endpoint.
 */
function getLocalRepoCommit(repoName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) return null;
  try {
    const repoDir = path.join(os.homedir(), 'repos', repoName);
    const hash = execSync(
      `git -C "${repoDir}" rev-parse HEAD 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return hash.length >= 7 ? hash.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/**
 * Read the commit stamped into a service's deploy_path by the deploy pipeline
 * (`<deploy_path>/.deployed-commit`, written by grimnir's deploy.sh).
 *
 * This is the AUTHORITATIVE deployed commit and the only reliable one in this
 * setup: service /health endpoints mostly omit a commit (so drift fell back to
 * the literal 'ok', which never matches a SHA), and the on-Pi git checkouts are
 * stale because rsync deploys exclude .git/. The stamp sidesteps both.
 *
 * Reads the file locally when the service lives on the heimdall host, or over
 * SSH (id_ed25519, like the remote health check) for ssh_host services.
 * Returns a 7-char short hash, or null if no stamp exists yet (callers fall
 * back to the previous per-type detection).
 */
function getDeployedCommitStamp(svc) {
  if (!svc.deploy_path || typeof svc.deploy_path !== 'string') return null;
  // Guard against shell/path injection before any interpolation.
  if (!/^[a-zA-Z0-9._/-]+$/.test(svc.deploy_path)) return null;
  const stampPath = `${svc.deploy_path.replace(/\/+$/, '')}/.deployed-commit`;
  try {
    let raw;
    if (svc.ssh_host) {
      if (!isValidIP(svc.ssh_host)) return null;
      const knownHosts = path.join(os.homedir(), '.heimdall', 'known_hosts');
      const key = path.join(os.homedir(), '.ssh', 'id_ed25519');
      const sshUser = process.env.HEIMDALL_STORAGE_SSH_USER || 'heimdall';
      if (!/^[a-zA-Z0-9._-]+$/.test(sshUser)) return null;
      raw = execSync(
        `ssh -i ${key} -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} -o BatchMode=yes ${sshUser}@${svc.ssh_host} "cat ${stampPath} 2>/dev/null"`,
        { encoding: 'utf8', timeout: 10000 }
      );
    } else {
      raw = fs.readFileSync(stampPath, 'utf8');
    }
    const hash = (raw || '').trim().split(/\s+/)[0];
    return /^[0-9a-f]{7,40}$/i.test(hash) ? hash.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch latest commit from origin/main using local git repo (SSH-based remotes).
 * Falls back to git ls-remote HTTPS if local fetch fails.
 */
function getLatestRemoteCommit(svc) {
  if (!svc.repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(svc.repo)) return null;
  const repoName = svc.repo.split('/')[1];
  const repoDir = path.join(os.homedir(), 'repos', repoName);

  // Try local fetch first (uses SSH remote configured in the repo)
  try {
    execSync(
      `git -C "${repoDir}" fetch origin main --quiet 2>/dev/null`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const hash = execSync(
      `git -C "${repoDir}" rev-parse origin/main 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (hash.length >= 7) return hash.slice(0, 7);
  } catch { /* local fetch failed */ }

  // Fallback: git ls-remote via HTTPS (works for public repos)
  try {
    const raw = execSync(
      `git ls-remote https://github.com/${svc.repo}.git HEAD 2>/dev/null | cut -f1`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (raw.length >= 7) return raw.slice(0, 7);
  } catch { /* HTTPS also failed */ }

  return null;
}

/**
 * Count how far a deployed revision is behind / ahead of origin/main using the
 * local checkout. Returns { behind, ahead } or null when the question cannot be
 * answered here (no local clone, unknown revision, unrelated histories).
 *
 * This is what replaces the old `-1` guess: either we can count, or we say so.
 */
function countCommitGap(svc, deployed, latest) {
  if (!svc.repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(svc.repo)) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(deployed) || !/^[0-9a-f]{7,40}$/i.test(latest)) return null;
  const repoDir = path.join(os.homedir(), 'repos', svc.repo.split('/')[1]);
  try {
    const raw = execSync(
      `git -C "${repoDir}" rev-list --left-right --count ${deployed}...${latest} 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const m = /^(\d+)\s+(\d+)$/.exec(raw);
    if (!m) return null;
    // left = commits only in `deployed` (ahead), right = only in origin/main (behind)
    return { ahead: Number(m[1]), behind: Number(m[2]) };
  } catch {
    return null;
  }
}

async function collectServiceDrift(db, options = {}) {
  const services = Array.isArray(options.services) ? options.services : loadServiceRegistry();
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const timestamp = new Date().toISOString();
  const results = [];

  for (const svc of services) {
    let deployed = null;
    let latest = null;
    // Assigned unconditionally in Step 3 below.
    let commitsBehind;
    let driftState;
    let driftReason;
    let healthLatencyMs = null;
    let healthStatus = 'unknown';
    let healthReason = null;
    let commitMessage = null;
    let timerStatus = null;

    // Timer-based services: get status from systemd instead of health endpoint
    if (svc.type === 'timer') {
      timerStatus = getTimerStatus(svc.systemd_unit || svc.name);
      if (!timerStatus) {
        healthStatus = 'unreachable';
        healthReason = 'systemd status probe failed';
      } else if (!timerStatus.lastRun) {
        healthStatus = 'unknown';
        healthReason = 'timer has no completed run';
      } else if (timerStatus.exitOk) {
        healthStatus = 'healthy';
      } else {
        healthStatus = 'unhealthy';
        healthReason = `timer result ${timerStatus.lastResult}`;
      }
      // Get deployed version from local repo HEAD
      const repoName = svc.repo ? svc.repo.split('/')[1] : svc.name;
      deployed = getLocalRepoCommit(repoName);
    } else if (svc.type === 'static') {
      // Static site: simple HTTP status check — no JSON expected
      if (!isValidHealthURL(svc.health_url)) {
        console.error(`drift: invalid health_url for ${svc.name}: ${svc.health_url}`);
        continue;
      }
      try {
        const healthStart = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetchImpl(svc.health_url, { signal: controller.signal });
        clearTimeout(timeout);
        healthLatencyMs = Date.now() - healthStart;
        healthStatus = resp.ok ? 'healthy' : 'unhealthy';
        healthReason = resp.ok ? null : `HTTP ${resp.status}`;
        deployed = resp.ok ? 'ok' : `http-${resp.status}`;
      } catch {
        healthStatus = 'unreachable';
        healthReason = 'health endpoint probe failed';
      }
    } else {
      // Step 1: Get deployed version from /health endpoint (with latency measurement)
      try {
        let health;
        let healthResponseOk = true;
        let healthResponseStatus = null;
        const healthStart = Date.now();
        if (svc.ssh_host) {
          // Validate config values before shell interpolation
          if (!isValidIP(svc.ssh_host)) {
            console.error(`drift: invalid ssh_host for ${svc.name}: ${svc.ssh_host}`);
            continue;
          }
          if (!isValidHealthURL(svc.health_url)) {
            console.error(`drift: invalid health_url for ${svc.name}: ${svc.health_url}`);
            continue;
          }
          // Remote service: health check via SSH
          const sshUser = process.env.HEIMDALL_STORAGE_SSH_USER || 'heimdall';
          if (!/^[a-zA-Z0-9._-]+$/.test(sshUser)) throw new Error('invalid SSH user');
          const raw = execSync(
            `ssh -i ~/.ssh/id_ed25519 -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${os.homedir()}/.heimdall/known_hosts ${sshUser}@${svc.ssh_host} "curl -s -m 5 ${svc.health_url}"`,
            { encoding: 'utf8', timeout: 15000 }
          ).trim();
          health = JSON.parse(raw);
        } else {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const resp = await fetchImpl(svc.health_url, { signal: controller.signal });
          clearTimeout(timeout);
          healthResponseOk = resp.ok;
          healthResponseStatus = resp.status;
          health = await resp.json();
        }
        healthLatencyMs = Date.now() - healthStart;
        const healthOutcome = healthResponseOk
          ? classifyHealthPayload(health)
          : { status: 'unhealthy', reason: `HTTP ${healthResponseStatus}` };
        healthStatus = healthOutcome.status;
        healthReason = healthOutcome.reason;
        deployed = health.version || health.commit || health.git_version || 'ok';
      } catch {
        healthStatus = 'unreachable';
        healthReason = 'health endpoint probe failed';
      }
    }

    // Prefer the commit stamped into deploy_path by the deploy pipeline — it is
    // authoritative even when /health omits a commit or the on-Pi .git is stale
    // (rsync deploys exclude .git/). Falls back to the per-type detection above.
    const stamped = getDeployedCommitStamp(svc);
    if (stamped) deployed = stamped;

    // Step 2: Get latest commit from origin/main (local fetch with SSH, fallback to HTTPS)
    latest = getLatestRemoteCommit(svc);

    // Try to get commit message for the deployed version
    // Validate deployed is a hex commit hash and repo name is safe
    if (deployed && deployed !== 'ok' && svc.repo && /^[0-9a-f]{7,40}$/i.test(deployed) && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(svc.repo)) {
      try {
        const repoDir = path.join(os.homedir(), 'repos', svc.repo.split('/')[1]);
        const msg = execSync(
          `git -C "${repoDir}" log --format=%s -1 ${deployed} 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (msg) commitMessage = msg.slice(0, 60);
      } catch { /* ok — repo may not be local */ }
    }

    // Step 3: Calculate drift.
    //
    // The previous implementation wrote `-1` for every non-equal pair, which
    // conflated "4 commits behind" with "the deployed value was never a commit"
    // and with "origin/main could not be fetched". Now the comparison returns an
    // explicit state; `commits_behind` is null or a NON-NEGATIVE count, and
    // callers gate alerting on the state (see src/drift-alerts.js).
    const cmp = compareCommits(deployed, latest, {
      count: (d, l) => countCommitGap(svc, d, l),
    });
    commitsBehind = cmp.commitsBehind;
    driftState = cmp.state;
    driftReason = cmp.reason;

    // Write to DB
    db.prepare(`
      INSERT INTO service_versions
        (checked_at, service, host, deployed_commit, latest_commit, commits_behind,
         drift_state, drift_reason, health_status, health_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(timestamp, svc.name, svc.host, deployed, latest, commitsBehind,
      driftState, driftReason, healthStatus, healthReason);

    // Store health latency as a metric
    if (healthLatencyMs != null) {
      const { insertMetrics } = require('./db');
      insertMetrics(db, [{
        timestamp, host: 'control-node',
        metric: `deploy_health_latency_${svc.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        value: healthLatencyMs, unit: 'ms', metadata: null,
      }]);
    }

    // Store timer status as metrics for dashboard display
    if (timerStatus) {
      const { insertMetrics } = require('./db');
      const timerMetrics = [];
      if (timerStatus.lastRun) {
        timerMetrics.push({
          timestamp, host: 'control-node',
          metric: `timer_last_run_${svc.name}`, value: 0,
          unit: 'timestamp', metadata: timerStatus.lastRun,
        });
      }
      if (timerStatus.nextRun) {
        timerMetrics.push({
          timestamp, host: 'control-node',
          metric: `timer_next_run_${svc.name}`, value: 0,
          unit: 'timestamp', metadata: timerStatus.nextRun,
        });
      }
      timerMetrics.push({
        timestamp, host: 'control-node',
        metric: `timer_last_result_${svc.name}`, value: timerStatus.lastResult === 'ok' ? 1 : 0,
        unit: 'status', metadata: timerStatus.lastResult,
      });
      if (timerMetrics.length > 0) insertMetrics(db, timerMetrics);
    }

    const result = {
      service: svc.name,
      host: svc.host,
      repo: svc.repo || null,
      deploy_path: svc.deploy_path || null,
      deployed_commit: deployed,
      latest_commit: latest,
      commits_behind: commitsBehind,
      drift_state: driftState,
      drift_reason: driftReason,
      health_status: healthStatus,
      health_reason: healthReason,
      health_latency_ms: healthLatencyMs,
      commit_message: commitMessage,
      // Exit codes this job uses to mean "ran fine, found things" rather than
      // "could not run" (see src/timer-outcome.js).
      findings_exit_codes: Array.isArray(svc.findings_exit_codes) ? svc.findings_exit_codes : undefined,
    };
    if (timerStatus) result.timer_status = timerStatus;
    if (svc.type === 'timer') result.type = 'timer';
    if (svc.type === 'static') result.type = 'static';
    results.push(result);
  }

  return results;
}

/**
 * Get restart count for a systemd service in the last 24 hours.
 */
function getServiceRestartCount(serviceName) {
  if (!isSafeUnitName(serviceName)) return 0;
  try {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const output = execSync(
      `journalctl -u ${serviceName} --since="${since}" -o short-unix 2>/dev/null | grep -c "Started\\|Stopped" || echo 0`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    // Each restart produces a Stop+Start pair, so divide by 2 and subtract 1 for initial start
    const events = parseInt(output) || 0;
    return Math.max(0, Math.floor(events / 2));
  } catch {
    return 0;
  }
}

/**
 * Detect when the deployed commit hash changed (deploy event) by comparing
 * current and previous records in service_versions.
 */
function getLastDeployTime(db, serviceName) {
  try {
    const rows = db.prepare(`
      SELECT checked_at, deployed_commit FROM service_versions
      WHERE service = ? AND deployed_commit IS NOT NULL
      ORDER BY checked_at DESC LIMIT 20
    `).all(serviceName);
    if (rows.length < 2) return rows.length > 0 ? rows[0].checked_at : null;
    const currentCommit = rows[0].deployed_commit;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].deployed_commit !== currentCommit) {
        // The deploy happened between rows[i] and rows[i-1]
        return rows[i - 1].checked_at;
      }
    }
    return null; // deploy predates the query window — don't guess
  } catch {
    return null;
  }
}

module.exports = {
  loadServiceRegistry,
  collectServiceDrift,
  classifyHealthPayload,
  countCommitGap,
  getServiceRestartCount,
  getLastDeployTime,
  getTimerStatus,
  getDeployedCommitStamp,
  parseSystemdTimestamp,
  isSafeUnitName,
};
