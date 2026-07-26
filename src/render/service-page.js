'use strict';

/**
 * service-page.js — the ONE generic service renderer. Drives both the /services
 * index (a card per service) and the /services/:name detail page from a stored
 * descriptor snapshot. Service-specific panels (e.g. the M5 inference matrix)
 * are rendered by optional plugins in a later slice; here they show as labelled
 * placeholders.
 */

const { pageShell } = require('./shell');
const { grid, card } = require('./cards');
const {
  statusBadge, serviceStatusHeader, deployBlock, metricRow, emptyState, aggStrip,
} = require('./components');
const { esc, formatAge, formatEta } = require('./util');
const { memoryHealthCard, memoryHealthRollup } = require('./memory-health');
const { statusToState, SCHEMA_ID, isSafeHref } = require('../contract/schema');
const { getPlugin } = require('../plugins');
const { renderTypedPanel } = require('./panels');

// The four native typed-panel kinds rendered by render/panels.js.
const TYPED_KINDS = new Set(['stat', 'timeseries', 'table', 'status']);
const PUSH_STATE = { pass: 'ok', warn: 'warn', fail: 'crit' };
const STATE_RANK = { crit: 0, warn: 1, stale: 2, ok: 3 };
const PUSH_STATUS_STALE_MS = 36 * 60 * 60 * 1000;

/** Map a pushed `panels` db row (data already parsed) to the renderTypedPanel shape. */
function pushedPanelToView(row) {
  const data = (row && row.data && typeof row.data === 'object') ? row.data : {};
  return { panel: row.panel, kind: row.kind, label: row.label, unit: row.unit, ...data };
}

/** Summarise pushed status panels and their freshest observation time. */
function pushedStatusSummary(rows = [], now = Date.now()) {
  const statuses = [];
  let updatedMs = -Infinity;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawTime = row && row.updated_at;
    const ms = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime);
    if (Number.isFinite(ms)) updatedMs = Math.max(updatedMs, ms);
    if (!row || row.kind !== 'status') continue;
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const candidate = PUSH_STATE[data.state];
    if (candidate && Number.isFinite(ms)) statuses.push({ state: candidate, ms });
  }
  const fresh = statuses.filter((s) => now - s.ms <= PUSH_STATUS_STALE_MS);
  let state = null;
  for (const candidate of fresh) {
    if (state == null || STATE_RANK[candidate.state] < STATE_RANK[state]) state = candidate.state;
  }
  const statusUpdatedMs = statuses.reduce((max, s) => Math.max(max, s.ms), -Infinity);
  return {
    hasStatus: statuses.length > 0,
    hasFreshStatus: state != null,
    state,
    updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
    statusUpdatedAt: Number.isFinite(statusUpdatedMs) ? new Date(statusUpdatedMs).toISOString() : null,
  };
}

function unreachableNote(v, pushedSummary) {
  // Timers and static sites are not "unreachable" — they have no probe endpoint
  // by design, and saying otherwise contradicts the pass status right beside it.
  if (v.kind === 'timer') {
    return v.timer && v.timer.lastRun
      ? 'Scheduled job — state comes from its last systemd run, not from a probe.'
      : 'Scheduled job — no run recorded yet.';
  }
  if (pushedSummary.hasFreshStatus) return 'Status reported by pushed panels; no probe endpoint.';
  if (pushedSummary.hasStatus) return 'Last pushed status is stale; no probe endpoint.';
  if (pushedSummary.updatedAt) return 'Panels are reporting, but no status panel or probe endpoint is available.';
  if (v.error === 'unreachable') return 'Service unreachable — showing last-known.';
  return v.source === 'config'
    ? 'Config-only (no live endpoint reached).'
    : 'Service unreachable — showing last-known.';
}

/**
 * Use status-kind pushed panels as the liveness source of last resort. A real
 * reachable probe always wins; pushed product/policy panels must never mask it.
 */
