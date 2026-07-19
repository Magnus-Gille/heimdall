'use strict';

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAS_IP = process.env.HEIMDALL_STORAGE_SSH_HOST || '192.0.2.20';
const SSH_USER = process.env.HEIMDALL_STORAGE_SSH_USER || 'heimdall';
// Use id_ed25519 for arbitrary commands — heimdall_ed25519 has a ForceCommand
// in the NAS authorized_keys that runs the metrics probe script
const SSH_KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');
const KNOWN_HOSTS = path.join(os.homedir(), '.heimdall', 'known_hosts');
const REPOS_DIR = path.join(os.homedir(), 'repos');
const SCRATCH_DIR = path.join(os.homedir(), 'scratch');
const HUGIN_LOGS_DIR = path.join(os.homedir(), '.hugin', 'logs');

// Services we audit — split by host
const LOCAL_SERVICES = ['munin-memory', 'hugin', 'heimdall', 'skuld', 'ratatoskr'];
const REMOTE_SERVICES = [{ name: 'mimir', host: NAS_IP }];

// Grimnir component repos to look for in ~/repos/
const GRIMNIR_REPOS = ['munin-memory', 'hugin', 'heimdall', 'skuld', 'ratatoskr', 'fortnox-mcp', 'mimir', 'grimnir'];

// Cache with TTL
let cachedData = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run a shell command with timeout, returns stdout or null on failure.
 */
