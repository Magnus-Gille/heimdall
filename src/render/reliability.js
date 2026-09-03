'use strict';

const { pageShell } = require('./shell');
const { card, grid } = require('./cards');
const { statusBadge, kpi } = require('./components');
const { esc } = require('./util');
const {
  JOURNEY_SPECS, projectJourneyOutcome, computeJourneyObjectives,
} = require('../synthetic-journeys');

function viewState(state) {
  if (state === 'pass') return { badge: 'ok', label: 'Passing' };
  if (state === 'fail') return { badge: 'crit', label: 'Failed' };
  if (state === 'partial') return { badge: 'warn', label: 'Partial' };
  if (state === 'stale') return { badge: 'warn', label: 'Stale' };
  return { badge: 'stale', label: 'Unknown' };
}

function stepViewState(state) {
  if (state === 'skipped') return { badge: 'stale', label: 'Skipped' };
  return viewState(state);
}

function formatRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function renderJourney(journeyId, latest, history, now, producerHint) {
  const spec = JOURNEY_SPECS[journeyId];
  const projected = latest ? projectJourneyOutcome(latest, { now })
    : (producerHint
      ? { state: 'partial', freshness: producerHint.freshness, failureDomain: null }
      : { state: 'unknown', freshness: 'missing', failureDomain: null });
  const objective = computeJourneyObjectives(history || [], { latencyTargetMs: spec.latencyTargetMs, now });
  const status = viewState(projected.state);
  const steps = latest && Array.isArray(latest.steps)
    ? latest.steps.map((item) => {
      const status = stepViewState(item.outcome);
      return `<li><span>${esc(item.id)}</span>${statusBadge(status.badge, status.label)}</li>`;
    }).join('')
    : `<li><span>${producerHint ? 'Legacy producer status received; attempt/step contract is incomplete' : 'No complete producer outcome received'}</span></li>`;
  const failure = projected.failureDomain
    ? `<div class="reliability-note">Failure domain: ${esc(projected.failureDomain)} · class ${esc(latest.error_class || 'unknown')}</div>` : '';
  return card({
    className: 'reliability-journey', title: spec.label,
    headExtra: statusBadge(status.badge, status.label),
    body: `<div class="reliability-meta">Producer ${esc(spec.producer)} · freshness ${esc(projected.freshness || 'unknown')}</div>
      <ul class="reliability-steps">${steps}</ul>
      ${failure}
      <div class="reliability-meta">Attempt ${esc(latest?.attempt_id || 'unavailable')} · version ${esc(latest?.version || 'unavailable')} · latency ${Number.isFinite(latest?.latency_ms) ? `${esc(latest.latency_ms)} ms` : 'unavailable'} · trace ${esc(latest?.trace_id || 'unavailable')}</div>
      <div class="kpi-row">
        ${kpi(formatRate(objective.successRate), 'Success rate', objective.state === 'pass' ? 'ok' : (objective.state === 'fail' ? 'crit' : 'stale'))}
        ${kpi(objective.p95LatencyMs == null ? '—' : `${objective.p95LatencyMs} ms`, 'p95 latency', objective.state === 'pass' ? 'ok' : (objective.state === 'fail' ? 'crit' : 'stale'))}
        ${kpi(`${objective.sampleCount}/${objective.minSamples}`, 'Samples', objective.sampleCount >= objective.minSamples ? 'ok' : 'stale')}
      </div>`,
  });
}

function reliabilityPage(gitVersion, rows = [], options = {}) {
  const now = options.now == null ? Date.now() : options.now;
  const latestById = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.journey_id, row]));
  const histories = options.histories || {};
  const producerHints = options.producerHints || {};
  const cards = Object.keys(JOURNEY_SPECS).map((journeyId) =>
    renderJourney(journeyId, latestById.get(journeyId), histories[journeyId] || [], now, producerHints[journeyId]));
  const content = `<div class="page-head"><h1 class="page-title">Reliability journeys</h1><p class="page-sub">Content-free read paths and deterministic operational objectives.</p></div>
    <div class="reliability-principles">A green journey requires every declared step in one attempt. Missing producer evidence and low sample counts stay unknown. These objectives measure path reliability only; they never grade task, model, prompt, or result quality.</div>
    ${grid(cards)}`;
  return pageShell({
    title: 'Heimdall — Reliability journeys', active: '/reliability', gitVersion, content,
    head: `  <link rel="stylesheet" href="/css/reliability.css?v=${esc(gitVersion || 'dev')}">`,
    lastUpdated: true,
  });
}

module.exports = { reliabilityPage, renderJourney };
