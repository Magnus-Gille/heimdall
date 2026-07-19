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
const { buildMachines, fleetGridFragment } = require('../fleet/render');
const { aggregateCounts } = require('../fleet/liveness');
const {
  servicesGridFragment, serviceView, isActionableServiceException,
} = require('./service-page');

/**
 * Pure: roll fleet + services + alerts into the overview KPI view-model.
 * `machines` are already-derived fleet view-models (have `.state`); `snapshots`
 * are service snapshot rows (run through serviceView); `alertCount` is the number
 * of unresolved alerts.
 */
function buildOverviewStatus({ machines = [], snapshots = [], alertCount = 0, versions = [] } = {}) {
  const fleetCounts = aggregateCounts(machines.map((m) => m.state));
  const fleetTotal = machines.length;
  const fleetOnline = fleetCounts.ok;
  const fleetOffline = fleetCounts.crit; // offline (always_on machines) → crit
  const fleetStale = fleetCounts.warn;   // late telemetry — NOT the benign "sleeping" bucket

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
  for (const ver of versions) {
    const b = Number(ver.commits_behind);
    if (Number.isFinite(b) && b !== 0) behindServices.add(ver.service);
  }
  const svcDrift = behindServices.size;
  const svcTotal = snapshots.length;

  const count = Number(alertCount) || 0;
  // "Healthy" = nothing genuinely broken. A sleeping laptop and config-only services
  // are expected resting states and do NOT trip the banner.
  const allHealthy = fleetOffline === 0 && fleetStale === 0
    && svcDown === 0 && svcWarn === 0 && count === 0;

  return {
    fleetOnline, fleetOffline, fleetStale, fleetTotal,
    svcOk, svcWarn, svcDown, svcTotal, svcDrift,
    alertCount: count, allHealthy,
  };
}

/** The status-hero fragment (full-width card): banner + KPI row. Self-refreshing. */
function overviewStatusFragment(status) {
  const {
    fleetOnline, fleetOffline, fleetStale, fleetTotal,
    svcOk, svcWarn, svcDown, svcTotal, svcDrift, alertCount, allHealthy,
  } = status;

  // Color only on genuine problems — never on the benign sleeping/config-only gap.
  const fleetState = fleetOffline > 0 ? 'crit' : (fleetStale > 0 ? 'warn' : 'ok');
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
    // Explicit null/undefined is "no count" — Number(null) is 0, so guard before the
    // finite check, else an absent count would masquerade as a real "0 behind".
    const hasCount = v.commits_behind != null && Number.isFinite(raw);
    const behind = hasCount ? raw : 0;
    // Mirror drift.js: a count exists only when BOTH deployed & latest are known.
    let state;
    if (!deployed || !latest) {
      // nothing deployed, or the remote latest couldn't be fetched → can't compare
      state = 'stale';
    } else if (hasCount) {
      // drift.js writes commits_behind = -1 for "behind, count unknown" — any
      // non-zero value means GitHub is ahead, so treat it (not just >0) as drift.
      state = behind !== 0 ? 'warn' : 'ok';
    } else {
      // both commits known but no count recorded → derive from prefix equality
      const eq = deployed.startsWith(latest) || latest.startsWith(deployed);
      state = eq ? 'ok' : 'warn';
    }
    return { service: v.service, host: v.host || null, deployed, latest, behind, state };
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
  if (r.state === 'warn') badgeLabel = r.behind > 0 ? `${r.behind} behind` : 'behind'; // -1 → count unknown
  else if (r.state === 'ok') badgeLabel = 'up to date';
  else badgeLabel = r.deployed ? 'unknown' : 'no data';  // deployed but latest unknown vs nothing deployed
  const commits = r.deployed
    ? `<div class="deploy-commits"><span class="commit">${esc(r.deployed)}</span>${
        r.latest && r.latest !== r.deployed
          ? `<span class="arrow">→</span><span class="commit">${esc(r.latest)}</span>`
          : ''
      }</div>`
    : '';
  return `<div class="card">
    <div class="card-head">
      <span class="card-title">${esc(r.service)}</span>
      ${statusBadge(r.state, badgeLabel)}
    </div>
    ${commits}
    ${r.host ? `<div class="deploy-host mono">${esc(r.host)}</div>` : ''}
  </div>`;
}

/**
 * Deployments grid fragment — used by BOTH the initial page render and the
 * /api/overview/deploys refresh endpoint, so the swapped DOM shape is identical.
 */
function deploysGridFragment(versions = [], opts = {}) {
  const rows = buildDeployRows(versions);
  const visible = opts.exceptionsOnly ? rows.filter((r) => r.state === 'warn') : rows;
  if (!rows.length) {
    return grid([`<div class="card col-full">${emptyState('No deployment data yet')}</div>`]);
  }
  if (!visible.length) {
    return grid([`<div class="card col-full">${emptyState('No deployment drift.', '✓')}</div>`]);
  }
  return grid(visible.map(deployCard));
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

/**
 * Full Overview page. deps: { db, now, thresholds, snapshots, alertCount }.
 * The hero, fleet grid and services grid each refresh independently via their
 * own HTMX endpoints (the fleet/services endpoints already exist).
 */
function overviewPage(gitVersion, deps = {}) {
  const { db, now = Date.now(), thresholds, snapshots = [], alertCount = 0, versions = [] } = deps;
  const machines = buildMachines(db, now, thresholds);
  const status = buildOverviewStatus({ machines, snapshots, alertCount, versions });

  const content = `
    <div class="page-head">
      <h1 class="page-title">Overview</h1>
      <p class="page-sub">Bifröst watch — the whole estate at a glance.</p>
    </div>

    <div hx-get="/api/overview/status" hx-trigger="every 30s" hx-swap="innerHTML">
      ${overviewStatusSection(status)}
    </div>

    ${sectionHead('Fleet attention', '/fleet', 'View fleet')}
    <div hx-get="/api/fleet/grid?mode=exceptions" hx-trigger="every 30s" hx-swap="innerHTML">
      ${fleetGridFragment(db, now, thresholds, { exceptionsOnly: true })}
    </div>

    ${sectionHead('Service attention', '/services', 'View services')}
    <div hx-get="/api/services/grid?mode=exceptions" hx-trigger="every 60s" hx-swap="innerHTML">
      ${servicesGridFragment(snapshots, { exceptionsOnly: true })}
    </div>

    ${sectionHead('Deployment attention')}
    <div hx-get="/api/overview/deploys?mode=exceptions" hx-trigger="every 60s" hx-swap="innerHTML">
      ${deploysGridFragment(versions, { exceptionsOnly: true })}
    </div>`;

  return pageShell({
    title: 'Heimdall — Overview',
    active: '/',
    gitVersion,
    content,
    lastUpdated: true,
  });
}

module.exports = {
  buildOverviewStatus, overviewStatusFragment, overviewStatusSection,
  buildDeployRows, deploysGridFragment, overviewPage,
};