function withPushedStatus(snap, rows = []) {
  if (!snap || snap.reachable) return snap;
  const summary = pushedStatusSummary(rows);
  if (!summary.hasFreshStatus) {
    // Keep evidence that this service used to self-report health. Without this
    // annotation an expired status row collapses back into an indistinguishable
    // config-only unknown and disappears from the exception-only Overview.
    if (!summary.hasStatus) return snap;
    return {
      ...snap,
      pushStatusStale: true,
      pushStatusUpdatedAt: summary.statusUpdatedAt,
    };
  }
  const wireStatus = { ok: 'pass', warn: 'warn', crit: 'fail' }[summary.state];
  return {
    ...snap,
    status: wireStatus,
    fetchedAt: summary.statusUpdatedAt || snap.fetchedAt || snap.fetched_at || null,
    pushReported: true,
    pushStatusStale: false,
    pushStatusUpdatedAt: summary.statusUpdatedAt,
  };
}

/**
 * The value cell for a metric row. When a descriptor publishes a LIVE reading
 * (#108) — a scalar `value` (+ optional `updated_at`) — show the reading with
 * its unit and age. Otherwise fall back to the metric's DEFINITION (its warn/crit
 * thresholds, or bare unit). metricRow() escapes the returned string.
 */
function metricValueDisplay(m) {
  if (m.value != null) {
    const unit = m.unit ? ` ${m.unit}` : '';
    const age = m.updated_at ? ` (${formatAge(m.updated_at)})` : '';
    return `${m.value}${unit}${age}`;
  }
  const thr = m.warn || m.crit
    ? `${m.warn ? 'warn ' + JSON.stringify(m.warn) : ''}${m.crit ? ' crit ' + JSON.stringify(m.crit) : ''}`
    : (m.unit || '');
  return thr || '—';
}

const KIND_RANK = { inference: 0, 'http-service': 1, mcp: 2, timer: 3, static: 4 };

/** Heimdall's own descriptor — dogfoods the contract (served at /heimdall.json). */
function buildSelfDescriptor(gitVersion, opts = {}) {
  return {
    _schema: SCHEMA_ID,
    service: { name: 'heimdall', label: 'Heimdall', namespace: 'grimnir', instance_id: 'control-node', criticality: 'high' },
    kind: 'http-service',
    status: 'pass',
    version: gitVersion,
    deploy: { deployed_commit: gitVersion, host: 'control-node', systemd_unit: 'heimdall', platform: 'bare-metal' },
    metrics: [],
    alerts: { rules: [], active_count: opts.activeAlerts || 0, firing: [] },
    panels: [],
    links: { self: '/heimdall.json', health: '/api/health', repo: 'https://github.com/Magnus-Gille/heimdall' },
    ui: { icon: 'eye', category: 'infra' },
  };
}

/** A self snapshot row (no HTTP round-trip needed — Heimdall knows itself). */
function selfSnapshot(gitVersion, now = Date.now()) {
  const descriptor = buildSelfDescriptor(gitVersion);
  return {
    service: 'heimdall', kind: 'http-service', status: 'pass', descriptor,
    fetchedAt: new Date(now).toISOString(), reachable: true,
    schemaVersion: SCHEMA_ID, source: 'self', error: null,
  };
}

