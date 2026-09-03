'use strict';

const { pageShell } = require('./shell');
const { esc } = require('./util');

function correlationLabel(item, correlations) {
  const match = correlations.find((row) => row.itemIds.includes(item.id));
  if (!match) return '<span class="timeline-badge uncorrelated">Uncorrelated</span>';
  if (match.mode === 'producer-authored') {
    return '<span class="timeline-badge exact">Exact producer ID</span>';
  }
  return '<span class="timeline-badge inferred">Inferred</span>';
}

function value(label, content) {
  return `<div><dt>${esc(label)}</dt><dd>${esc(content || 'not available')}</dd></div>`;
}

function renderItem(item, correlations) {
  const target = item.localHref
    ? `<a class="timeline-local-link" href="${esc(item.localHref)}">Local evidence</a>` : '';
  return `<article class="timeline-item">
    <div class="timeline-marker" aria-hidden="true"></div>
    <div class="timeline-item-body">
      <div class="timeline-item-head">
        <div><time datetime="${esc(item.observedAt)}">${esc(item.observedAt)}</time><h2>${esc(item.title)}</h2></div>
        ${correlationLabel(item, correlations)}
      </div>
      <dl class="timeline-facts">
        ${value('Source', item.source)}
        ${value('Evidence authority', item.evidenceAuthority)}
        ${value('Observed', item.observedAt)}
        ${value('Collected', item.collectedAt)}
        ${value('Freshness', item.freshness)}
        ${value('First observed', item.firstObservedAt)}
        ${value('Last observed', item.lastObservedAt)}
        ${value('Resolution', item.resolutionReason)}
        ${value('Host / unit', [item.host, item.unit].filter(Boolean).join(' / '))}
        ${value('Release', item.release)}
        ${value('Outcome', item.outcome)}
        ${value('Diagnostic reference', item.diagnosticRef)}
      </dl>
      ${target}
    </div>
  </article>`;
}

function incidentTimelinePage(gitVersion, timeline = {}) {
  const items = Array.isArray(timeline.items) ? timeline.items : [];
  const correlations = Array.isArray(timeline.correlations) ? timeline.correlations : [];
  const content = `<div class="page-head"><h1 class="page-title">Incident timeline</h1><p class="page-sub">Read-only forensic observations from bounded local evidence.</p></div>
    <div class="timeline-caveat"><strong>Temporal correlation, not causation.</strong> Producer-authored diagnostic IDs take precedence. Inferred links use the visible host/unit or host/release tuple and a ${esc(Math.round((timeline.maxSkewMs || 0) / 60000))}-minute maximum skew on <code>${esc(timeline.clockSource || 'observed_at')}</code>; they are never audit truth.</div>
    <div class="timeline-controls" aria-label="Timeline range"><a href="/timeline?days=1">24 hours</a><a href="/timeline?days=7">7 days</a><a href="/timeline?days=30">30 days</a><a href="/timeline?days=180">180 days</a></div>
    <div class="timeline-list">${items.length
      ? items.map((item) => renderItem(item, correlations)).join('')
      : '<div class="timeline-empty">No bounded forensic observations in this window.</div>'}</div>`;
  return pageShell({
    title: 'Heimdall — Incident timeline', active: '/timeline', gitVersion, content,
    head: `  <link rel="stylesheet" href="/css/timeline.css?v=${esc(gitVersion || 'dev')}">`,
    lastUpdated: true,
  });
}

module.exports = { incidentTimelinePage };
