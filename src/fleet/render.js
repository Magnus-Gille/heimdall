'use strict';

const { pageShell } = require('../render/shell');
const { esc } = require('../render/util');
const { grid, card } = require('../render/cards');
const { machineCard, aggStrip, emptyState } = require('../render/components');
const { deriveState, aggregateCounts } = require('./liveness');
const { getFleetHosts, getLatestFleetMetric, getFleetMetricSeries } = require('../db');

// critical → warning → stale → healthy, then alphabetical
const STATE_RANK = { offline: 0, stale: 1, sleeping: 2, online: 3 };

/** Build the view-model array (host config + latest metric + derived state). */
function buildMachines(db, now, thresholds) {
  const hosts = getFleetHosts(db);
  const machines = hosts.map((h) => {
    const m = getLatestFleetMetric(db, h.hostname) || {};
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
  const machines = buildMachines(db, now, thresholds);
  const visible = opts.exceptionsOnly
    ? machines.filter((m) => m.state === 'offline' || m.state === 'stale')
    : machines;
  const counts = aggregateCounts(machines.map((m) => m.state));
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
      ${fleetGridFragment(db, now, thresholds)}
    </div>`;
  return pageShell({
    title: 'Heimdall — Fleet',
    active: '/fleet',
    gitVersion,
    content,
    charts: true,
  });
}

module.exports = { buildMachines, fleetGridFragment, fleetPage, STATE_RANK };
