'use strict';

const { pageShell } = require('../render/shell');
const { esc } = require('../render/util');
const { grid, card } = require('../render/cards');
const { machineCard, aggStrip, emptyState } = require('../render/components');
const { deriveDisplayState, shouldAlert } = require('./liveness');
const { getFleetHosts, getLatestFleetMetric, getFleetMetricSeries } = require('../db');
const { shortCommit } = require('../version');

// critical → warning → stale → healthy, then alphabetical
const STATE_RANK = {
  offline: 0,
  'never-seen': 1,
  stale: 2,
  sleeping: 3,
  online: 4,
  'retired-unregistered': 5,
};

function displayAgentVersion(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function comparableAgentVersion(value) {
  const text = displayAgentVersion(value);
  if (!text || text.toLowerCase() === 'unknown') return null;
  return shortCommit(text);
}

/**
 * The drift baseline is the runtime Heimdall checkout version currently serving
 * the UI. When that runtime version is not a real commit (for example `dev`),
 * drift is not knowable and must stay `unknown`.
 */
function agentVersionDriftState(agentVersion, baselineVersion) {
  const current = comparableAgentVersion(agentVersion);
  const baseline = comparableAgentVersion(baselineVersion);
  if (!current || !baseline) return 'unknown';
  return current === baseline ? 'current' : 'drift';
}

function isFleetException(machine) {
  return isActiveMachine(machine) && isMonitoredMachine(machine) && (machine.state === 'offline'
    || (machine.state === 'never-seen' && machine.alertable !== false)
    || machine.state === 'stale'
    || machine.agentVersionState === 'drift');
}

function isActiveMachine(machine) {
  return machine.active !== false
    && machine.membership !== 'retired-unregistered'
    && machine.membership_state !== 'retired'
    && machine.state !== 'retired-unregistered';
}

/** Registry monitoring policy, kept separate from the machine's current state. */
function isMonitoredMachine(machine) {
  return machine.monitored !== false;
}

function aggregateMachineCounts(machines = []) {
  const counts = { ok: 0, warn: 0, crit: 0, stale: 0 };
  for (const machine of machines) {
    if (!isActiveMachine(machine) || !isMonitoredMachine(machine)) continue;
    if (machine.state === 'offline' || (machine.state === 'never-seen' && machine.alertable !== false)) counts.crit += 1;
    else if (machine.state === 'never-seen') counts.stale += 1;
    else if (machine.state === 'sleeping') counts.stale += 1;
    else if (machine.state === 'stale' || machine.agentVersionState === 'drift') counts.warn += 1;
    else counts.ok += 1;
  }
  return counts;
}

/** Build the view-model array (host config + latest metric + derived state). */
function buildMachines(db, now, thresholds, opts = {}) {
  const baselineVersion = opts && typeof opts === 'object' ? opts.baselineVersion : null;
  const hosts = getFleetHosts(db);
  const machines = hosts.map((h) => {
    const m = getLatestFleetMetric(db, h.hostname) || {};
    // Alias telemetry is retained under its reported hostname. For a renamed
    // configured host, the canonical card still needs the latest observed age
    // without rewriting the historical metric series.
    const hostLastSeen = [h.last_seen, m.received_at]
      .filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    const retired = h.membership_state === 'retired' || h.membership_state === 'retired-unregistered';
    const active = !retired;
    const agentVersion = displayAgentVersion(m.agent_version ?? h.agent_version ?? null);
    const state = deriveDisplayState({ ...h, last_seen: hostLastSeen }, now, thresholds);
    let spark = [];
    try { spark = getFleetMetricSeries(db, h.hostname, 'cpu_pct', 30); } catch { /* ignore */ }
    let tempSpark = [];
    try { tempSpark = getFleetMetricSeries(db, h.hostname, 'temp_cpu_c', 30); } catch { /* ignore */ }
    return {
      hostname: h.hostname,
      label: h.label || h.hostname,
      ip: h.ip,
      platform: h.platform,
      membership: retired ? 'retired-unregistered' : (h.membership_state || 'observed'),
      active,
      aliasOf: h.alias_of || null,
      always_on: h.always_on,
      monitored: h.always_on === true || h.always_on === 1,
      state,
      cpu_pct: m.cpu_pct,
      ram_used_pct: m.ram_used_pct,
      ram_used_mb: m.ram_used_mb,
      ram_total_mb: m.ram_total_mb,
      temp_cpu_c: m.temp_cpu_c,
      uptime_s: m.uptime_s,
      lastSeen: hostLastSeen,
      lastSeenAgeS: hostLastSeen ? Math.max(0, (now - Date.parse(hostLastSeen)) / 1000) : null,
      reportedHostname: m.hostname && m.hostname !== h.hostname ? m.hostname : null,
      agentVersion,
      agentVersionState: agentVersionDriftState(agentVersion, baselineVersion),
      alertable: shouldAlert(state, { ...h, membership_state: retired ? 'retired' : h.membership_state }),
      spark,
      tempSpark,
    };
  });
  machines.sort((a, b) =>
    ((STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99)) || a.hostname.localeCompare(b.hostname));
  return machines;
}

/** The refreshing grid fragment: aggregate strip + machine cards. */
function fleetGridFragment(db, now, thresholds, opts = {}) {
  const machines = buildMachines(db, now, thresholds, { baselineVersion: opts.baselineVersion });
  const visible = opts.exceptionsOnly
    ? machines.filter(isFleetException)
    // A renamed reporter is provenance on its canonical card, not a second
    // physical-machine card. Keep genuinely unregistered history visible.
    : machines.filter((machine) => isActiveMachine(machine) || !machine.aliasOf);
  const counts = aggregateMachineCounts(machines);
  const activeMachines = machines.filter(isActiveMachine);
  const aggCard = card({
    fullWidth: true,
    body: `<div class="card-head"><span class="card-title">Fleet</span></div>${aggStrip(counts)}`,
  });
  if (!activeMachines.length) {
    if (machines.length && !opts.exceptionsOnly) {
      return grid([
        aggCard,
        card({ fullWidth: true, body: emptyState('No active fleet members. Retained historical rows are shown below.', '🛰') }),
        ...machines.map(machineCard),
      ]);
    }
    const message = machines.length
      ? 'No active fleet members.'
      : 'No machines are configured or have reported yet — start the agent on a host.';
    return grid([aggCard, card({ fullWidth: true, body: emptyState(message, '🛰') })]);
  }
  if (!visible.length) {
    return grid([aggCard, card({ fullWidth: true, body: emptyState('No fleet exceptions.', '✓') })]);
  }
  return grid([aggCard, ...visible.map(machineCard)]);
}

/** Full /fleet page (renders the grid inline, then refreshes it every 30s). */
function fleetPage(gitVersion, db, now, thresholds) {
  const hostnames = buildMachines(db, now, thresholds)
    .filter(isActiveMachine)
    .map((m) => m.hostname);
  // NOTE: the chart card lives OUTSIDE the hx-swap grid div below — that div
  // is replaced wholesale every 30s, which would destroy the Chart.js
  // instance if the canvas were inside it.
  const content = `
    <div class="page-head">
      <h1 class="page-title">Fleet</h1>
      <p class="page-sub">Grimnir's node registry is authoritative; reporting aliases resolve onto canonical cards and unregistered telemetry remains historical. Green ✓ online · amber ▲ stale · red ● offline · grey ? informational/never seen.</p>
    </div>
    <div class="card" style="margin-bottom: var(--space-4)">
      <div class="card-head"><span class="card-title">Temperature — last 24h</span></div>
      <div class="fleet-temp-chart-wrap"><canvas id="fleet-temp-chart" height="260" data-hosts="${esc(JSON.stringify(hostnames))}"></canvas></div>
    </div>
    <div hx-get="/api/fleet/grid" hx-trigger="every 30s" hx-swap="innerHTML">
      ${fleetGridFragment(db, now, thresholds, { baselineVersion: gitVersion })}
    </div>`;
  return pageShell({
    title: 'Heimdall — Fleet',
    active: '/fleet',
    gitVersion,
    content,
    charts: true,
  });
}

module.exports = {
  buildMachines, fleetGridFragment, fleetPage, STATE_RANK,
  agentVersionDriftState, aggregateMachineCounts, isFleetException, isActiveMachine, isMonitoredMachine,
};
