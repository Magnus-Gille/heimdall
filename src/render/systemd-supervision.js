'use strict';

const { pageShell } = require('./shell');
const { card, grid } = require('./cards');
const { statusBadge, kpi, emptyState } = require('./components');
const { esc } = require('./util');
const { projectSupervisionAudit, enrichSupervisionProjection } = require('../systemd-supervision');

function badgeState(state) {
  if (state === 'pass') return 'ok';
  if (state === 'fail') return 'crit';
  if (state === 'stale') return 'warn';
  return 'stale';
}

function classificationLabel(value) {
  const labels = {
    pass: 'All units healthy', fail: 'Attention needed', stale: 'Stale',
    healthy: 'Healthy', failed: 'Failed', overdue: 'Overdue', 'never-run': 'Never run',
    'inactive-success': 'Completed / inactive', 'manager-unavailable': 'Manager unavailable',
    'unit-absent': 'Unit absent', 'stale-producer': 'Stale', unknown: 'Unknown',
  };
  return labels[value] || 'Unknown';
}

function valueOrUnavailable(value, unavailable = 'not reported by v1') {
  return value == null || value === '' ? unavailable : String(value);
}

function line(label, value) {
  return `<div class="supervision-line"><span>${esc(label)}</span><span class="mono">${esc(value)}</span></div>`;
}

function renderUnit(unit) {
  const restart = unit.restart
    ? `${unit.restart.count} · ${unit.restart.windowStart} → ${unit.restart.windowEnd}`
    : 'not applicable or unavailable';
  const runtime = [unit.activeState, unit.subState, unit.result].filter(Boolean).join(' · ') || 'unavailable';
  const signals = `watchdog ${valueOrUnavailable(unit.watchdog)} · OOM ${valueOrUnavailable(unit.oom)}`;
  let timer = '';
  if (unit.timer) {
    timer = `<div class="supervision-timer">
      ${line('Last run', valueOrUnavailable(unit.timer.lastRunAt, 'never'))}
      ${line('Last duration', valueOrUnavailable(unit.timer.lastDuration))}
      ${line('Next trigger', valueOrUnavailable(unit.timer.nextRunAt, 'unavailable'))}
      ${line('Run result', valueOrUnavailable(unit.timer.lastResult))}
      ${line('Missed runs', valueOrUnavailable(unit.timer.missedRuns, 'not applicable'))}
      ${line('Catch-up', unit.timer.persistent == null ? 'unavailable' : (unit.timer.persistent ? 'persistent' : 'not persistent'))}
      ${line('Expected cadence', valueOrUnavailable(unit.timer.expectedCadence))}
      ${line('Retry state', valueOrUnavailable(unit.timer.retryState))}
    </div>`;
  }
  const findings = unit.findingCodes.length ? unit.findingCodes.join(', ') : 'none';
  return card({
    className: 'supervision-unit',
    title: unit.unit,
    headExtra: statusBadge(badgeState(unit.state), classificationLabel(unit.classification)),
    body: `<div class="supervision-identity"><span class="tag">${esc(unit.scope)} manager</span><span class="tag">${esc(unit.workloadShape)}</span><span>${esc(unit.targetNodeId)} · ${esc(unit.owner)}</span></div>
      ${line('Runtime', runtime)}
      ${line('Enabled state', valueOrUnavailable(unit.enabledState))}
      ${line('Restarts', restart)}
      ${line('Signals', signals)}
      ${line('Process start', valueOrUnavailable(unit.processStartedAt))}
      ${line('Last failure', valueOrUnavailable(unit.lastFailureAt))}
      ${line('Loaded release', valueOrUnavailable(unit.loadedRelease))}
      ${line('Findings', findings)}
      ${timer}`,
  });
}

function projectionForRow(row, now) {
  if (!row || row.state === 'missing') return projectSupervisionAudit(null, { now });
  if (row.state !== 'valid' || !row.audit) return {
    state: 'unknown', freshness: 'invalid', observedAt: null, receivedEvidence: false,
    units: [], counts: { pass: 0, fail: 0, stale: 0, unknown: 0 }, validationErrors: ['stored-evidence'],
  };
  return projectSupervisionAudit(row.audit, { now });
}

function renderSystemdSupervision(row, now = Date.now(), context = {}) {
  const projection = enrichSupervisionProjection(projectionForRow(row, now), context);
  const state = badgeState(projection.state);
  const freshness = projection.freshness === 'fresh' ? 'Fresh'
    : (projection.freshness === 'stale' ? 'Stale' : (projection.freshness === 'future' ? 'Future-dated' : 'Unknown'));
  const summary = card({
    fullWidth: true,
    className: 'supervision-summary',
    title: 'Systemd supervision',
    headExtra: statusBadge(state, classificationLabel(projection.state)),
    body: `<p>Read-only projection of Brokkr supervision evidence. Brokkr remains the failure-delivery authority; Heimdall cannot restart, enable, or disable units.</p>
      <div class="kpi-row">
        ${kpi(String(projection.counts.pass), 'Passing', projection.counts.pass ? 'ok' : 'stale')}
        ${kpi(String(projection.counts.fail), 'Failed', projection.counts.fail ? 'crit' : 'ok')}
        ${kpi(String(projection.counts.stale), 'Stale', projection.counts.stale ? 'warn' : 'ok')}
        ${kpi(String(projection.counts.unknown), 'Unknown', projection.counts.unknown ? 'stale' : 'ok')}
      </div>
      <div class="supervision-meta">Evidence: ${esc(freshness)} · observed ${esc(projection.observedAt || 'never')}</div>`,
  });
  const unitCards = projection.units.map(renderUnit);
  if (!unitCards.length) {
    unitCards.push(card({ fullWidth: true, body: emptyState('Unknown — no validated supervision evidence received') }));
  }
  return grid([summary, ...unitCards]);
}

function systemdSupervisionPage(gitVersion, row, now = Date.now(), context = {}) {
  const content = `<div class="page-head"><h1 class="page-title">Systemd supervision</h1><p class="page-sub">Services, timers, missed runs, restart storms, watchdogs and OOM outcomes.</p></div>${renderSystemdSupervision(row, now, context)}`;
  return pageShell({
    title: 'Heimdall — Systemd supervision', active: '/supervision', gitVersion, content,
    head: `  <link rel="stylesheet" href="/css/supervision.css?v=${esc(gitVersion || 'dev')}">`,
    lastUpdated: true,
  });
}

module.exports = { renderSystemdSupervision, systemdSupervisionPage };
