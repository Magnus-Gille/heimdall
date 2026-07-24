'use strict';

/**
 * insights.js — the /insights page renderer, v2 shell.
 *
 * Shows weekly Claude Code usage-insights trend data logged to
 * Munin namespace `meta/insights-history`. Also exposes an
 * "Agent Objective" card that points automated coding agents at
 * the /api/insights/objective endpoint for hillclimb signals.
 *
 * Page-specific styles live in /css/insights.css (loaded via head opt).
 * Chart canvases are populated by initInsightsCharts() in charts-client.js.
 */

const { pageShell } = require('./shell');
const { esc } = require('./util');
const { kpi, emptyState } = require('./components');
const { card, grid } = require('./cards');
const { deriveMetrics, computeSis, buildObjective } = require('../insights');
const { bandStatus, bandTitle, SIS_BAND, OUTCOME_QUALITY_BAND, FIRST_PASS_BAND } = require('../config/insight-thresholds');

function insightsCssLink(gitVersion) {
  return `  <link rel="stylesheet" href="/css/insights.css?v=${esc(gitVersion || 'dev')}">`;
}

/**
 * Render the KPI row from the latest record's derived metrics.
 * Returns an HTML string of kpi() elements wrapped in a flex container.
 */
function renderKpiRow(latestRecord) {
  if (!latestRecord) {
    return `<div class="kpi-row">
      ${kpi('—', 'Self-Improvement Score', 'stale')}
      ${kpi('—', 'Outcome success', 'stale')}
      ${kpi('—', 'First-pass correctness', 'stale')}
      ${kpi('—', 'Commits (latest week)', 'stale')}
    </div>`;
  }

  const m = deriveMetrics(latestRecord);
  const sis = computeSis(latestRecord);
  const sisStr = sis != null ? String(sis) : '—';
  const sisState = bandStatus(sis, SIS_BAND);

  const outcomeStr = m.outcomeQuality !== null
    ? `${(m.outcomeQuality * 100).toFixed(1)}%`
    : '—';
  const outcomeState = bandStatus(m.outcomeQuality, OUTCOME_QUALITY_BAND);

  const fpcStr = m.firstPassCorrectness !== null
    ? `${(m.firstPassCorrectness * 100).toFixed(1)}%`
    : '—';
  const fpcState = bandStatus(m.firstPassCorrectness, FIRST_PASS_BAND);

  const headline = latestRecord.headline || {};
  const commitsStr = headline.commits != null ? String(headline.commits) : '—';

  const pct = (v) => `${Math.round(v * 100)}%`;
  return `<div class="kpi-row">
    ${kpi(sisStr, 'Self-Improvement Score', sisState, bandTitle(SIS_BAND))}
    ${kpi(outcomeStr, 'Outcome success', outcomeState, bandTitle(OUTCOME_QUALITY_BAND, pct))}
    ${kpi(fpcStr, 'First-pass correctness', fpcState, bandTitle(FIRST_PASS_BAND, pct))}
    ${kpi(commitsStr, 'Commits (latest week)', 'info')}
  </div>`;
}

/**
 * Render the "Agent Objective" card body — shows SIS, directive, and
 * machine endpoint pointers so an automated coding agent can poll for
 * its own improvement signal.
 */
function renderObjectiveCard(objective) {
  if (!objective || objective.data_points === 0) {
    return `<div class="insights-objective">
      <p class="insights-obj-note">${esc('No insights data yet — data appears after the first weekly summary is logged to Munin.')}</p>
      <p class="insights-obj-endpoints">
        <strong>Machine endpoints:</strong><br>
        <code>GET /api/insights/objective</code> — self-improvement score + directive<br>
        <code>GET /api/insights/trend</code> — weekly metric series
      </p>
    </div>`;
  }

  const deltaStr = objective.delta_vs_prev != null
    ? (objective.delta_vs_prev >= 0
        ? ` <span class="insights-delta is-ok">+${esc(String(objective.delta_vs_prev))}</span>`
        : ` <span class="insights-delta is-crit">${esc(String(objective.delta_vs_prev))}</span>`)
    : '';

  const lever = objective.next_lever || {};

  const sisDisplay = objective.self_improvement_score != null
    ? esc(String(objective.self_improvement_score))
    : '—';

  return `<div class="insights-objective">
    <div class="insights-obj-score">
      <span class="insights-sis-value">${sisDisplay}</span>
      <span class="insights-sis-label">/100${deltaStr}</span>
    </div>
    <div class="insights-obj-directive">
      <strong>Next lever (${esc(lever.category || '—')}):</strong>
      <p>${esc(lever.directive || '')}</p>
    </div>
    <p class="insights-obj-endpoints">
      <strong>Machine endpoints:</strong><br>
      <code>GET /api/insights/objective</code> — self-improvement score + directive<br>
      <code>GET /api/insights/trend</code> — weekly metric series<br>
      <span class="insights-obj-note">Poll <code>/api/insights/objective</code> to get the current SIS and act on <code>next_lever.directive</code>. Maximize <code>self_improvement_score</code>.</span>
    </p>
  </div>`;
}

/**
 * Render chart area or emptyState when trend < 2 points.
 */
function renderCharts(trend) {
  if (!trend || trend.length < 2) {
    return emptyState(
      'Trend builds over the coming weeks — one data point so far.',
      '📈',
    );
  }

  return `
    <div class="insights-chart-wrap">
      <canvas id="insights-sis-chart" width="900" height="260"></canvas>
    </div>
    <div class="insights-chart-wrap">
      <canvas id="insights-friction-chart" width="900" height="220"></canvas>
    </div>
    <div class="insights-chart-wrap">
      <canvas id="insights-outcome-chart" width="900" height="220"></canvas>
    </div>
    <div class="insights-chart-wrap">
      <canvas id="insights-satisfaction-chart" width="900" height="220"></canvas>
    </div>`;
}

/**
 * Full page renderer.
 *
 * @param {string} gitVersion
 * @param {{ records?: object[], objective?: object, trend?: object[] }} data
 */
function insightsPage(gitVersion, data) {
  const { records = [], objective = null, trend = [] } = data || {};
  const latestRecord = records.length > 0 ? records[records.length - 1] : null;
  const resolvedObjective = objective || buildObjective(records);

  const content = `
    <div class="insights-page">
      <div class="proj-page-header">
        <h1>Insights</h1>
        <p class="proj-page-sub">Claude Code usage-insights — weekly trend of session quality, friction, and self-improvement.</p>
      </div>
      ${grid([
        {
          title: 'Weekly metrics',
          body: renderKpiRow(latestRecord),
          fullWidth: true,
        },
        {
          title: 'Agent Objective — Self-Improvement Score',
          body: renderObjectiveCard(resolvedObjective),
          fullWidth: true,
          className: 'insights-objective-card',
        },
        {
          title: 'Self-Improvement Score over time',
          body: renderCharts(trend),
          fullWidth: true,
        },
      ])}
    </div>`;

  return pageShell({
    title: 'Heimdall — Insights',
    active: '/insights',
    gitVersion,
    content,
    head: insightsCssLink(gitVersion),
    charts: true,
  });
}

module.exports = { insightsPage };