function safeExec(cmd, timeoutMs = 10000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

/**
 * Run a command on the NAS via SSH with 5s connection timeout.
 */
let lastSshError = null;
function sshExec(cmd, timeoutMs = 10000) {
  try {
    return execSync(
      `ssh -i ${SSH_KEY} -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS} -o BatchMode=yes -o IdentityAgent=none ${SSH_USER}@${NAS_IP} "${cmd.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString().trim().slice(0, 500)) || null;
    lastSshError = {
      at: new Date().toISOString(),
      status: e.status,
      signal: e.signal,
      stderr,
      message: e.message && e.message.slice(0, 200),
    };
    console.error(`[sshExec] NAS SSH failed (status=${e.status} signal=${e.signal}): ${stderr || e.message}`);
    return null;
  }
}

function getLastSshError() { return lastSshError; }

/**
 * Parse systemd timestamp format: "Wed 2026-03-25 14:26:43 CET"
 * Node.js Date() can't parse this directly.
 */
function parseSystemdTimestamp(raw) {
  if (!raw) return null;
  // Remove day name prefix (e.g., "Wed ")
  let cleaned = raw.replace(/^[A-Z][a-z]{2}\s+/, '');
  // Map common European timezone abbreviations to UTC offsets
  const tzMap = { CET: '+01:00', CEST: '+02:00', UTC: '+00:00', GMT: '+00:00', EET: '+02:00', EEST: '+03:00' };
  for (const [tz, offset] of Object.entries(tzMap)) {
    if (cleaned.endsWith(` ${tz}`)) {
      cleaned = cleaned.replace(` ${tz}`, offset);
      break;
    }
  }
  // Insert T separator between date and time
  cleaned = cleaned.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

// ──────────────────────────────────────
// 2a. Systemd service audit
// ──────────────────────────────────────

function parseSystemctlShow(raw) {
  if (!raw) return {};
  const props = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

function getLocalServiceInfo(serviceName) {
  const raw = safeExec(
    `systemctl show ${serviceName}.service --property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,LoadState,UnitFileState,MemoryCurrent 2>/dev/null`,
    5000
  );
  const props = parseSystemctlShow(raw);

  const activeState = props.ActiveState || 'unknown';
  const subState = props.SubState || 'unknown';
  const mainPID = parseInt(props.MainPID) || 0;
  const loadState = props.LoadState || 'unknown';
  const unitFileState = props.UnitFileState || 'unknown';
  const enabled = unitFileState === 'enabled';

  // Parse start timestamp — systemd format: "Wed 2026-03-25 14:26:43 CET"
  let startedAt = null;
  let uptimeSeconds = null;
  const startTs = props.ExecMainStartTimestamp;
  if (startTs && startTs !== '0' && startTs !== 'n/a' && startTs.length > 1) {
    try {
      const d = parseSystemdTimestamp(startTs);
      if (d && !isNaN(d.getTime())) {
        startedAt = d.toISOString();
        uptimeSeconds = Math.floor((Date.now() - d.getTime()) / 1000);
      }
    } catch { /* unparseable */ }
  }

  // Memory: MemoryCurrent is in bytes (only works with cgroup v2)
  let memoryRSS = null;
  const memCurrent = props.MemoryCurrent;
  if (memCurrent && memCurrent !== '[not set]' && memCurrent !== 'infinity') {
    const val = parseInt(memCurrent);
    if (!isNaN(val) && val > 0) memoryRSS = val;
  }

  // Fallback: read /proc/<pid>/status for VmRSS
  if (memoryRSS == null && mainPID > 0) {
    try {
      const statusFile = fs.readFileSync(`/proc/${mainPID}/status`, 'utf8');
      const m = statusFile.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) memoryRSS = parseInt(m[1]) * 1024;
    } catch { /* process gone or no permission */ }
  }

  return {
    name: serviceName,
    host: 'control-node',
    hostLabel: 'Pi 1',
    activeState,
    subState,
    enabled,
    startedAt,
    uptimeSeconds,
    memoryRSS,
    mainPID: mainPID > 0 ? mainPID : null,
  };
}

function getRemoteServiceInfo(serviceName, host) {
  // Query remote systemd via SSH
  const raw = sshExec(
    `systemctl show ${serviceName}.service --property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,LoadState,UnitFileState,MemoryCurrent 2>/dev/null`,
    10000
  );
  if (!raw) {
    return {
      name: serviceName,
      host: 'nas',
      hostLabel: 'Pi 2',
      activeState: 'unreachable',
      subState: 'ssh-failed',
      enabled: null,
      startedAt: null,
      uptimeSeconds: null,
      memoryRSS: null,
      mainPID: null,
    };
  }

  const props = parseSystemctlShow(raw);
  const activeState = props.ActiveState || 'unknown';
  const subState = props.SubState || 'unknown';
  const mainPID = parseInt(props.MainPID) || 0;
  const unitFileState = props.UnitFileState || 'unknown';
  const enabled = unitFileState === 'enabled';

  let startedAt = null;
  let uptimeSeconds = null;
  const startTs = props.ExecMainStartTimestamp;
  if (startTs && startTs !== '0' && startTs !== 'n/a' && startTs.length > 1) {
    try {
      const d = parseSystemdTimestamp(startTs);
      if (d && !isNaN(d.getTime())) {
        startedAt = d.toISOString();
        uptimeSeconds = Math.floor((Date.now() - d.getTime()) / 1000);
      }
    } catch { /* unparseable */ }
  }

  // Memory from remote
  let memoryRSS = null;
  const memCurrent = props.MemoryCurrent;
  if (memCurrent && memCurrent !== '[not set]' && memCurrent !== 'infinity') {
    const val = parseInt(memCurrent);
    if (!isNaN(val) && val > 0) memoryRSS = val;
  }
  if (memoryRSS == null && mainPID > 0) {
    const rssRaw = sshExec(`cat /proc/${mainPID}/status 2>/dev/null | grep VmRSS`, 5000);
    if (rssRaw) {
      const m = rssRaw.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) memoryRSS = parseInt(m[1]) * 1024;
    }
  }

  return {
    name: serviceName,
    host: 'nas',
    hostLabel: 'Pi 2',
    activeState,
    subState,
    enabled,
    startedAt,
    uptimeSeconds,
    memoryRSS,
    mainPID: mainPID > 0 ? mainPID : null,
  };
}

function collectServices() {
  const services = [];
  for (const svc of LOCAL_SERVICES) {
    services.push(getLocalServiceInfo(svc));
  }
  for (const { name, host } of REMOTE_SERVICES) {
    services.push(getRemoteServiceInfo(name, host));
  }
  return services;
}

// ──────────────────────────────────────
// 2b. Git repo status
// ──────────────────────────────────────

function collectRepoStatus() {
  const repos = [];
  for (const repoName of GRIMNIR_REPOS) {
    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) continue;
    const repoDir = path.join(REPOS_DIR, repoName);
    if (!fs.existsSync(path.join(repoDir, '.git'))) continue;

    // Fetch from remote first (quiet, with timeout)
    safeExec(`git -C "${repoDir}" fetch --quiet 2>/dev/null`, 15000);

    // Current branch
    const branch = safeExec(`git -C "${repoDir}" rev-parse --abbrev-ref HEAD 2>/dev/null`, 5000) || 'unknown';

    // Clean or dirty
    const statusOutput = safeExec(`git -C "${repoDir}" status --porcelain 2>/dev/null`, 5000);
    const dirty = statusOutput != null && statusOutput.length > 0;

    // Ahead/behind
    let ahead = 0, behind = 0;
    const leftRight = safeExec(`git -C "${repoDir}" rev-list --left-right --count HEAD...@{u} 2>/dev/null`, 5000);
    if (leftRight) {
      const parts = leftRight.split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0]) || 0;
        behind = parseInt(parts[1]) || 0;
      }
    }

    // Last commit
    const lastCommitRaw = safeExec(`git -C "${repoDir}" log -1 --format="%H%n%h%n%s%n%aI" 2>/dev/null`, 5000);
    let lastCommit = null;
    if (lastCommitRaw) {
      const lines = lastCommitRaw.split('\n');
      if (lines.length >= 4) {
        lastCommit = {
          hash: lines[0],
          shortHash: lines[1],
          message: lines[2].slice(0, 72),
          date: lines[3],
        };
      }
    }

    repos.push({
      name: repoName,
      branch,
      dirty,
      ahead,
      behind,
      lastCommit,
    });
  }
  return repos;
}

// ──────────────────────────────────────
// 2c. Running Node processes
// ──────────────────────────────────────

function collectNodeProcesses(services) {
  const processes = [];
  const raw = safeExec(`ps aux --no-headers 2>/dev/null | grep '[n]ode'`, 5000);
  if (!raw) return processes;

  // Build set of PIDs owned by known services
  const knownPIDs = new Set();
  for (const svc of services) {
    if (svc.mainPID) knownPIDs.add(svc.mainPID);
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const pid = parseInt(parts[1]);
    const cpu = parseFloat(parts[2]) || 0;
    const mem = parseFloat(parts[3]) || 0;
    const elapsed = parts[9] || '';
    const command = parts.slice(10).join(' ');

    // Skip grep artifacts
    if (command.includes('grep')) continue;

    const ownerService = findOwnerService(pid, services);
    processes.push({
      pid,
      cpu,
      mem,
      elapsed,
      command: command.slice(0, 120),
      ownerService,
      orphan: !ownerService,
    });
  }
  return processes;
}

function findOwnerService(pid, services) {
  for (const svc of services) {
    if (svc.mainPID === pid) return svc.name;
  }
  // Check if this PID is a child of a known service PID
  const ppidRaw = safeExec(`ps -o ppid= -p ${pid} 2>/dev/null`, 2000);
  if (ppidRaw) {
    const ppid = parseInt(ppidRaw.trim());
    for (const svc of services) {
      if (svc.mainPID === ppid) return svc.name;
    }
  }
  return null;
}

// ──────────────────────────────────────
// 2d. Stale artifacts / cleanup suggestions
// ──────────────────────────────────────

function collectCleanupSuggestions() {
  const suggestions = [];

  // 1. Scratch dirs older than 7 days
  try {
    if (fs.existsSync(SCRATCH_DIR)) {
      const entries = fs.readdirSync(SCRATCH_DIR, { withFileTypes: true });
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 3600 * 1000;
      let staleCount = 0;
      let totalSize = 0;
      for (const entry of entries) {
        try {
          const fullPath = path.join(SCRATCH_DIR, entry.name);
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > sevenDaysMs) {
            staleCount++;
            if (entry.isDirectory()) {
              const sizeRaw = safeExec(`du -sb "${fullPath}" 2>/dev/null | cut -f1`, 5000);
              if (sizeRaw) totalSize += parseInt(sizeRaw) || 0;
            } else {
              totalSize += stat.size;
            }
          }
        } catch { /* skip unreadable */ }
      }
      if (staleCount > 0) {
        suggestions.push({
          type: 'scratch',
          label: 'Stale scratch directories',
          detail: `${staleCount} item(s) older than 7 days`,
          size: totalSize,
          safe: true,
        });
      }
    }
  } catch { /* scratch dir doesn't exist */ }

  // 2. Hugin task log files older than 14 days
  try {
    if (fs.existsSync(HUGIN_LOGS_DIR)) {
      const entries = fs.readdirSync(HUGIN_LOGS_DIR);
      const now = Date.now();
      const fourteenDaysMs = 14 * 24 * 3600 * 1000;
      let oldCount = 0;
      let totalSize = 0;
      for (const name of entries) {
        try {
          const fullPath = path.join(HUGIN_LOGS_DIR, name);
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > fourteenDaysMs) {
            oldCount++;
            totalSize += stat.size;
          }
        } catch { /* skip */ }
      }
      if (oldCount > 0) {
        suggestions.push({
          type: 'logs',
          label: 'Old Hugin task logs',
          detail: `${oldCount} log file(s) older than 14 days`,
          size: totalSize,
          safe: true,
        });
      }
    }
  } catch { /* logs dir doesn't exist */ }

  // 3. Stopped/disabled systemd units that are still installed
  try {
    const raw = safeExec(
      `systemctl list-unit-files --type=service --state=disabled --no-legend 2>/dev/null | awk '{print $1}'`,
      5000
    );
    if (raw) {
      const units = raw.split('\n').filter(u => u.endsWith('.service'));
      const staleUnits = [];
      for (const unit of units) {
        // Check if also inactive
        const state = safeExec(`systemctl is-active ${unit} 2>/dev/null`, 2000);
        if (state === 'inactive' || state === 'dead') {
          staleUnits.push(unit.replace('.service', ''));
        }
      }
      if (staleUnits.length > 0) {
        suggestions.push({
          type: 'systemd',
          label: 'Disabled systemd units still installed',
          detail: staleUnits.slice(0, 10).join(', ') + (staleUnits.length > 10 ? ` (+${staleUnits.length - 10} more)` : ''),
          count: staleUnits.length,
          safe: false,
        });
      }
    }
  } catch { /* ok */ }

  // 4. Stale git branches (merged branches other than main)
  try {
    let totalStale = 0;
    const repoDetails = [];
    for (const repoName of GRIMNIR_REPOS) {
      const repoDir = path.join(REPOS_DIR, repoName);
      if (!fs.existsSync(path.join(repoDir, '.git'))) continue;
      const merged = safeExec(
        `git -C "${repoDir}" branch --merged main 2>/dev/null | grep -v '\\*\\|main$\\|master$' | sed 's/^[* ]*//'`,
        5000
      );
      if (merged) {
        const branches = merged.split('\n').filter(b => b.trim());
        if (branches.length > 0) {
          totalStale += branches.length;
          repoDetails.push(`${repoName}: ${branches.join(', ')}`);
        }
      }
    }
    if (totalStale > 0) {
      suggestions.push({
        type: 'branches',
        label: 'Stale merged git branches',
        detail: repoDetails.join('; '),
        count: totalStale,
        safe: true,
      });
    }
  } catch { /* ok */ }

  return suggestions;
}

// ──────────────────────────────────────
// Main collection function
// ──────────────────────────────────────

function collectDeploymentAudit() {
  const start = Date.now();
  const services = collectServices();
  const repos = collectRepoStatus();
  const nodeProcesses = collectNodeProcesses(services);
  const cleanup = collectCleanupSuggestions();

  return {
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    services,
    repos,
    nodeProcesses,
    cleanup,
  };
}

/**
 * Get deployment audit data, using cache if fresh enough.
 */
function getDeploymentAudit() {
  const now = Date.now();
  if (cachedData && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedData;
  }
  cachedData = collectDeploymentAudit();
  cacheTimestamp = now;
  return cachedData;
}

/**
 * Force refresh the cache (called from collector cycle).
 */
function refreshDeploymentAudit() {
  cachedData = collectDeploymentAudit();
  cacheTimestamp = Date.now();
  return cachedData;
}

module.exports = { getDeploymentAudit, refreshDeploymentAudit, collectDeploymentAudit, getLastSshError };
