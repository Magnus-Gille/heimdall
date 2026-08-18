'use strict';

/**
 * overview.js — the v2 landing page (`/`). The Shneiderman "overview" tier:
 * answer "is anything broken?" in <3s, then offer zoom into Fleet and Services.
 *
 * Composed entirely from proven v2 primitives — the fleet grid (fleet/render.js)
 * and the services grid (service-page.js) are reused verbatim, so the Overview is
 * a thin aggregator with zero duplicated rendering logic.
 */

const { pageShell } = require('./shell');
const { grid } = require('./cards');
const { kpi, statusBadge, emptyState } = require('./components');
const { esc } = require('./util');
const {
  buildMachines,
  fleetGridFragment,
  isActiveMachine,
  isMonitoredMachine,
} = require('../fleet/render');
const { aggregateCounts } = require('../fleet/liveness');
const {
  servicesGridFragment, serviceView, isActionableServiceException,
} = require('./service-page');
const { driftStateFromRow } = require('../drift-compare');

/**
 * Pure: roll fleet + services + alerts into the overview KPI view-model.
 * `machines` are already-derived fleet view-models (have `.state`); `snapshots`
 * are service snapshot rows (run through serviceView); `alertCount` is the number
 * of unresolved alerts. When supplied, `overallStatus` is the authoritative
 * database-backed status (including collector completeness/freshness).
 */
function buildOverviewStatus({ machines = [], snapshots = [], alertCount = 0, versions = [], overallStatus = null } = {}) {
  // `fleet_hosts` also retains retired/aliased telemetry rows for history. They
  // are rendered only as explainable historical context and never count as
  // current fleet membership in the overview KPIs.
  const activeMachines = machines.filter(isActiveMachine);
  // Grimnir's node registry owns monitoring policy. Optional nodes remain
  // visible on Fleet, but they are not part of the Overview liveness KPI and
  // cannot turn the system banner red merely because they are quiet or their
  // optional agent is on a different revision.
  const monitoredMachines = activeMachines.filter(isMonitoredMachine);
  // Keep the online KPI about liveness, not agent-version hygiene. A drifted
  // but reporting machine remains online and is counted separately in
  // `fleetDrift`; non-alertable never-seen laptops are equivalent to sleeping
  // for the aggregate strip.
  const fleetCounts = aggregateCounts(monitoredMachines.map((m) => (
    m.state === 'never-seen' && m.alertable === false ? 'sleeping' : m.state
  )));
  const fleetTotal = monitoredMachines.length;
  const fleetOnline = fleetCounts.ok;
  const fleetOffline = fleetCounts.crit; // offline (always_on machines) → crit
  const fleetStale = fleetCounts.warn;   // late telemetry — NOT the benign "sleeping" bucket
  const fleetDrift = monitoredMachines.filter((m) => m.agentVersionState === 'drift').length;

  let svcOk = 0;
  let svcWarn = 0;
  let svcDown = 0;
  // "Behind" is unioned by service name across BOTH drift signals so the hero KPI
  // agrees with the Deployments section below it. Snapshot `deploy.drift` is rarely
  // populated (no descriptor self-reports it today); `service_versions.commits_behind`
  // (the git-drift collector) is the authoritative source the section also renders.
  const behindServices = new Set();
  for (const s of snapshots) {
    const v = serviceView(s);
    if (v.state === 'ok') svcOk += 1;
    // A reachable probe, a real timer last-run, or a pushed status panel is a
    // monitorable outcome. Config-only/never-run entries remain unknown.
    const monitorable = v.reachable
      || v.pushReported
      || (v.kind === 'timer' && v.timer && v.timer.lastRun);
    const actionableStale = v.state === 'stale' && isActionableServiceException(s);
    if ((monitorable && v.state === 'warn') || actionableStale) svcWarn += 1;
    if (monitorable && v.state === 'crit') svcDown += 1;
    if (v.deploy && Number(v.deploy.drift) > 0) behindServices.add(s.service);
  }
  // Drift is counted from the explicit state, never from the raw number. The old
  // `b !== 0` test swept in the `-1` sentinel — which meant "these two values are
  // not equal", including when one of them was never a commit — so five services
  // whose drift is not measurable at all were counted as behind.
  const unmeasurable = new Set();
  for (const ver of versions) {
    const state = driftStateFromRow(ver);
    if (state === 'drift') behindServices.add(ver.service);
    else if (state === 'unknown') unmeasurable.add(ver.service);
  }
  const svcDrift = behindServices.size;
  const svcUnmeasurable = unmeasurable.size;
  const svcTotal = snapshots.length;

  const count = Number(alertCount) || 0;
  // "Healthy" = nothing genuinely broken. A sleeping laptop and config-only services
  // are expected resting states and do NOT trip the banner. Agent-version drift is
  // not an outage, but it is actionable fleet attention and must not be hidden.
  const allHealthy = fleetOffline === 0 && fleetStale === 0 && fleetDrift === 0
    && svcDown === 0 && svcWarn === 0 && count === 0
    && (!overallStatus || overallStatus.state === 'healthy');

  return {
    fleetOnline, fleetOffline, fleetStale, fleetDrift, fleetTotal,
    svcOk, svcWarn, svcDown, svcTotal, svcDrift,
    // A measurement gap is reported, but it is NOT an outage: it must not colour
    // a KPI or trip the "Attention needed" banner.
    svcUnmeasurable,
    alertCount: count, allHealthy,
  };
}

