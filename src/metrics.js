'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
  readCpuTempC,
  buildZoneEnumerateShellSnippet,
  parseZoneEnumerateOutput,
  selectCpuTempC,
} = require('./thermal');

// Validate that a string is a safe hostname or IP (no shell metacharacters)
function isValidHost(str) {
  return /^[a-zA-Z0-9._\-]+$/.test(str);
}

// CPU tick fields we collect from /proc/stat (cpu line: user nice system idle iowait).
// irq/softirq/steal are not collected, so "total" is the sum of these five.
const CPU_TICK_FIELDS = ['cpu_user_ticks', 'cpu_nice_ticks', 'cpu_system_ticks', 'cpu_idle_ticks', 'cpu_iowait_ticks'];

// CPU-busy % between two tick snapshots: the fraction of total ticks spent
// actively executing (user+nice+system). idle and iowait both count as "not
// running" — answering "how hard is the CPU working", not "is it blocked on I/O".
// Returns null if either snapshot is incomplete or no time elapsed (total<=0).
function computeCpuBusyPct(prev, cur) {
  if (!prev || !cur) return null;
  for (const f of CPU_TICK_FIELDS) {
    if (prev[f] == null || cur[f] == null) return null;
  }
  // A negative delta on any of these monotonic /proc/stat counters means the
  // counter reset between samples (host rebooted, possibly across a skipped
  // cycle). The interval is then meaningless — skip it rather than store a
  // negative or >100% value. With all deltas >= 0, busy is a subset-sum of the
  // terms making up total, so the result is provably in [0, 100].
  for (const f of CPU_TICK_FIELDS) {
    if (cur[f] - prev[f] < 0) return null;
  }
  const total = CPU_TICK_FIELDS.reduce((s, f) => s + (cur[f] - prev[f]), 0);
  if (total <= 0) return null;
  const busy = (cur.cpu_user_ticks - prev.cpu_user_ticks)
    + (cur.cpu_nice_ticks - prev.cpu_nice_ticks)
    + (cur.cpu_system_ticks - prev.cpu_system_ticks);
  return (busy / total) * 100;
}

