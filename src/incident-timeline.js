'use strict';

const { JOURNEY_SPECS, projectJourneyOutcome } = require('./synthetic-journeys');
const { projectSupervisionAudit } = require('./systemd-supervision');
const { getSystemdSupervisionAudit, getSyntheticJourneysInWindow } = require('./db');

const DEFAULT_MAX_SKEW_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const MAX_CORRELATIONS = 1000;
const FRESH_MS = 15 * 60 * 1000;
const SAFE_UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.(?:service|timer)$/;
const SAFE_SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,95}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}$/;
const TRACE_RE = /^[a-f0-9]{32}$/;

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeIso(value) {
  return validIso(value) ? new Date(Date.parse(value)).toISOString().replace('.000Z', 'Z') : null;
}

function safeHost(value) {
  return typeof value === 'string' && SAFE_SERVICE_RE.test(value) ? value : null;
}

function safeUnit(value) {
  return typeof value === 'string' && SAFE_UNIT_RE.test(value) ? value : null;
}

function safeLabel(value) {
  return typeof value === 'string' && SAFE_LABEL_RE.test(value) ? value : null;
}

function unitFromText(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.(?:service|timer))(?:\s|$)/);
  return match ? safeUnit(match[1]) : null;
}

function freshness(observedAt, now) {
  const age = Number(now) - Date.parse(observedAt);
  if (!Number.isFinite(age)) return 'unknown';
  if (age < -5000) return 'future';
  return age < FRESH_MS ? 'fresh' : 'stale';
}

function baseItem(fields, now) {
  const observedAt = normalizeIso(fields.observedAt);
  if (!observedAt) return null;
  const collectedAt = normalizeIso(fields.collectedAt);
  return {
    id: fields.id,
    kind: fields.kind,
    title: fields.title,
    source: safeLabel(fields.source) || 'unknown-source',
    observedAt,
    collectedAt,
    freshness: freshness(observedAt, now),
    firstObservedAt: normalizeIso(fields.firstObservedAt) || observedAt,
    lastObservedAt: normalizeIso(fields.lastObservedAt) || observedAt,
    resolutionReason: fields.resolutionReason || null,
    evidenceAuthority: fields.evidenceAuthority,
    host: safeHost(fields.host),
    unit: safeUnit(fields.unit),
    release: typeof fields.release === 'string' && /^[a-f0-9]{7,64}$/.test(fields.release)
      ? fields.release : null,
    outcome: safeLabel(fields.outcome),
    diagnosticRef: typeof fields.diagnosticRef === 'string' && /^trace:[a-f0-9]{32}$/.test(fields.diagnosticRef)
      ? fields.diagnosticRef : null,
    acknowledged: Boolean(fields.acknowledged),
    localHref: typeof fields.localHref === 'string' && /^\/[A-Za-z0-9/?=&._%-]*$/.test(fields.localHref)
      ? fields.localHref : null,
  };
}

function alertItems(rows, now) {
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const unit = unitFromText(row.title);
    const source = safeLabel(row.source) || 'heimdall-alert-engine';
    const category = safeLabel(row.category) || 'uncategorized';
    const common = {
      source, host: row.host, unit,
      firstObservedAt: row.created_at, lastObservedAt: row.last_observed_at || row.created_at,
      evidenceAuthority: 'Heimdall alert lifecycle', acknowledged: row.acknowledged === 1,
      localHref: '/alerts', outcome: row.severity,
    };
    const fired = baseItem({
      ...common, id: `alert-${row.id}-fired`, kind: 'alert-fired',
      title: `Alert ${row.id} fired (${category})`, observedAt: row.created_at,
    }, now);
    if (fired) items.push(fired);
    if (row.resolved_at) {
      const resolved = baseItem({
        ...common, id: `alert-${row.id}-resolved`, kind: 'alert-resolved',
        title: `Alert ${row.id} resolved`, observedAt: row.resolved_at,
        resolutionReason: row.resolution_reason || 'not-recorded',
      }, now);
      if (resolved) items.push(resolved);
    }
  }
  return items;
}