/** The status-hero fragment (full-width card): banner + KPI row. Self-refreshing. */
function overviewStatusFragment(status) {
  const {
    fleetOnline, fleetOffline, fleetStale, fleetDrift, fleetTotal,
    svcOk, svcWarn, svcDown, svcTotal, svcDrift, alertCount, allHealthy,
  } = status;

  // Color only on actionable fleet problems — never on the benign sleeping/config-only gap.
  const fleetState = fleetOffline > 0 ? 'crit' : (fleetStale > 0 || fleetDrift > 0 ? 'warn' : 'ok');
  const svcState = svcDown > 0 ? 'crit' : (svcWarn > 0 ? 'warn' : 'ok');
  const alertState = alertCount > 0 ? 'crit' : 'ok';
  const driftState = svcDrift > 0 ? 'warn' : 'ok';

  const kpis = [
    kpi(`${fleetOnline}/${fleetTotal}`, 'Machines online', fleetState),
    kpi(`${svcOk}/${svcTotal}`, 'Services healthy', svcState),
    kpi(String(alertCount), alertCount === 1 ? 'Active alert' : 'Active alerts', alertState),
    kpi(String(svcDrift), 'Services behind', driftState),
  ].join('');

  const banner = allHealthy
    ? `<div class="overview-banner is-ok"><span class="status-dot is-ok" aria-hidden="true">✓</span> All systems nominal</div>`
    : `<div class="overview-banner is-crit" role="alert"><span class="status-dot is-crit" aria-hidden="true">●</span> Attention needed</div>`;

  return `<div class="card col-full overview-status">
    <div class="card-head"><span class="card-title">System status</span></div>
    ${banner}
    <div class="kpi-row">${kpis}</div>
  </div>`;
}

/**
 * Grid-wrapped status hero. Used by BOTH the initial page render and the
 * /api/overview/status refresh endpoint, so the DOM shape is identical before
 * and after the swap (the `.col-full` card always has its `.grid` parent —
 * no layout shift on refresh).
 */
function overviewStatusSection(status) {
  return grid([overviewStatusFragment(status)]);
}

/**
 * Pure: map `service_versions` rows → compact deploy view-models for the Overview
 * Deployments section. Drift is a *warning* signal (GitHub ahead of what's running),
 * never "broken"; a row with no recorded deployed commit is "unknown" (stale), not crit.
 * Rows are ordered most-interesting-first: drifted, then unknown, then up-to-date,
 * each group alphabetical — so a glance lands on what's behind.
 */