function collectLocalMetrics() {
  const metrics = {};
  const timestamp = new Date().toISOString();

  // CPU temperature — discovered from sysfs thermal zones, keyed on each
  // zone's declared `type` (issue #5). Zone index is not a stable identifier,
  // so it is never used for selection; see src/thermal.js and
  // src/config/thermal-zone-types.js for the discovery/priority logic.
  // `value` is null (never a false 0°C) whenever no zone can be resolved.
  metrics.cpu_temp = { value: readCpuTempC().value, unit: 'celsius' };

  // Memory (including swap and available MB)
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0') * 1024;
    const available = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0') * 1024;
    const used = total - available;
    metrics.mem_used_pct = { value: total > 0 ? (used / total) * 100 : null, unit: 'percent' };
    metrics.mem_total = { value: total, unit: 'bytes' };
    metrics.mem_available = { value: available, unit: 'bytes' };
    metrics.mem_available_mb = { value: Math.round(available / (1024 * 1024)), unit: 'MB' };
    // Swap
    const swapTotal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] || '0') * 1024;
    const swapFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] || '0') * 1024;
    metrics.swap_total = { value: swapTotal, unit: 'bytes' };
    metrics.swap_free = { value: swapFree, unit: 'bytes' };
    metrics.swap_used_pct = { value: swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : 0, unit: 'percent' };
  } catch { metrics.mem_used_pct = { value: null, unit: 'percent' }; }

  // Load average
  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf8');
    const parts = loadavg.trim().split(/\s+/);
    metrics.load_1m = { value: parseFloat(parts[0]), unit: '' };
    metrics.load_5m = { value: parseFloat(parts[1]), unit: '' };
    metrics.load_15m = { value: parseFloat(parts[2]), unit: '' };
  } catch { metrics.load_1m = { value: null, unit: '' }; }

  // Uptime
  try {
    const uptime = fs.readFileSync('/proc/uptime', 'utf8');
    metrics.uptime = { value: parseFloat(uptime.split(/\s+/)[0]), unit: 'seconds' };
  } catch { metrics.uptime = { value: null, unit: 'seconds' }; }

  // CPU stat ticks (for iowait calculation via delta between runs)
  try {
    const procStat = fs.readFileSync('/proc/stat', 'utf8');
    const cpuLine = procStat.split('\n').find(l => l.startsWith('cpu '));
    if (cpuLine) {
      // Fields: user nice system idle iowait irq softirq steal
      const fields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      metrics.cpu_user_ticks = { value: fields[0], unit: 'ticks' };
      metrics.cpu_nice_ticks = { value: fields[1], unit: 'ticks' };
      metrics.cpu_system_ticks = { value: fields[2], unit: 'ticks' };
      metrics.cpu_idle_ticks = { value: fields[3], unit: 'ticks' };
      metrics.cpu_iowait_ticks = { value: fields[4], unit: 'ticks' };
    }
  } catch { /* ok */ }

  // CPU frequency
  try {
    const curFreq = parseInt(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8')) / 1000;
    const maxFreq = parseInt(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq', 'utf8')) / 1000;
    metrics.cpu_freq = { value: curFreq, unit: 'MHz' };
    metrics.cpu_max_freq = { value: maxFreq, unit: 'MHz' };
  } catch { metrics.cpu_freq = { value: null, unit: 'MHz' }; }

  // CPU core count (for normalizing load average against capacity)
  try {
    metrics.cpu_cores = { value: os.cpus().length, unit: 'count' };
  } catch { metrics.cpu_cores = { value: null, unit: 'count' }; }

  // CPU throttling
  try {
    const throttled = execSync('vcgencmd get_throttled', { encoding: 'utf8', timeout: 3000 }).trim();
    const throttleHex = parseInt(throttled.split('=')[1], 16);
    metrics.cpu_throttled = { value: throttleHex, unit: 'bitmask' };
  } catch { metrics.cpu_throttled = { value: null, unit: 'bitmask' }; }

  // Under-voltage detection
  try {
    const underVoltage = parseInt(fs.readFileSync('/sys/class/hwmon/hwmon2/in0_lcrit_alarm', 'utf8').trim());
    metrics.under_voltage = { value: underVoltage, unit: 'boolean' };
  } catch { metrics.under_voltage = { value: null, unit: 'boolean' }; }

  // Network I/O
  try {
    const netDev = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of netDev.split('\n')) {
      const m = line.match(/^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (m && (m[1] === 'eth0' || m[1] === 'tailscale0')) {
        metrics[`net_rx_bytes_${m[1]}`] = { value: parseInt(m[2]), unit: 'bytes' };
        metrics[`net_tx_bytes_${m[1]}`] = { value: parseInt(m[3]), unit: 'bytes' };
      }
    }
  } catch { /* ok */ }

  // Disk I/O (SD card)
  try {
    const stat = fs.readFileSync('/sys/block/mmcblk0/stat', 'utf8').trim().split(/\s+/);
    metrics.disk_read_bytes_sd = { value: parseInt(stat[2]) * 512, unit: 'bytes' };
    metrics.disk_write_bytes_sd = { value: parseInt(stat[6]) * 512, unit: 'bytes' };
  } catch { /* ok */ }

  // Cloudflare Tunnel status
  try {
    const cfStatus = execSync('systemctl is-active cloudflared', { encoding: 'utf8', timeout: 3000 }).trim();
    metrics.cloudflared_active = { value: cfStatus === 'active' ? 1 : 0, unit: 'boolean' };
  } catch { metrics.cloudflared_active = { value: 0, unit: 'boolean' }; }

  // Disk usage - SD card
  try {
    const df = execSync('df --output=source,size,used,avail,pcent /dev/mmcblk0p2 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const lines = df.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      metrics.disk_used_pct_sd = { value: parseFloat(parts[4]), unit: 'percent' };
      metrics.disk_total_sd = { value: parseInt(parts[1]) * 1024, unit: 'bytes' };
      metrics.disk_used_sd = { value: parseInt(parts[2]) * 1024, unit: 'bytes' };
      metrics.disk_avail_sd = { value: parseInt(parts[3]) * 1024, unit: 'bytes' };
    }
  } catch { metrics.disk_used_pct_sd = { value: null, unit: 'percent' }; }

  return { timestamp, host: 'control-node', metrics };
}

function safeFloat(str) {
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function safeInt(str) {
  const n = parseInt(str);
  return isNaN(n) ? null : n;
}

function parseSSHOutput(output) {
  const sections = output.split('---\n');
  const metrics = {};

  // Section 0: CPU temp — one `type\ttemp` line per remote thermal zone (see
  // buildZoneEnumerateShellSnippet / scripts/nas-collect.sh), selected the
  // same way as the local read: by declared type, never by zone index
  // (issue #5). value stays null (never a false 0°C) when nothing resolves.
  try {
    const zones = parseZoneEnumerateOutput(sections[0]);
    metrics.cpu_temp = { value: selectCpuTempC(zones).value, unit: 'celsius' };
  } catch { metrics.cpu_temp = { value: null, unit: 'celsius' }; }

  // Section 1: meminfo
  try {
    const meminfo = sections[1] || '';
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
    const total = totalMatch ? parseInt(totalMatch[1]) * 1024 : null;
    const available = availMatch ? parseInt(availMatch[1]) * 1024 : null;
    if (total != null && total > 0 && available != null) {
      const used = total - available;
      metrics.mem_used_pct = { value: (used / total) * 100, unit: 'percent' };
      metrics.mem_total = { value: total, unit: 'bytes' };
      metrics.mem_available = { value: available, unit: 'bytes' };
      metrics.mem_available_mb = { value: Math.round(available / (1024 * 1024)), unit: 'MB' };
    } else {
      metrics.mem_used_pct = { value: null, unit: 'percent' };
    }
    // Swap
    const swapTotalMatch = meminfo.match(/SwapTotal:\s+(\d+)/);
    const swapFreeMatch = meminfo.match(/SwapFree:\s+(\d+)/);
    const swapTotal = swapTotalMatch ? parseInt(swapTotalMatch[1]) * 1024 : null;
    const swapFree = swapFreeMatch ? parseInt(swapFreeMatch[1]) * 1024 : null;
    if (swapTotal != null) {
      metrics.swap_total = { value: swapTotal, unit: 'bytes' };
      metrics.swap_free = { value: swapFree || 0, unit: 'bytes' };
      metrics.swap_used_pct = { value: swapTotal > 0 ? ((swapTotal - (swapFree || 0)) / swapTotal) * 100 : 0, unit: 'percent' };
    }
  } catch { metrics.mem_used_pct = { value: null, unit: 'percent' }; }

  // Section 2: df output
  try {
    const df = sections[2] || '';
    const lines = df.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts[0]?.includes('mmcblk0')) {
        const pct = safeFloat(parts[4]);
        const total = safeInt(parts[1]);
        const used = safeInt(parts[2]);
        const avail = safeInt(parts[3]);
        if (pct != null) metrics.disk_used_pct_sd = { value: pct, unit: 'percent' };
        if (total != null) metrics.disk_total_sd = { value: total * 1024, unit: 'bytes' };
        if (used != null) metrics.disk_used_sd = { value: used * 1024, unit: 'bytes' };
        if (avail != null) metrics.disk_avail_sd = { value: avail * 1024, unit: 'bytes' };
      } else if (parts[0]?.includes('sda')) {
        const pct = safeFloat(parts[4]);
        const total = safeInt(parts[1]);
        const used = safeInt(parts[2]);
        const avail = safeInt(parts[3]);
        if (pct != null) metrics.disk_used_pct_nas = { value: pct, unit: 'percent' };
        if (total != null) metrics.disk_total_nas = { value: total * 1024, unit: 'bytes' };
        if (used != null) metrics.disk_used_nas = { value: used * 1024, unit: 'bytes' };
        if (avail != null) metrics.disk_avail_nas = { value: avail * 1024, unit: 'bytes' };
      }
    }
  } catch { /* partial failure ok */ }

  // Section 3: loadavg
  try {
    const loadavg = (sections[3] || '').trim().split(/\s+/);
    const l1 = safeFloat(loadavg[0]);
    const l5 = safeFloat(loadavg[1]);
    const l15 = safeFloat(loadavg[2]);
    metrics.load_1m = { value: l1, unit: '' };
    metrics.load_5m = { value: l5, unit: '' };
    metrics.load_15m = { value: l15, unit: '' };
  } catch { metrics.load_1m = { value: null, unit: '' }; }

  // Section 4: uptime
  try {
    metrics.uptime = { value: parseFloat((sections[4] || '').trim().split(/\s+/)[0]), unit: 'seconds' };
    if (isNaN(metrics.uptime.value)) metrics.uptime.value = null;
  } catch { metrics.uptime = { value: null, unit: 'seconds' }; }

  // Section 5: TM sparsebundle mtime (epoch seconds)
  try {
    const mtime = parseInt((sections[5] || '').trim());
    if (!isNaN(mtime)) {
      metrics.tm_last_backup = { value: mtime, unit: 'epoch' };
    }
  } catch { /* ok */ }

  // Section 6: TM sparsebundle size (bytes)
  try {
    const parts = (sections[6] || '').trim().split(/\s+/);
    const size = parseInt(parts[0]);
    if (!isNaN(size)) {
      metrics.tm_size = { value: size, unit: 'bytes' };
    }
  } catch { /* ok */ }

  // Section 7: latest munin backup filename
  try {
    const filename = (sections[7] || '').trim();
    if (filename && filename !== 'N/A') {
      metrics.munin_backup_latest = { value: null, unit: 'text', metadata: { filename } };
    }
  } catch { /* ok */ }

  // Section 8: munin backup count
  try {
    const count = parseInt((sections[8] || '').trim());
    if (!isNaN(count)) {
      metrics.munin_backup_count = { value: count, unit: 'count' };
    }
  } catch { /* ok */ }

  // Section 9: mimir backup log last line
  try {
    const line = (sections[9] || '').trim();
    if (line && line !== 'N/A') {
      metrics.mimir_backup_last = { value: null, unit: 'text', metadata: { line } };
    }
  } catch { /* ok */ }

  // Section 10: Newest file mtime in mgc artifacts (epoch seconds)
  try {
    const mtime = Math.floor(parseFloat((sections[10] || '').trim()));
    if (!isNaN(mtime) && mtime > 0) {
      metrics.mimir_sync_latest = { value: mtime, unit: 'epoch' };
    }
  } catch { /* ok */ }

  // Section 11: CPU frequency (kHz)
  try {
    const freq = safeFloat((sections[11] || '').trim());
    if (freq != null) metrics.cpu_freq = { value: freq / 1000, unit: 'MHz' };
  } catch { /* ok */ }

  // Section 12: Throttle status
  try {
    const line = (sections[12] || '').trim();
    const match = line.match(/throttled=(0x[0-9a-fA-F]+)/);
    if (match) metrics.cpu_throttled = { value: parseInt(match[1], 16), unit: 'bitmask' };
  } catch { /* ok */ }

  // Section 13: Under-voltage
  try {
    const uv = safeInt((sections[13] || '').trim());
    if (uv != null) metrics.under_voltage = { value: uv, unit: 'boolean' };
  } catch { /* ok */ }

  // Section 14: Network stats (/proc/net/dev)
  try {
    const netDev = sections[14] || '';
    for (const line of netDev.trim().split('\n')) {
      const m = line.match(/^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (m && (m[1] === 'eth0' || m[1] === 'tailscale0')) {
        metrics[`net_rx_bytes_${m[1]}`] = { value: parseInt(m[2]), unit: 'bytes' };
        metrics[`net_tx_bytes_${m[1]}`] = { value: parseInt(m[3]), unit: 'bytes' };
      }
    }
  } catch { /* ok */ }

  // Section 15: Block device stats (SD card)
  try {
    const stat = (sections[15] || '').trim().split(/\s+/);
    if (stat.length >= 7) {
      metrics.disk_read_bytes_sd = { value: parseInt(stat[2]) * 512, unit: 'bytes' };
      metrics.disk_write_bytes_sd = { value: parseInt(stat[6]) * 512, unit: 'bytes' };
    }
  } catch { /* ok */ }

  // Section 16: Block device stats (NAS drive)
  try {
    const stat = (sections[16] || '').trim().split(/\s+/);
    if (stat.length >= 7) {
      metrics.disk_read_bytes_nas = { value: parseInt(stat[2]) * 512, unit: 'bytes' };
      metrics.disk_write_bytes_nas = { value: parseInt(stat[6]) * 512, unit: 'bytes' };
    }
  } catch { /* ok */ }

  // Section 17: CPU stat line (for iowait)
  try {
    const cpuLine = (sections[17] || '').trim();
    if (cpuLine.startsWith('cpu ')) {
      const fields = cpuLine.split(/\s+/).slice(1).map(Number);
      metrics.cpu_user_ticks = { value: fields[0], unit: 'ticks' };
      metrics.cpu_nice_ticks = { value: fields[1], unit: 'ticks' };
      metrics.cpu_system_ticks = { value: fields[2], unit: 'ticks' };
      metrics.cpu_idle_ticks = { value: fields[3], unit: 'ticks' };
      metrics.cpu_iowait_ticks = { value: fields[4], unit: 'ticks' };
    }
  } catch { /* ok */ }

  // Section 18: CPU core count
  try {
    const cores = safeInt((sections[18] || '').trim());
    if (cores != null && cores > 0) metrics.cpu_cores = { value: cores, unit: 'count' };
  } catch { /* ok */ }

  return metrics;
}

// NAS-side filesystem locations probed for backup/sync freshness.
// These MUST track the real infra. They have drifted before (the 2026-04-27
// munin-backup relocation; an artifacts/mgc → mimir/ sync-path change) and
// silently froze the staleness alerts, producing false criticals. The
// metrics-probe test locks them so a future move is caught at test time.
const NAS_PROBE_PATHS = {
  // Munin SQLite backups — relocated to the external HDD on 2026-04-27.
  muninBackupDir: '/mnt/timemachine/backups/munin-memory/',
  // Heartbeat written by the laptop mimir-sync daemon after each successful
  // push (run freshness). Lives OUTSIDE the mirrored tree so `rsync --delete`
  // can't remove it. Falls back to newest-content mtime if the stamp is absent.
  mimirSyncStamp: '/home/heimdall/mimir-sync.stamp',
  mimirSyncDir: '/home/heimdall/mimir/',
};

function buildNASProbeCommand(paths = NAS_PROBE_PATHS) {
  return [
    // Section 0: enumerate every thermal zone as `type<TAB>temp` (one line
    // each) instead of assuming thermal_zone0 is the CPU sensor — that index
    // is not stable across reboots (issue #5). parseSSHOutput selects by
    // declared type via the shared src/thermal.js logic.
    buildZoneEnumerateShellSnippet(),
    'echo "---"',
    'cat /proc/meminfo',
    'echo "---"',
    'df --output=source,size,used,avail,pcent /dev/mmcblk0p2 /dev/sda1 2>/dev/null || true',
    'echo "---"',
    'cat /proc/loadavg',
    'echo "---"',
    'cat /proc/uptime',
    'echo "---"',
    'stat -c "%Y" "/mnt/timemachine/Workstation.sparsebundle/com.apple.TimeMachine.SnapshotHistory.plist" 2>/dev/null || echo ""',
    'echo "---"',
    'du -sb "/mnt/timemachine/Workstation.sparsebundle/" 2>/dev/null || echo ""',
    'echo "---"',
    `ls ${paths.muninBackupDir} 2>/dev/null | tail -1`,  // Section 7: latest munin backup filename
    'echo "---"',
    `ls ${paths.muninBackupDir} 2>/dev/null | wc -l`,  // Section 8: munin backup count
    'echo "---"',
    'tail -1 /home/heimdall/mimir-server/backup.log 2>/dev/null || echo ""',
    'echo "---"',
    // Section 10: sync run freshness — heartbeat stamp (epoch) preferred,
    // fall back to newest content mtime in the mirrored tree.
    `cat ${paths.mimirSyncStamp} 2>/dev/null || find ${paths.mimirSyncDir} -type f -printf "%T@\\n" 2>/dev/null | sort -rn | head -1 || echo ""`,
    'echo "---"',
    'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo ""',  // Section 11: CPU frequency
    'echo "---"',
    'vcgencmd get_throttled 2>/dev/null || echo ""',  // Section 12: Throttle status
    'echo "---"',
    'cat /sys/class/hwmon/hwmon2/in0_lcrit_alarm 2>/dev/null || echo ""',  // Section 13: Under-voltage
    'echo "---"',
    'cat /proc/net/dev 2>/dev/null',  // Section 14: Network stats
    'echo "---"',
    'cat /sys/block/mmcblk0/stat 2>/dev/null || echo ""',  // Section 15: Block device stats (SD)
    'echo "---"',
    'cat /sys/block/sda/stat 2>/dev/null || echo ""',  // Section 16: Block device stats (NAS drive)
    'echo "---"',
    'head -1 /proc/stat 2>/dev/null || echo ""',  // Section 17: CPU stat line (for iowait)
    'echo "---"',
    'nproc 2>/dev/null || echo ""',  // Section 18: CPU core count
  ].join('\n');
}

function collectRemoteViaSSH(sshKeyPath, nasIP) {
  if (!isValidHost(nasIP)) {
    throw new Error(`Invalid NAS IP address: ${nasIP}`);
  }
  const command = buildNASProbeCommand();

  const knownHostsFile = path.join(os.homedir(), '.heimdall', 'known_hosts');
  const sshUser = process.env.HEIMDALL_STORAGE_SSH_USER || 'heimdall';
  if (!/^[a-zA-Z0-9._-]+$/.test(sshUser)) throw new Error('Invalid storage SSH user');
  const sshCommand = `ssh -i ${sshKeyPath} -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile} -o BatchMode=yes ${sshUser}@${nasIP} '${command.replace(/'/g, "'\\''")}'`;

  const output = execSync(sshCommand, { encoding: 'utf8', timeout: 15000 });
  return output;
}

function ping(host, timeoutSec) {
  if (!isValidHost(host)) {
    throw new Error(`Invalid ping host: ${host}`);
  }
  try {
    execSync(`ping -c 1 -W ${timeoutSec} ${host} 2>/dev/null`, { timeout: (timeoutSec + 2) * 1000 });
    return true;
  } catch {
    return false;
  }
}

function checkInternetConnectivity() {
  // Ping a reliable public DNS to check internet connectivity
  return ping('1.1.1.1', 3);
}

/**
 * Parse ping output to extract avg RTT (ms) and packet loss (%).
 * Returns { avgRtt: number|null, lossPct: number|null }
 */
function parsePingOutput(output) {
  let avgRtt = null;
  let lossPct = null;
  try {
    const lossMatch = output.match(/(\d+(?:\.\d+)?)% packet loss/);
    if (lossMatch) lossPct = parseFloat(lossMatch[1]);
    const rttMatch = output.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)\//);
    if (rttMatch) avgRtt = parseFloat(rttMatch[1]);
  } catch { /* ok */ }
  return { avgRtt, lossPct };
}