function eventItems(rows, now) {
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const unit = typeof row.title === 'string' && row.title.startsWith('Service event: ')
      ? safeUnit(row.title.slice('Service event: '.length)) : null;
    if (!unit) continue;
    const item = baseItem({
      id: `event-${row.id}`, kind: 'service-event', title: 'Systemd service event',
      source: safeLabel(row.source) || 'event-collector', observedAt: row.timestamp,
      evidenceAuthority: 'Heimdall structured event', host: row.host, unit,
      outcome: row.severity, localHref: `/services/${encodeURIComponent(unit.replace(/\.(?:service|timer)$/, ''))}`,
    }, now);
    if (item) items.push(item);
  }
  return items;
}

function deploymentItems(rows, now) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!SAFE_SERVICE_RE.test(row.service || '')) continue;
    if (!grouped.has(row.service)) grouped.set(row.service, []);
    grouped.get(row.service).push(row);
  }
  const items = [];
  for (const [service, history] of grouped) {
    history.sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
    for (let index = 1; index < history.length; index += 1) {
      const row = history[index];
      if (!row.deployed_commit || row.deployed_commit === history[index - 1].deployed_commit) continue;
      const item = baseItem({
        id: `deploy-${row.id}`, kind: 'release-change', title: `${service} release changed`,
        source: 'heimdall-deployment-collector', observedAt: row.checked_at,
        evidenceAuthority: 'Observed deployed release', host: row.host,
        unit: `${service}.service`, release: row.deployed_commit, outcome: row.health_status,
        localHref: `/services/${encodeURIComponent(service)}`,
      }, now);
      if (item) items.push(item);
    }
  }
  return items;
}

function metricItems(rows, now) {
  const items = [];
  const input = Array.isArray(rows) ? rows : [];
  const transitions = new Map();
  for (const row of input) {
    if (row.metric === 'collector_success' || (typeof row.metric === 'string' && row.metric.startsWith('collector_probe_'))) {
      const key = `${row.host}\0${row.metric}`;
      if (!transitions.has(key)) transitions.set(key, []);
      transitions.get(key).push(row);
    }
  }
  for (const series of transitions.values()) {
    series.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let prior = null;
    for (const row of series) {
      const state = Number(row.value) > 0 ? 'pass' : 'fail';
      if (state === prior || (state === 'pass' && prior === null)) { prior = state; continue; }
      const probe = row.metric !== 'collector_success';
      const recovered = state === 'pass';
      const item = baseItem({
        id: `metric-${row.id}`, kind: recovered ? (probe ? 'probe-recovery' : 'collector-recovery')
          : (probe ? 'probe-failure' : 'collector-failure'),
        title: recovered ? (probe ? 'Collector probe recovered' : 'Collector cycle recovered')
          : (probe ? 'Collector probe failed' : 'Collector cycle failed'),
        source: 'heimdall-metric-collector', observedAt: row.timestamp,
        evidenceAuthority: 'Heimdall metric observation', host: row.host, outcome: state,
        resolutionReason: recovered ? 'observed-recovery' : null, localHref: '/',
      }, now);
      if (item) items.push(item);
      prior = state;
    }
  }
  for (const row of input) {
    if (typeof row.metric === 'string' && row.metric.startsWith('service_restarts_24h_') && Number(row.value) > 0) {
      const candidate = `${row.metric.slice('service_restarts_24h_'.length)}.service`;
      const unit = safeUnit(candidate);
      if (unit) {
        const item = baseItem({
          id: `metric-${row.id}`, kind: 'restart-observation', title: 'Service restarts observed',
          source: 'heimdall-metric-collector', observedAt: row.timestamp,
          evidenceAuthority: 'Heimdall metric observation', host: row.host, unit,
          outcome: 'observed', localHref: `/services/${encodeURIComponent(unit.replace('.service', ''))}`,
        }, now);
        if (item) items.push(item);
      }
    }
  }
  return items;
}