function buildDeployRows(versions = []) {
  const rows = versions.map((v) => {
    const deployed = v.deployed_commit || null;
    const latest = v.latest_commit || null;
    const raw = Number(v.commits_behind);
    // A count exists only when it is a real, NON-NEGATIVE number. The old code
    // accepted -1 here and rendered it as drift; -1 was never a measurement.
    const hasCount = v.commits_behind != null && Number.isFinite(raw) && raw >= 0;
    const behind = hasCount ? raw : null;

    // One source of truth for the verdict (src/drift-compare.js), so the card,
    // the KPI and the alert can never disagree about what a row means.
    const drift = driftStateFromRow(v);
    const state = drift === 'drift' ? 'warn'
      : (drift === 'unknown' ? 'stale' : 'ok');

    return {
      service: v.service,
      host: v.host || null,
      deployed,
      latest,
      behind,
      state,
      drift,
      // Why we cannot answer. Shown on the card so "unknown" is diagnosable
      // rather than mysterious.
      reason: drift === 'unknown'
        ? (v.drift_reason || 'deploy drift is not measurable for this service')
        : null,
    };
  });
  const rank = { warn: 0, stale: 1, ok: 2 };
  return rows.sort((a, b) =>
    (rank[a.state] - rank[b.state])
    || a.service.localeCompare(b.service)
    || (a.host || '').localeCompare(b.host || ''));
}

/** One compact deploy card: service name + drift badge + the running→latest commits. */
function deployCard(r) {
  let badgeLabel;
  if (r.drift === 'drift') badgeLabel = r.behind > 0 ? `${r.behind} behind` : 'behind';
  else if (r.drift === 'ahead') badgeLabel = 'ahead of main';
  else if (r.drift === 'up-to-date') badgeLabel = 'up to date';
  // "not measurable" reads as an instrumentation gap; "unknown"/"no data" read
  // like a problem with the service itself, which is what misled the operator.
  else badgeLabel = 'not measurable';

  const commits = r.deployed
    ? `<div class="deploy-commits"><span class="commit">${esc(r.deployed)}</span>${
        r.latest && r.latest !== r.deployed
          ? `<span class="arrow">→</span><span class="commit">${esc(r.latest)}</span>`
          : ''
      }</div>`
    : '';
  const reason = r.reason ? `<div class="deploy-reason">${esc(r.reason)}</div>` : '';
  return `<div class="card">
    <div class="card-head">
      <span class="card-title">${esc(r.service)}</span>
      ${statusBadge(r.state, badgeLabel)}
    </div>
    ${commits}
    ${reason}
    ${r.host ? `<div class="deploy-host mono">${esc(r.host)}</div>` : ''}
  </div>`;
}

/**
 * Deployments grid fragment — used by BOTH the initial page render and the
 * /api/overview/deploys refresh endpoint, so the swapped DOM shape is identical.
 */
function deploysGridFragment(versions = [], opts = {}) {
  const rows = buildDeployRows(versions);
  if (!rows.length) {
    return grid([`<div class="card col-full">${emptyState('No deployment data yet')}</div>`]);
  }
  if (!opts.exceptionsOnly) return grid(rows.map(deployCard));

  // Default (exceptions) view: a card ONLY for what the owner can act on. The
  // rest collapses to a single quiet line — present, countable, not shouting.
  const visible = rows.filter((r) => r.state === 'warn');
  const okCount = rows.filter((r) => r.state === 'ok').length;
  const unknownCount = rows.filter((r) => r.state === 'stale').length;

  const parts = [];
  if (okCount) parts.push(`${okCount} up to date`);
  if (unknownCount) parts.push(`${unknownCount} not measurable`);
  const summary = parts.length
    ? `<div class="card col-full deploy-summary muted">${esc(parts.join(' · '))}</div>`
    : '';

  if (!visible.length) {
    return grid([
      `<div class="card col-full">${emptyState('No deployment drift.', '✓')}</div>`,
      summary,
    ].filter(Boolean));
  }
  return grid([...visible.map(deployCard), summary].filter(Boolean));
}

/**
 * Jobs that RAN and reported findings.
 *
 * These are deliberately not alerts: nothing is broken, so paging on them would
 * be the same "loud about the wrong thing" failure in a new costume. They are
 * also deliberately not hidden — a finding count is the whole point of running
 * an audit, and burying it behind a red "failed service" badge is why the live
 * grimnir-validate output went unread.
 */
