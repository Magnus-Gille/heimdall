'use strict';

const { pageShell } = require('../render/shell');
const { esc } = require('../render/util');
const { grid, card } = require('../render/cards');
const { machineCard, aggStrip, emptyState } = require('../render/components');
const { deriveState } = require('./liveness');
const { getFleetHosts, getLatestFleetMetric, getFleetMetricSeries } = require('../db');
const { shortCommit } = require('../version');

// critical → warning → stale → healthy, then alphabetical
const STATE_RANK = { offline: 0, stale: 1, sleeping: 2, online: 3 };

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
  return machine.state === 'offline'
    || machine.state === 'stale'
    || machine.agentVersionState === 'drift';
}

function aggregateMachineCounts(machines = []) {
  const counts = { ok: 0, warn: 0, crit: 0, stale: 0 };
  for (const machine of machines) {
    if (machine.state === 'offline') counts.crit += 1;
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
    const agentVersion = displayAgentVersion(m.agent_version ?? h.agent_version ?? null);
    let spark = [];
    try { spark = getFleetMetricSeries(db, h.hostname, 'cpu_pct', 30); } catch { /* ignore */ }
    let tempSpark = [];
    try { tempSpark = getFleetMetricSeries(db, h.hostname, 'temp_cpu_c', 30); } catch { /* ignore */ }
    return {
      hostname: h.hostname,
      label: h.label || h.hostname,
      ip: h.ip,
      platform: h.platform,
      state: deriveState(h, now, thresholds),
      cpu_pct: m.cpu_pct,
      ram_used_pct: m.ram_used_pct,
      ram_used_mb: m.ram_used_mb,
      ram_total_mb: m.ram_total_mb,
      temp_cpu_c: m.temp_cpu_c,
      uptime_s: m.uptime_s,
      lastSeen: h.last_seen,
      agentVersion,
      agentVersionState: agentVersionDriftState(agentVersion, baselineVersion),
      spark,
      tempSpark,
    };
  });
  machines.sort((a, b) =>
    (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.hostname.localeCompare(b.hostname));
  return machines;
}

/** The refreshing grid fragment: aggregate strip + machine cards. */
function fleetGridFragment(db, now, thresholds, opts = {}) {
  const machines = buildMachines(db, now, thresholds, { baselineVersion: opts.baselineVersion });
  const visible = opts.exceptionsOnly
    ? machines.filter(isFleetException)
    : machines;
  const counts = aggregateMachineCounts(machines);
  const aggCard = card({
    fullWidth: true,
    body: `<div class="card-head"><span class="card-title">Fleet</span></div>${aggStrip(counts)}`,
  });
  if (!machines.length) {
    return grid([aggCard, card({ fullWidth: true, body: emptyState('No machines have reported yet — start the agent on a host.', '🛰') })]);
  }
  if (!visible.length) {
    return grid([aggCard, card({ fullWidth: true, body: emptyState('No fleet exceptions.', '✓') })]);
  }
  return grid([aggCard, ...visible.map(machineCard)]);
}

/** Full /fleet page (renders the grid inline, then refreshes it every 30s). */
function fleetPage(gitVersion, db, now, thresholds) {
  const hostnames = getFleetHosts(db).map((h) => h.hostname);
  // NOTE: the chart card lives OUTSIDE the hx-swap grid div below — that div
  // is replaced wholesale every 30s, which would destroy the Chart.js
  // instance if the canvas were inside it.
  const content = `
    <div class="page-head">
      <h1 class="page-title">Fleet</h1>
      <p class="page-sub">Every machine that pushes telemetry — CPU, RAM, temperature, uptime. Green ✓ online · amber ▲ stale · red ● offline · grey ? sleeping.</p>
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
  agentVersionDriftState, aggregateMachineCounts, isFleetException,
};