/** Snapshot → render view-model. */
function serviceView(snap) {
  const d = (snap && snap.descriptor) || {};
  const svc = d.service || {};
  const reachable = !!(snap && snap.reachable);
  // Pushed-panels-only services (#102) have no probe archetype — label them
  // honestly rather than defaulting to http-service (also sorts them last).
  const fallbackKind = (snap && snap.source === 'pushed') ? 'panels' : 'http-service';
  const kind = (snap && snap.kind) || d.kind || fallbackKind;
  // Timers have no live endpoint (reachable:false) but DO carry a last-run
  // status (#97) — honour it so a failing timer isn't rendered like a healthy
  // one. Everything else without a live reach is "stale".
  let state;
  if (reachable) state = statusToState(snap.status);
  else if (kind === 'timer' && snap && snap.status) state = statusToState(snap.status);
  else if (snap && snap.pushReported && snap.status) state = statusToState(snap.status);
  else state = 'stale';
  return {
    name: snap ? snap.service : (svc.name || 'unknown'),
    label: svc.label || (snap && snap.service) || 'unknown',
    kind,
    version: d.version || (d.deploy && d.deploy.deployed_commit) || null,
    deploy: d.deploy || null,
    timer: d.timer || null,
    // 'ok' | 'findings' | 'failed' | 'overdue' | 'never-run' (src/timer-outcome.js).
    // The renderer keys on this rather than on `status`, so a job that ran and
    // found things is shown as a finding count instead of a red failed service.
    timerOutcome: (d.timer && typeof d.timer.outcome === 'string') ? d.timer.outcome : null,
    findings: (d.timer && Number.isInteger(d.timer.findings)) ? d.timer.findings : null,
    metrics: Array.isArray(d.metrics) ? d.metrics : [],
    panels: Array.isArray(d.panels) ? d.panels : [],
    panelWarnings: Array.isArray(d.panel_warnings) ? d.panel_warnings : [],
    links: d.links || {},
    alerts: d.alerts || null,
    checks: d.checks || null,
    reachable,
    source: (snap && snap.source) || 'config',
    pushReported: !!(snap && snap.pushReported),
    pushStatusStale: !!(snap && snap.pushStatusStale),
    pushStatusUpdatedAt: (snap && snap.pushStatusUpdatedAt) || null,
    error: (snap && snap.error) || null,
    state,
    // Accept camelCase (fresh poll) or the raw fetched_at column (hydrated DB
    // row) so reachable cards never render "checked never".
    fetchedAt: (snap && (snap.fetchedAt || snap.fetched_at)) || null,
  };
}

function stateLabel(v) {
  // A scheduled job has three meaningful results, not two. "Completed with
  // findings" is the one a pass/fail model destroys: grimnir-validate exits 1 to
  // say it found 2 issues, and rendering that as a crashed service is why nobody
  // read the audit. Findings get their own label and their own (non-red) state.
  if (v.kind === 'timer' && v.timerOutcome) {
    if (v.timerOutcome === 'findings') {
      return v.findings != null ? `${v.findings} findings` : 'Findings';
    }
    if (v.timerOutcome === 'ok') return 'Passed';
    if (v.timerOutcome === 'failed') return 'Failed to run';
    if (v.timerOutcome === 'overdue') return 'Overdue';
    if (v.timerOutcome === 'never-run') return 'Not run yet';
  }
  if (v.kind === 'timer' && v.state !== 'stale') {
    if (v.state === 'ok') return 'Passed';
    if (v.state === 'warn') return 'Stale';
    if (v.state === 'crit') return 'Failed';
  }
  if (v.pushReported) {
    if (v.state === 'ok') return 'Pass';
    if (v.state === 'warn') return 'Warning';
    if (v.state === 'crit') return 'Critical';
  }
  if (v.pushStatusStale) return 'Stale report';
  if (v.error === 'unreachable') return 'Unreachable';
  if (v.source === 'pushed') return 'Pushed'; // panels-only service (#102) — no live endpoint to probe
  if (!v.reachable) return v.source === 'config' && (v.kind === 'timer' || v.kind === 'static') ? 'Config' : 'Unknown';
  if (v.state === 'ok') return 'Healthy';
  if (v.state === 'warn') return 'Warning';
  if (v.state === 'crit') return 'Critical';
  return 'Unknown';
}

/** One card for the /services index. */
function serviceCard(snap) {
  const v = serviceView(snap);
  const driftLine = (v.deploy && v.deploy.drift > 0)
    ? `<div class="machine-sub"><span class="drift behind">${v.deploy.drift} behind</span></div>` : '';
  // `foot` is escaped once by the template below (esc(foot)) — build it raw.
  let foot;
  if (v.kind === 'timer' && v.timer && v.timer.lastRun) {
    foot = `ran ${formatAge(v.timer.lastRun)}`; // #97 — last systemd run
  } else if (v.reachable) {
    foot = `checked ${formatAge(v.fetchedAt)}`;
  } else if (v.pushStatusStale) {
    foot = v.pushStatusUpdatedAt
      ? `reported ${formatAge(v.pushStatusUpdatedAt)} (stale)`
      : 'stale pushed report';
  } else if (v.source === 'pushed') {
    foot = v.fetchedAt ? `pushed ${formatAge(v.fetchedAt)}` : 'pushed panels only';
  } else if (v.kind === 'timer') {
    // A timer has no endpoint by design. Reporting `reachable: 0` as
    // "unreachable" next to `status: pass` is the contradiction the operator hit.
    foot = 'scheduled job — not run yet';
  } else if (v.kind === 'static') {
    foot = 'static site';
  } else {
    foot = v.error === 'unreachable'
      ? 'unreachable'
      : (v.source === 'config' ? 'config only' : 'unreachable');
  }
  const body = `
    <div class="machine-head">
      <span class="machine-name">${esc(v.label)}</span>
      ${statusBadge(v.state, stateLabel(v))}
    </div>
    <div class="machine-sub">
      <span class="mono">${esc(v.kind)}</span>
      ${v.version ? `<span class="tag">${esc(v.version)}</span>` : ''}
    </div>
    ${driftLine}
    <div class="machine-foot"><span>${esc(foot)}</span></div>`;
  return card({ body, href: `/services/${encodeURIComponent(v.name)}`, className: 'machine-card' });
}