/**
 * Collect network quality metrics: latency and packet loss to NAS and internet.
 * Uses 3 packets with 2s timeout to keep collection fast.
 */
function collectNetworkQuality(nasIP) {
  if (!isValidHost(nasIP)) {
    throw new Error(`Invalid NAS IP for network quality: ${nasIP}`);
  }
  const results = {};

  // Ping NAS
  try {
    const nasOutput = execSync(`ping -c 3 -W 2 ${nasIP} 2>&1`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    const nas = parsePingOutput(nasOutput);
    results.net_latency_nas_ms = { value: nas.avgRtt, unit: 'ms' };
    results.net_loss_nas_pct = { value: nas.lossPct, unit: 'percent' };
  } catch (err) {
    // Ping failed entirely (100% loss or timeout)
    const parsed = parsePingOutput(err.stdout || err.stderr || '');
    results.net_latency_nas_ms = { value: parsed.avgRtt, unit: 'ms' };
    results.net_loss_nas_pct = { value: parsed.lossPct != null ? parsed.lossPct : 100, unit: 'percent' };
  }

  // Ping internet (1.1.1.1)
  try {
    const inetOutput = execSync('ping -c 3 -W 2 1.1.1.1 2>&1', {
      encoding: 'utf8',
      timeout: 10000,
    });
    const inet = parsePingOutput(inetOutput);
    results.net_latency_internet_ms = { value: inet.avgRtt, unit: 'ms' };
    results.net_loss_internet_pct = { value: inet.lossPct, unit: 'percent' };
  } catch (err) {
    const parsed = parsePingOutput(err.stdout || err.stderr || '');
    results.net_latency_internet_ms = { value: parsed.avgRtt, unit: 'ms' };
    results.net_loss_internet_pct = { value: parsed.lossPct != null ? parsed.lossPct : 100, unit: 'percent' };
  }

  return results;
}

module.exports = {
  collectLocalMetrics,
  computeCpuBusyPct,
  CPU_TICK_FIELDS,
  parseSSHOutput,
  collectRemoteViaSSH,
  buildNASProbeCommand,
  NAS_PROBE_PATHS,
  ping,
  checkInternetConnectivity,
  collectNetworkQuality,
};