function supervisionItems(row, now) {
  if (!row || row.state !== 'valid') return [];
  const projected = projectSupervisionAudit(row.audit, { now });
  if (!projected.receivedEvidence) return [];
  const items = [];
  for (const unit of projected.units) {
    const common = {
      source: 'brokkr-systemd-supervision', observedAt: projected.observedAt,
      collectedAt: row.received_at, evidenceAuthority: 'Brokkr supervision audit v1',
      host: unit.targetNodeId, unit: unit.unit, outcome: unit.state, localHref: '/supervision',
    };
    const signals = [];
    if (unit.findingCodes.includes('restart_storm')) signals.push(['restart-storm', 'Restart storm observed']);
    if (unit.watchdog === 'timeout') signals.push(['watchdog-timeout', 'Watchdog timeout observed']);
    if (unit.oom === 'killed') signals.push(['oom-kill', 'OOM kill observed']);
    if (signals.length === 0 && unit.state === 'fail') signals.push(['supervision-failure', 'Supervision failure observed']);
    signals.forEach(([kind, title], index) => {
      const item = baseItem({ ...common, id: `supervision-${unit.targetNodeId}-${unit.unit}-${kind}-${index}`, kind, title }, now);
      if (item) items.push(item);
    });
  }
  return items;
}

function journeyItems(rows, now) {
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row && row.outcome;
    const projected = projectJourneyOutcome(value, { now });
    const spec = value && JOURNEY_SPECS[value.journey_id];
    if (!spec || projected.validationErrors.length > 0) continue;
    const trace = TRACE_RE.test(value.trace_id || '') ? `trace:${value.trace_id}` : null;
    const item = baseItem({
      id: `journey-${value.journey_id}-${value.attempt_id}`, kind: 'synthetic-journey',
      title: spec.label, source: value.producer, observedAt: value.observed_at,
      collectedAt: row.collected_at, evidenceAuthority: `${value.producer} synthetic outcome v1`,
      outcome: projected.state, diagnosticRef: trace, localHref: '/reliability',
    }, now);
    if (item) items.push(item);
  }
  return items;
}

function exactCorrelations(items) {
  const byDiagnostic = new Map();
  for (const item of items) {
    if (!item.diagnosticRef) continue;
    if (!byDiagnostic.has(item.diagnosticRef)) byDiagnostic.set(item.diagnosticRef, []);
    byDiagnostic.get(item.diagnosticRef).push(item);
  }
  const correlations = [];
  for (const [diagnosticRef, matches] of byDiagnostic) {
    if (matches.length < 2) continue;
    correlations.push({
      id: `correlation-${diagnosticRef}`, mode: 'producer-authored', diagnosticRef,
      itemIds: matches.map((item) => item.id), authoritative: true, causal: false,
      clockSource: 'producer diagnostic ID', maxSkewMs: null,
      uncertainty: 'A shared producer-authored identifier links observations; it does not establish causation.',
    });
  }
  return correlations;
}

function inferredCorrelations(items, exact, maxSkewMs) {
  const exactIds = new Set(exact.flatMap((row) => row.itemIds));
  const correlations = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const a = items[left]; const b = items[right];
      if (exactIds.has(a.id) || exactIds.has(b.id) || !a.host || a.host !== b.host) continue;
      const sameUnit = a.unit && b.unit && a.unit === b.unit;
      const sameRelease = a.release && b.release && a.release === b.release;
      if (!sameUnit && !sameRelease) continue;
      const delta = Math.abs(Date.parse(a.observedAt) - Date.parse(b.observedAt));
      if (delta > maxSkewMs) continue;
      const tuple = sameUnit ? `${a.host}/${a.unit}` : `${a.host}/${a.release}`;
      correlations.push({
        id: `correlation-inferred-${a.id}-${b.id}`, mode: 'inferred', diagnosticRef: null,
        itemIds: [a.id, b.id], tuple, authoritative: false, causal: false,
        clockSource: 'observed_at', maxSkewMs,
        uncertainty: 'Coincidental observations within the bounded window remain possible.',
      });
      if (correlations.length >= MAX_CORRELATIONS) return correlations;
    }
  }
  return correlations;
}