function countsFor(snapshots) {
  const counts = { ok: 0, warn: 0, crit: 0, stale: 0 };
  for (const s of snapshots) {
    const v = serviceView(s);
    counts[v.state] = (counts[v.state] || 0) + 1;
  }
  return counts;
}

function sortSnapshots(snapshots) {
  return [...snapshots].sort((a, b) => {
    const va = serviceView(a);
    const vb = serviceView(b);
    const sa = STATE_RANK[va.state] ?? 9;
    const sb = STATE_RANK[vb.state] ?? 9;
    const ka = KIND_RANK[va.kind] ?? 9;
    const kb = KIND_RANK[vb.kind] ?? 9;
    return sa - sb || ka - kb || String(a.service).localeCompare(String(b.service));
  });
}

/**
 * Whether a service belongs on the exception-only surface. Stale evidence is
 * actionable when a status reporter expired or an endpoint-backed service is
 * unreachable/invalid. Deliberate config-only entries (including never-run
 * timers and static entries with no probe) remain quiet unknowns.
 */
function isActionableServiceException(snap) {
  const v = serviceView(snap);
  if (v.state === 'crit' || v.state === 'warn') return true;
  if (v.state !== 'stale') return false;
  if (v.pushStatusStale) return true;
  if (v.error === 'unreachable') return true;
  if (v.reachable) return true;
  return ['descriptor', 'health', 'self'].includes(v.source);
}

/** The refreshing /services grid fragment. */
function servicesGridFragment(snapshots, opts = {}) {
  const sorted = sortSnapshots(snapshots);
  const visible = opts.exceptionsOnly
    ? sorted.filter(isActionableServiceException)
    : sorted;
  const aggCard = card({
    fullWidth: true,
    body: `<div class="card-head"><span class="card-title">Services</span></div>${aggStrip(countsFor(sorted))}`,
  });
  if (!sorted.length) {
    return grid([aggCard, card({ fullWidth: true, body: emptyState('No services discovered yet.', '🧭') })]);
  }
  if (!visible.length) {
    return grid([aggCard, card({ fullWidth: true, body: emptyState('No service exceptions.', '✓') })]);
  }
  return grid([aggCard, ...visible.map(serviceCard)]);
}

/** Full /services index page. */
function servicesIndexPage(gitVersion, snapshots) {
  const content = `
    <div class="page-head">
      <h1 class="page-title">Services</h1>
      <p class="page-sub">Every Grimnir service, discovered from its <code>/heimdall.json</code> descriptor (or degraded to <code>/health</code> / config). One renderer, no per-service code.</p>
    </div>
    <div hx-get="/api/services/grid" hx-trigger="every 60s" hx-swap="innerHTML">
      ${servicesGridFragment(snapshots)}
    </div>`;
  return pageShell({ title: 'Heimdall — Services', active: '/services', gitVersion, content });
}