function findingsFromSnapshots(snapshots = []) {
  const out = [];
  for (const s of snapshots) {
    const v = serviceView(s);
    if (v.kind !== 'timer' || v.timerOutcome !== 'findings') continue;
    out.push({ service: v.name, count: v.findings, lastRun: (v.timer && v.timer.lastRun) || null });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

/** One compact line per job with findings. Renders nothing when there are none. */
function findingsFragment(findings = []) {
  if (!findings.length) return '';
  const items = findings.map((f) => `<div class="card">
    <div class="card-head">
      <span class="card-title">${esc(f.service)}</span>
      ${statusBadge('info', f.count != null ? `${f.count} findings` : 'findings')}
    </div>
    <div class="deploy-reason">Completed successfully. Review its report.</div>
  </div>`);
  return grid(items);
}

/** A section heading with an optional "view all →" affordance on the right. */
function sectionHead(title, href, linkLabel) {
  const link = href
    ? `<a href="${esc(href)}" class="page-sub section-link">${esc(linkLabel)} →</a>`
    : '';
  return `<div class="page-head section-head">
    <h2 class="page-title">${esc(title)}</h2>
    ${link}
  </div>`;
}

/** M5 health on Overview comes from the gateway, not the separate machine agent. */
function overviewFleetMachines(machines = []) {
  return machines.filter((machine) => String(machine && machine.hostname).toLowerCase() !== 'm5');
}

/**
 * Full Overview page. deps: { db, now, thresholds, snapshots, alertCount, overallStatus }.
 * The hero, fleet grid and services grid each refresh independently via their
 * own HTMX endpoints (the fleet/services endpoints already exist).
 */
function overviewPage(gitVersion, deps = {}) {
  const {
    db, now = Date.now(), thresholds, snapshots = [], alertCount = 0, versions = [], overallStatus = null,
  } = deps;
  const machines = overviewFleetMachines(buildMachines(db, now, thresholds, { baselineVersion: gitVersion }));
  const status = buildOverviewStatus({ machines, snapshots, alertCount, versions, overallStatus });
  const findings = findingsFromSnapshots(snapshots);

  const content = `
    <div class="page-head">
      <h1 class="page-title">Overview</h1>
      <p class="page-sub">Bifröst watch — the whole estate at a glance.</p>
    </div>

    ${sectionHead('M5 inference', '/services/m5-gateway', 'Models and details')}
    ${grid([`<div class="card col-full" hx-get="/api/plugins/inference/m5-gateway/m5-overview" hx-trigger="load, every 60s" hx-swap="innerHTML">
      <div class="m5-note">Loading M5 usage…</div>
    </div>`])}

    <div hx-get="/api/overview/status" hx-trigger="every 30s" hx-swap="innerHTML">
      ${overviewStatusSection(status)}
    </div>

    ${sectionHead('Fleet attention', '/fleet', 'View fleet')}
    <div hx-get="/api/overview/fleet" hx-trigger="every 30s" hx-swap="innerHTML">
      ${fleetGridFragment(db, now, thresholds, { exceptionsOnly: true, excludeHostnames: ['m5'], baselineVersion: gitVersion })}
    </div>

    ${sectionHead('Service attention', '/services', 'View services')}
    <div hx-get="/api/services/grid?mode=exceptions" hx-trigger="every 60s" hx-swap="innerHTML">
      ${servicesGridFragment(snapshots, { exceptionsOnly: true })}
    </div>

    ${findings.length ? `${sectionHead('Findings')}
    ${findingsFragment(findings)}` : ''}

    ${sectionHead('Deployment attention')}
    <div hx-get="/api/overview/deploys?mode=exceptions" hx-trigger="every 60s" hx-swap="innerHTML">
      ${deploysGridFragment(versions, { exceptionsOnly: true })}
    </div>`;

  return pageShell({
    title: 'Heimdall — Overview',
    active: '/',
    gitVersion,
    content,
    head: `<link rel="stylesheet" href="/css/inference.css?v=${esc(gitVersion || 'dev')}">`,
    lastUpdated: true,
  });
}

module.exports = {
  buildOverviewStatus, overviewStatusFragment, overviewStatusSection,
  buildDeployRows, deploysGridFragment, overviewPage,
  overviewFleetMachines,
  findingsFromSnapshots, findingsFragment,
};