function buildIncidentTimeline(sources = {}, options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  const maxSkewMs = Number.isFinite(options.maxSkewMs)
    ? Math.max(1000, Math.min(60 * 60 * 1000, options.maxSkewMs)) : DEFAULT_MAX_SKEW_MS;
  const limit = Number.isSafeInteger(options.limit)
    ? Math.max(1, Math.min(MAX_LIMIT, options.limit)) : DEFAULT_LIMIT;
  let items = [
    ...alertItems(sources.alerts, now), ...eventItems(sources.events, now),
    ...deploymentItems(sources.deployments, now), ...metricItems(sources.metrics, now),
    ...supervisionItems(sources.supervision, now), ...journeyItems(sources.journeys, now),
  ].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id));
  const from = normalizeIso(options.from);
  const to = normalizeIso(options.to);
  if (from) items = items.filter((item) => item.observedAt >= from);
  if (to) items = items.filter((item) => item.observedAt <= to);
  const trace = TRACE_RE.test(options.trace || '') ? `trace:${options.trace}` : null;
  if (trace) items = items.filter((item) => item.diagnosticRef === trace);
  items = items.slice(0, limit);
  const exact = exactCorrelations(items);
  const correlations = [...exact, ...inferredCorrelations(items, exact, maxSkewMs)];
  return {
    items, correlations: correlations.filter((row) => row.itemIds.every((id) => items.some((item) => item.id === id))),
    clockSource: 'observed_at', maxSkewMs,
    caveat: 'Temporal correlation, not causation. Inferred links are never audit truth.',
  };
}

function loadIncidentTimeline(db, options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  const to = normalizeIso(options.to) || new Date(now).toISOString();
  let from = normalizeIso(options.from) || new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString();
  const earliest = new Date(Date.parse(to) - 180 * 24 * 60 * 60 * 1000).toISOString();
  if (from < earliest) from = earliest;
  const alerts = db.prepare(`
    SELECT id, created_at, resolved_at, last_observed_at, acknowledged, host, category, severity, title, source
    FROM alerts WHERE created_at <= ? AND (resolved_at IS NULL OR resolved_at >= ?)
    ORDER BY created_at DESC LIMIT 1000
  `).all(to, from);
  const events = db.prepare(`
    SELECT id, timestamp, host, category, severity, title, source FROM events
    WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1000
  `).all(from, to);
  const deployments = db.prepare(`
    SELECT id, checked_at, service, host, deployed_commit, health_status FROM service_versions
    WHERE checked_at >= ? AND checked_at <= ? ORDER BY service, checked_at LIMIT 2000
  `).all(from, to);
  const services = [...new Set(deployments.map((row) => row.service))];
  for (const service of services) {
    const prior = db.prepare(`
      SELECT id, checked_at, service, host, deployed_commit, health_status FROM service_versions
      WHERE service = ? AND checked_at < ? ORDER BY checked_at DESC LIMIT 1
    `).get(service, from);
    if (prior) deployments.push(prior);
  }
  for (const alert of alerts) {
    if (!alert.resolved_at) continue;
    const reaperEvent = events.some((event) => event.source === 'alert-reaper'
      && event.host === alert.host && event.timestamp === alert.resolved_at
      && event.title === `Alert auto-closed as stale: ${alert.title}`);
    alert.resolution_reason = reaperEvent ? 'stale-no-data' : 'not-recorded';
  }
  const metrics = db.prepare(`
    SELECT id, timestamp, host, metric, value FROM metrics
    WHERE timestamp >= ? AND timestamp <= ? AND
      (metric = 'collector_success' OR metric LIKE 'collector_probe_%' OR metric LIKE 'service_restarts_24h_%')
    ORDER BY timestamp DESC LIMIT 2000
  `).all(from, to);
  const priorMetrics = db.prepare(`
    SELECT id, timestamp, host, metric, value FROM (
      SELECT id, timestamp, host, metric, value,
             ROW_NUMBER() OVER (PARTITION BY host, metric ORDER BY timestamp DESC) AS rn
      FROM metrics WHERE timestamp < ? AND
        (metric = 'collector_success' OR metric LIKE 'collector_probe_%')
    ) WHERE rn = 1 LIMIT 500
  `).all(from);
  metrics.push(...priorMetrics);
  return buildIncidentTimeline({
    alerts, events, deployments, metrics,
    journeys: getSyntheticJourneysInWindow(db, from, to, 2000, options.trace),
    supervision: getSystemdSupervisionAudit(db),
  }, {
    now, from, to, limit: options.limit, maxSkewMs: options.maxSkewMs, trace: options.trace,
  });
}

module.exports = { buildIncidentTimeline, loadIncidentTimeline };