/** Per-service detail page (generic, archetype-aware). */
function servicePage(gitVersion, snap, pushedPanels = [], memHealth = null, memAttention = null) {
  const pushedSummary = pushedStatusSummary(pushedPanels);
  const v = serviceView(withPushedStatus(snap, pushedPanels));

  // munin-memory's badge reflects memory health (§3.5), not just process-up.
  const badgeState = (v.name === 'munin-memory' && memHealth)
    ? memoryHealthRollup(memHealth)
    : v.state;

  // status header
  const header = card({
    fullWidth: true,
    body: serviceStatusHeader({
      label: v.label, version: v.version, kind: v.kind, state: badgeState,
      checkedAgo: (v.pushStatusStale ? v.pushStatusUpdatedAt : v.fetchedAt)
        ? formatAge(v.pushStatusStale ? v.pushStatusUpdatedAt : v.fetchedAt)
        : null,
      checkedLabel: (v.pushReported || v.pushStatusStale) ? 'reported' : 'checked',
    }) + (v.reachable ? '' : `<div class="machine-sub" style="margin-top:var(--space-2)">${esc(unreachableNote(v, pushedSummary))}</div>`),
  });

  // Memory Health panel — munin-memory only (#73). Renders from the typed
  // fetchMemoryHealth result; degrades to an "unavailable" card on non-ok.
  const memHealthPanel = (v.name === 'munin-memory' && memHealth)
    ? memoryHealthCard(memHealth, memAttention)
    : '';

  // deployment block — map the contract deploy shape onto the deployBlock component
  let deployCard = '';
  if (v.deploy) {
    const d = v.deploy;
    const block = deployBlock({ deployed: d.deployed_commit, latest: d.latest_commit, behind: d.drift });
    const meta = [
      d.host && `host ${d.host}`,
      d.systemd_unit && `unit ${d.systemd_unit}`,
      d.platform,
      d.deployed_at && `deployed ${formatAge(d.deployed_at)}`,
    ].filter(Boolean).map(esc).join(' · ');
    if (d.deployed_commit || meta) {
      deployCard = card({
        title: 'Deployment',
        body: block + (meta ? `<div class="machine-sub" style="margin-top:var(--space-2)">${meta}</div>` : ''),
      });
    }
  }

  // Timer schedule/last-run card (#97) — surfaces the systemd run outcome that
  // the header badge summarises, with concrete timestamps.
  let timerCard = '';
  if (v.kind === 'timer' && v.timer && (v.timer.lastRun || v.timer.nextRun)) {
    let tBody = '';
    if (v.timer.lastRun) {
      // metricRow() escapes its value — pass raw to avoid double-escaping.
      const res = v.timer.lastResult ? ` (${v.timer.lastResult})` : '';
      tBody += metricRow('Last run', `${formatAge(v.timer.lastRun)}${res}`);
    }
    if (v.timer.nextRun) tBody += metricRow('Next run', formatEta(v.timer.nextRun));
    if (tBody) timerCard = card({ title: 'Schedule', body: tBody });
  }

  // metrics + checks
  let metricsBody = '';
  for (const m of v.metrics) {
    metricsBody += metricRow(m.label, metricValueDisplay(m));
  }
  if (v.checks) {
    for (const [k, arr] of Object.entries(v.checks)) {
      const c = Array.isArray(arr) ? arr[0] : arr;
      if (c && typeof c === 'object') {
        const val = c.observedValue != null ? `${c.observedValue}${c.observedUnit ? ' ' + c.observedUnit : ''}` : (c.status || '');
        metricsBody += metricRow(k, String(val));
      }
    }
  }
  const metricsCard = metricsBody ? card({ title: 'Metrics', body: metricsBody }) : '';

  // Normalization is lenient, but discarded rows must not look like a valid
  // empty panel. This data is content-blind: panel identity, reason and count.
  const panelWarningsCard = v.panelWarnings.length
    ? card({
      title: 'Panel input warnings', fullWidth: true,
      body: v.panelWarnings.map((warning) => {
        const panel = typeof warning.panel === 'string' ? warning.panel : 'unknown panel';
        const count = Number.isSafeInteger(warning.count) && warning.count > 0 ? warning.count : null;
        const rowLabel = warning.reason === 'non_object_detail_table_rows_discarded'
          ? 'non-object detail table row'
          : (warning.reason === 'non_object_table_rows_discarded' ? 'non-object table row' : null);
        const reason = rowLabel
          ? `discarded ${count || 'some'} ${rowLabel}${count === 1 ? '' : 's'}`
          : 'discarded invalid panel data';
        return metricRow(panel, reason);
      }).join(''),
    })
    : '';

  // archetype/plugin panels — a registered plugin renders a LIVE HTMX fragment
  // (the fragment supplies its own heading, so no card title here); an unknown
  // plugin degrades to a labelled placeholder.
  const panelCards = v.panels.map((p) => {
    const plugin = p.plugin ? getPlugin(p.plugin) : null;
    if (plugin) {
      return card({
        fullWidth: p.fullWidth,
        endpoint: `/api/plugins/${encodeURIComponent(p.plugin)}/${encodeURIComponent(v.name)}/${encodeURIComponent(p.id)}`,
        refresh: p.refresh || undefined,
        loading: `Loading ${p.label || p.id}…`,
      });
    }
    // Pull symmetry: a descriptor panel can carry an inline typed kind+data —
    // rendered natively by the same renderer the push path uses.
    if (TYPED_KINDS.has(p.kind)) {
      return renderTypedPanel({ panel: p.id, ...p });
    }
    return card({ fullWidth: p.fullWidth, title: p.label, body: emptyState(`Panel "${esc(p.id)}"${p.plugin ? ` (plugin: ${esc(p.plugin)})` : ''} — rendered by its plugin.`, '🧩') });
  });

  // Pushed typed-panels (POST /api/panels) render alongside descriptor panels.
  const pushedRows = Array.isArray(pushedPanels) ? pushedPanels : [];
  const pushedStatusCards = pushedRows
    .filter((row) => row && row.kind === 'status')
    .map((row) => renderTypedPanel(pushedPanelToView(row)))
    .filter(Boolean);
  const pushedSupportingCards = pushedRows
    .filter((row) => row && row.kind !== 'status')
    .map((row) => renderTypedPanel(pushedPanelToView(row)))
    .filter(Boolean);
  const pushedSupporting = pushedSupportingCards.length
    ? `<details class="supporting-panels col-full"><summary>Supporting telemetry (${pushedSupportingCards.length})</summary>${grid(pushedSupportingCards)}</details>`
    : '';

  // links
  const linkItems = Object.entries(v.links)
    .filter(([, url]) => isSafeHref(url)) // http(s) or same-origin only — block javascript:/data:
    .map(([k, url]) => `<a href="${esc(url)}" rel="noopener noreferrer">${esc(k)}</a>`).join(' · ');
  const linksCard = linkItems ? card({ title: 'Links', body: `<div class="svc-meta">${linkItems}</div>` }) : '';

  // alerts
  const firing = v.alerts && Array.isArray(v.alerts.firing) ? v.alerts.firing : [];
  const alertsCard = firing.length
    ? card({ title: 'Alerts', fullWidth: true, body: firing.map((f) => metricRow(f.title || 'alert', f.severity || '')).join('') })
    : '';

  // Service-specific sub-views. munin-memory owns the consolidation dashboard,
  // which used to be a top-level tab and now lives under the service.
  const subViewsCard = v.name === 'munin-memory'
    ? card({ title: 'Dashboards', body: `<div class="svc-meta"><a href="/services/munin-memory/consolidation">Consolidation →</a></div>` })
    : '';

  const content = `
    <div class="page-head">
      <a href="/services" class="page-sub">← Services</a>
    </div>
    ${grid([header, memHealthPanel, deployCard, timerCard, metricsCard, panelWarningsCard, ...panelCards, ...pushedStatusCards, pushedSupporting, subViewsCard, linksCard, alertsCard].filter(Boolean))}`;

  // Inject each active plugin's stylesheet once (panels render their own markup).
  const pluginCss = [...new Set(v.panels.map((p) => p.plugin).filter(Boolean))]
    .map(getPlugin)
    .filter((pl) => pl && pl.css)
    .map((pl) => `<link rel="stylesheet" href="${esc(pl.css)}?v=${esc(gitVersion)}">`)
    .join('\n');

  return pageShell({ title: `Heimdall — ${v.label}`, active: '/services', gitVersion, content, head: pluginCss });
}

module.exports = {
  buildSelfDescriptor, selfSnapshot, serviceView, serviceCard, stateLabel,
  servicesGridFragment, servicesIndexPage, servicePage, countsFor, sortSnapshots,
  pushedStatusSummary, withPushedStatus, isActionableServiceException,
  PUSH_STATUS_STALE_MS,
};
