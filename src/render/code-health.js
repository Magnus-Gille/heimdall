'use strict';

const { pageShell } = require('./shell');
const { esc } = require('./util');
const { REPOSITORIES } = require('../code-health/registry');

const MAX_HISTORY_POINTS = 12;
const MAX_EVIDENCE_ROWS = 6;
const METRICS = Object.freeze([
  { id: 'complex_functions', label: 'Complex functions', unit: 'functions', help: 'Functions above the registered complexity threshold.' },
  { id: 'unused_candidates', label: 'Unused candidates', unit: 'candidates', help: 'Tool candidates remain uncertain until an owner validates them.' },
  { id: 'coverage', label: 'Test coverage', unit: 'lines', help: 'Coverage is shown only for its declared inventory and profile.' },
  { id: 'ci_first_attempt', label: 'CI first attempt', unit: 'runs', help: 'Main push runs, measured at attempt one.' },
  { id: 'confirmed_regressions', label: 'Confirmed regressions', unit: 'regressions', help: 'Requires a complete reviewed release survey.' },
]);
const REPO_LABELS = Object.freeze({
  sagascript: 'SagaScript',
  'gille-inference': 'Gille inference',
});
const STATUS_LABELS = Object.freeze({
  measured: 'Measured',
  unknown: 'Unknown',
  unsupported: 'Unsupported',
  failed: 'Failed',
  stale: 'Stale',
  disabled: 'Disabled',
  unconfigured: 'Unconfigured',
  rejected: 'Rejected',
  incomplete: 'Incomplete',
  unavailable: 'Unavailable',
  'not-collected': 'Not collected',
  committed: 'Stored',
  fixture: 'Synthetic fixture',
});
const REASON_LABELS = Object.freeze({
  'no-retained-sample': 'No sample is retained for this window.',
  'conflicting-samples-at-same-time': 'Conflicting samples share the latest timestamp.',
  'not-collected': 'No collection has completed yet.',
  'unsupported-tool': 'The registered tool does not support this scope.',
  'scope-unavailable': 'The registered scope is not available.',
  'incomplete-input': 'The source did not provide a complete input set.',
  'producer-error': 'The producer reported an error.',
  'stale-source': 'The source evidence is stale.',
  redacted: 'The source evidence was redacted.',
  'source-collection-incomplete': 'The last collection was incomplete.',
  'authenticated-transport-not-configured': 'Authenticated collection is not configured.',
  'invalid-source-configuration': 'The source configuration was rejected.',
  'export-not-reconciled': 'The latest retained export was not reconciled.',
  'source-unavailable': 'The source was unavailable during the last attempt.',
});

function registeredRepositories() {
  return REPOSITORIES.map(({ owner, name }) => ({ owner, name, label: REPO_LABELS[name] || name }));
}

function compactTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function shortRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value.slice(0, 8) : null;
}

function shortDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value.slice(0, 12)}` : null;
}

function evidenceRows(metricName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const rows = [];
  const add = (label, value) => {
    if (rows.length < MAX_EVIDENCE_ROWS && value !== null && value !== undefined) rows.push({ label, value: String(value).slice(0, 100) });
  };
  if (metricName === 'complex_functions') {
    add('Threshold', payload.threshold);
    add('Eligible functions', payload.eligible_functions);
    add('Above threshold', payload.above_threshold_functions);
  } else if (metricName === 'unused_candidates') {
    add('Candidate count', payload.candidate_count);
    add('Validated by owner', payload.validated_count);
    add('False positives', payload.false_positive_count);
    add('Uncertain', payload.uncertain_count);
    add('Graph', payload.graph_status === 'unqualified' ? 'Unqualified' : payload.graph_status);
  } else if (metricName === 'coverage') {
    add('Measure', payload.measure);
    add('Covered', payload.covered);
    add('Eligible', payload.eligible);
    add('Source files emitted', payload.emitted_source_files);
    add('Eligible source files', payload.eligible_source_files);
    add('Source inventory', payload.source_inventory);
  } else if (metricName === 'ci_first_attempt') {
    const runs = Array.isArray(payload.runs) ? payload.runs.slice(0, 1000) : [];
    const success = runs.filter((run) => run && run.overall_conclusion === 'success').length;
    const failed = runs.filter((run) => run && ['failure', 'infra_failure'].includes(run.overall_conclusion)).length;
    add('Successful first attempts', `${success} / ${Number.isSafeInteger(payload.expected_run_count) ? payload.expected_run_count : runs.length}`);
    add('Failed or infrastructure failures', failed);
    add('Window', `${payload.window_start || 'unknown'} to ${payload.window_end || 'unknown'}`);
  } else if (metricName === 'confirmed_regressions') {
    const items = Array.isArray(payload.regressions) ? payload.regressions : [];
    add('Confirmed count', items.length);
    add('Eligible releases', payload.eligible_releases);
    add('Survey', payload.survey_complete === true ? 'Complete' : 'Incomplete');
    add('Cohort', payload.cohort_policy);
  }
  return rows;
}

function metricDisplay(metricName, point) {
  const payload = point && point.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (metricName === 'complex_functions') return `${payload.above_threshold_functions} above threshold / ${payload.eligible_functions} eligible`;
  if (metricName === 'unused_candidates') return `${payload.candidate_count} candidates · ${payload.graph_status === 'unqualified' ? 'unqualified graph' : 'qualified graph'}`;
  if (metricName === 'coverage') {
    const percent = Number.isFinite(payload.covered) && Number.isFinite(payload.eligible) && payload.eligible > 0
      ? ` (${Math.round((payload.covered / payload.eligible) * 100)}%)` : '';
    return `${payload.covered} / ${payload.eligible} ${point.unit || 'items'}${percent}`;
  }
  if (metricName === 'ci_first_attempt') {
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    const success = runs.filter((run) => run && run.overall_conclusion === 'success').length;
    const expected = Number.isSafeInteger(payload.expected_run_count) ? payload.expected_run_count : runs.length;
    return `${success} / ${expected} first attempts passed`;
  }
  if (metricName === 'confirmed_regressions') {
    if (payload.survey_complete !== true) return null;
    return `${Array.isArray(payload.regressions) ? payload.regressions.length : 0} confirmed`;
  }
  return null;
}

function pointStatus(point) {
  if (!point) return { status: 'unknown', reason: 'no-retained-sample' };
  const current = point.current_status || point.status || 'unknown';
  return {
    status: current,
    reason: current === 'stale' ? 'stale-source' : point.reason || null,
  };
}

function compatibleBaseline(points, latest) {
  if (!latest || latest.status !== 'measured' || !latest.series_key) return null;
  const compatible = points.filter((point) => point && point.kind === 'snapshot' && point.status === 'measured'
    && point.current_status === 'measured' && !point.superseded && point.series_key === latest.series_key);
  if (compatible.length < 2) return null;
  compatible.sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.collected_at.localeCompare(b.collected_at));
  const first = compatible[0];
  return first.snapshot_id === latest.snapshot_id ? compatible[compatible.length - 2] : first;
}

function normalizeObjectiveSlot(slot, metric, nowIso, sprintMarkers) {
  const points = Array.isArray(slot.points) ? slot.points : [];
  const latest = slot.latest || null;
  const status = pointStatus(latest);
  const latestValue = status.status === 'measured' ? metricDisplay(metric.id, latest) : null;
  const baseline = compatibleBaseline(points, latest);
  const sprint = sprintMarkers.find((marker) => marker && marker.slot_ref === slot.slot_ref
    && marker.series_key && marker.series_key === latest?.series_key) || null;
  const scope = typeof slot.scope === 'string' && slot.scope ? slot.scope : 'repository';
  const history = points.filter((point) => point && point.kind === 'snapshot' && !point.superseded)
    .slice(-MAX_HISTORY_POINTS)
    .map((point) => ({ at: compactTime(point.observed_at), status: point.current_status || point.status, value: metricDisplay(metric.id, point), revision: shortRevision(point.commit) }))
    .filter((point) => point.at);
  const reasonCode = status.reason;
  return {
    slot: `${metric.id}:${scope}`,
    module: scope,
    moduleLabel: scope === 'repository' ? 'Repository scope' : scope,
    language: slot.language || null,
    platform: slot.platform || null,
    unit: metric.unit,
    status: status.status,
    reason: reasonCode ? (REASON_LABELS[reasonCode] || 'The source has no usable value for this point.') : null,
    reasonCode: reasonCode || null,
    value: latestValue,
    observedAt: compactTime(latest?.observed_at),
    collectedAt: compactTime(latest?.collected_at),
    revision: shortRevision(latest?.commit),
    metricVersion: latest?.metric_version || null,
    scopeVersion: latest?.scope_version || null,
    tool: latest?.tool && typeof latest.tool.name === 'string'
      ? `${latest.tool.name}${latest.tool.version ? ` ${latest.tool.version}` : ''}` : null,
    configVersion: shortDigest(latest?.config_digest),
    scopeDigest: shortDigest(latest?.scope_digest),
    featureRefCount: Array.isArray(latest?.feature_refs) ? latest.feature_refs.length : 0,
    evidence: latestValue ? evidenceRows(metric.id, latest.payload) : [],
    baseline: baseline ? { at: compactTime(baseline.observed_at), value: metricDisplay(metric.id, baseline), revision: shortRevision(baseline.commit) } : null,
    baselineNote: baseline ? null : (latestValue ? 'One retained point or no compatible series baseline.' : 'No compatible baseline is available.'),
    sprint: sprint ? { label: String(sprint.label || 'Sprint marker').slice(0, 80), at: compactTime(sprint.at), value: metricDisplay(metric.id, sprint.point) } : null,
    sprintNote: sprint ? null : 'No sprint marker supplied.',
    history,
    retentionMonths: 6,
    freshnessMs: Number.isFinite(slot.freshness_ms) ? slot.freshness_ms : null,
    asOf: nowIso,
  };
}

function chooseWorkerRecord(records, retentionById = new Map()) {
  const workers = records.filter((record) => record?.reporter?.kind === 'worker');
  return workers.find((record) => retentionById.get(record.record_id)?.classification === 'public')
    || workers[0] || null;
}

function summarizeSubjective(source, repoName, resolvedRefs = {}, { cohort = 'all' } = {}) {
  const records = Array.isArray(source?.records) ? source.records : [];
  const contextRecords = Array.isArray(source?.contextRecords) ? source.contextRecords : [];
  const retentionById = new Map([...records, ...contextRecords]
    .filter((item) => item?.record?.record_id)
    .map((item) => [item.record.record_id, item.retention || {}]));
  const workerRecords = records.filter((item) => item?.record?.repo_name === repoName && item.record?.reporter?.kind === 'worker').map((item) => item.record);
  const aggregate = source?.aggregate || {};
  const occurrences = (Array.isArray(aggregate.occurrences) ? aggregate.occurrences : []).filter((group) => group?.repo_name === repoName);
  const attempts = (Array.isArray(aggregate.assessment_attempts) ? aggregate.assessment_attempts : []).filter((group) => group?.repo_name === repoName);
  const counts = { locate: { helpful: 0, friction: 0 }, understand: { helpful: 0, friction: 0 }, verify: { helpful: 0, friction: 0 } };
  const occurrenceEvidence = [];
  const moduleCounts = new Map();
  let conflictedOccurrences = 0;
  for (const group of occurrences) {
    const workerRows = (Array.isArray(group.records) ? group.records : []).filter((record) => record?.reporter?.kind === 'worker');
    const dimensions = new Set(workerRows.map((record) => record.dimension));
    const polarities = new Set(workerRows.map((record) => record.polarity));
    const causes = new Set(workerRows.map((record) => record.cause));
    if (workerRows.length === 0) continue;
    if (group.conflict || dimensions.size !== 1 || polarities.size !== 1 || causes.size !== 1) {
      conflictedOccurrences += 1;
      continue;
    }
    const [dimension] = dimensions;
    const [polarity] = polarities;
    if (counts[dimension]) counts[dimension][polarity === 'positive' ? 'helpful' : 'friction'] += 1;
    const representative = chooseWorkerRecord(workerRows, retentionById);
    for (const ref of representative.module_refs || []) {
      const label = resolvedRefs[ref];
      if (typeof label !== 'string' || !label.trim()) continue;
      const safeLabel = label.trim().slice(0, 80);
      moduleCounts.set(safeLabel, (moduleCounts.get(safeLabel) || 0) + 1);
    }
    if (occurrenceEvidence.length < 8) {
      occurrenceEvidence.push({
        dimension,
        polarity: polarity === 'positive' ? 'helpful' : 'friction',
        cause: [...causes][0],
        summary: retentionById.get(representative.record_id)?.classification === 'public'
          && typeof representative.summary === 'string' ? representative.summary.slice(0, 180) : null,
      });
    }
  }

  const distributions = { locate: {}, understand: {}, verify: {} };
  const outcomes = {};
  const completeness = { complete: 0, partial: 0, conflicting: 0 };
  const cohorts = new Map();
  let eligibleAssessments = 0;
  let notApplicable = 0;
  for (const group of attempts) {
    const rows = Array.isArray(group.records) ? group.records : [];
    const workerAssessment = rows.find((record) => record?.reporter?.kind === 'worker')
      || rows.find((record) => record?.record_kind === 'assessment');
    if (!workerAssessment) continue;
    if (group.applicability_conflict || group.rating_conflict) {
      completeness.conflicting += 1;
      continue;
    }
    if (group.not_applicable) {
      notApplicable += 1;
      continue;
    }
    if (!group.applicable) continue;
    eligibleAssessments += 1;
    completeness[workerAssessment.completeness] = (completeness[workerAssessment.completeness] || 0) + 1;
    outcomes[workerAssessment.outcome] = (outcomes[workerAssessment.outcome] || 0) + 1;
    for (const rating of workerAssessment.ratings || []) {
      if (!distributions[rating.dimension]) continue;
      const value = rating.value === 'not-assessable' ? 'not-assessable' : rating.value;
      distributions[rating.dimension][value] = (distributions[rating.dimension][value] || 0) + 1;
    }
    const model = workerAssessment.actual_worker?.observed_model || 'unknown';
    cohorts.set(model, (cohorts.get(model) || 0) + 1);
  }

  const collection = source?.collection || {};
  return {
    status: collection.status || 'unconfigured',
    lastAttemptAt: compactTime(collection.last_attempt_at),
    lastSuccessAt: compactTime(collection.last_success_at),
    lastError: collection.last_error_code ? (REASON_LABELS[collection.last_error_code] || STATUS_LABELS[collection.last_error_code] || 'The last source attempt did not complete.') : null,
    rubric: 'changeability-1.0',
    workerSamples: workerRecords.length,
    observationOccurrences: occurrences.length - conflictedOccurrences,
    conflictedOccurrences,
    assessmentAttempts: attempts.length,
    eligibleAssessments,
    notApplicable,
    expectedEligibleAttempts: null,
    participation: null,
    participationNote: 'No expected eligible task identity set is supplied; participation rate is unavailable.',
    completeness,
    outcomes,
    distributions,
    helpfulFriction: counts,
    recurrentModules: [...moduleCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([label, count]) => ({ label, count })),
    unresolvedModuleRefs: workerRecords.reduce((sum, record) => sum + (record.module_refs || []).filter((ref) => !resolvedRefs[ref]).length, 0),
    cohorts: [...cohorts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([model, count]) => ({ model, count })),
    evidence: occurrenceEvidence,
    cohortFilter: cohort,
    cohortNote: 'Cohort filtering applies to subjective evidence only and uses the worker model observed by the producer.',
    summaryNote: 'Summary text is shown only for records retained as public; all other or unknown classifications are redacted.',
    retentionMonths: 6,
    sampleNote: 'Worker observations are counted by occurrence. Parent and Close records are context and do not add occurrences.',
  };
}

function buildCodeHealthView({
  repoName,
  days = 90,
  module = 'all',
  cohort = 'all',
  objectiveHistory = {},
  objectiveSource = {},
  subjective = {},
  sprintMarkers = [],
  resolvedEvidenceRefs = {},
  subjectiveModuleLabels = {},
  subjectiveCohorts = [],
  now = new Date(),
} = {}) {
  const repo = registeredRepositories().find((item) => item.name === repoName);
  if (!repo) throw new TypeError('repository is not registered');
  if (![30, 90, 365].includes(days)) throw new TypeError('period must be 30, 90, or 365 days');
  const slots = Array.isArray(objectiveHistory.slots) ? objectiveHistory.slots : [];
  const modules = [...new Set(slots.map((slot) => typeof slot.scope === 'string' && slot.scope ? slot.scope : 'repository'))].sort();
  const extraModules = Object.keys(subjectiveModuleLabels).filter((ref) => /^subjective:[a-f0-9]{24}$/.test(ref));
  const filterModules = [...new Set([...modules, ...extraModules])].sort();
  const selectedModule = module === 'all' || filterModules.includes(module) ? module : 'all';
  const cohortOptions = [...new Set(subjectiveCohorts.filter((item) => typeof item === 'string' && item.length <= 160))].sort();
  const selectedCohort = cohort === 'all' || cohortOptions.includes(cohort) ? cohort : 'all';
  const scopeSlots = selectedModule === 'all' ? slots : slots.filter((slot) => (slot.scope || 'repository') === selectedModule);
  const nowDate = now instanceof Date ? now : new Date(now);
  const asOf = compactTime(objectiveHistory.as_of) || compactTime(nowDate.toISOString()) || new Date().toISOString();
  const sections = METRICS.map((metric) => ({
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    help: metric.help,
    slots: scopeSlots.filter((slot) => slot.metric === metric.id)
      .slice(0, 40)
      .map((slot) => normalizeObjectiveSlot(slot, metric, asOf, Array.isArray(sprintMarkers) ? sprintMarkers : [])),
  }));
  const retentionMonths = Number.isSafeInteger(objectiveHistory.retention_months) && objectiveHistory.retention_months > 0
    ? objectiveHistory.retention_months : 6;
  const olderEvidenceMayBeAbsent = days === 365 && retentionMonths < 12;
  return {
    version: 1,
    repository: repo,
    period: {
      requestedDays: days,
      since: compactTime(objectiveHistory.since),
      asOf,
      retainedMonths: retentionMonths,
      olderEvidenceMayBeAbsent,
    },
    filters: {
      repository: repo.name,
      period: days,
      module: selectedModule,
      modules: filterModules,
      moduleLabels: Object.fromEntries(extraModules.map((ref) => [ref, String(subjectiveModuleLabels[ref]).slice(0, 80)])),
      cohort: selectedCohort,
      cohorts: cohortOptions,
      periods: [30, 90, 365],
    },
    objectiveCollection: {
      status: objectiveSource.status || 'unconfigured',
      lastAttemptAt: compactTime(objectiveSource.last_attempt_at),
      lastAttemptStatus: objectiveSource.last_attempt_status || null,
      lastSuccessAt: compactTime(objectiveSource.last_success_at),
      lastError: objectiveSource.last_error_code ? (REASON_LABELS[objectiveSource.last_error_code] || STATUS_LABELS[objectiveSource.last_error_code] || 'The last source attempt did not complete.') : null,
      note: objectiveSource.status === 'disabled' ? 'Objective collection is disabled.'
        : objectiveSource.status === 'unconfigured' ? 'No authenticated objective transport is configured.'
          : null,
    },
    objective: sections,
    subjective: summarizeSubjective(subjective, repo.name, resolvedEvidenceRefs, { cohort: selectedCohort }),
    acceptance: {
      producer: 'No live Hugin capture is connected.',
      mode: 'Fixture-only UI acceptance; stored evidence is read-only.',
      writesEnabled: false,
    },
  };
}

function statusBadge(status) {
  const safeStatus = Object.hasOwn(STATUS_LABELS, status) ? status : 'unknown';
  const style = safeStatus === 'measured' ? 'is-ok'
    : ['failed', 'rejected'].includes(safeStatus) ? 'is-crit'
      : ['stale', 'unknown', 'not-collected', 'unconfigured', 'disabled', 'unavailable', 'incomplete'].includes(safeStatus) ? 'is-warn' : 'is-info';
  return `<span class="status-badge ${style}"><span class="glyph" aria-hidden="true">${style === 'is-ok' ? '●' : style === 'is-crit' ? '!' : style === 'is-warn' ? '◌' : '○'}</span>${esc(STATUS_LABELS[safeStatus] || 'Unknown')}</span>`;
}

function pair(label, value) {
  return `<div class="ch-pair"><dt>${esc(label)}</dt><dd>${value == null || value === '' ? '—' : esc(value)}</dd></div>`;
}

function objectiveCard(metric, view) {
  const cards = metric.slots.length ? metric.slots.map((slot) => {
    const evidence = slot.evidence.length
      ? `<dl class="ch-evidence">${slot.evidence.map((row) => pair(row.label, row.value)).join('')}</dl>`
      : `<p class="ch-muted">${esc(slot.reason || (slot.status === 'unsupported' ? 'This registered scope is unsupported.' : 'No bounded evidence rows are retained.'))}</p>`;
    const baseline = slot.baseline
      ? `${esc(slot.baseline.value || '—')} · ${esc(slot.baseline.at || 'unknown date')} · ${slot.baseline.revision ? `revision ${esc(slot.baseline.revision)}` : 'revision unknown'}`
      : esc(slot.baselineNote);
    const source = [slot.language, slot.platform, slot.metricVersion, slot.scopeVersion,
      slot.featureRefCount ? `${slot.featureRefCount} feature scope(s)` : null].filter(Boolean).join(' · ');
    const history = slot.history.length > 1
      ? `<details class="ch-history"><summary>History (${slot.history.length} points, at most ${MAX_HISTORY_POINTS})</summary><ol>${slot.history.map((point) => `<li>${esc(point.at)} · ${esc(point.value || STATUS_LABELS[point.status] || 'Unknown')}${point.revision ? ` · ${esc(point.revision)}` : ''}</li>`).join('')}</ol></details>`
      : '<p class="ch-muted">One-point history has no trend.</p>';
    return `<article class="ch-objective-row" data-module="${esc(slot.module)}">
      <div class="ch-row-head"><div><h3>${esc(slot.moduleLabel)}</h3><p class="ch-source">${esc(source || 'Source scope details unavailable')}</p></div>${statusBadge(slot.status)}</div>
      <p class="ch-value">${slot.value == null ? '—' : esc(slot.value)}</p>
      ${slot.reason ? `<p class="ch-reason">${esc(slot.reason)}</p>` : ''}
      <dl class="ch-evidence">${pair('Observed', slot.observedAt)}${pair('Collected', slot.collectedAt)}${pair('Revision', slot.revision)}${pair('Tool', slot.tool || 'Unknown')}${pair('Config digest', slot.configVersion || 'Unknown')}${pair('Scope digest', slot.scopeDigest || 'Unknown')}</dl>
      ${evidence}
      <div class="ch-baseline"><strong>Compatible baseline</strong><span>${baseline}</span></div>
      <div class="ch-baseline"><strong>Sprint marker</strong><span>${esc(slot.sprint?.label || slot.sprintNote || 'No sprint marker supplied.')}</span></div>
      ${history}
    </article>`;
  }).join('') : '<p class="ch-muted">No registered metric slots match this module filter.</p>';
  return `<section class="card ch-metric" aria-labelledby="ch-${esc(metric.id)}"><header class="ch-metric-head"><div><h2 id="ch-${esc(metric.id)}">${esc(metric.label)}</h2><p>${esc(metric.help)}</p></div><span class="ch-unit">${esc(metric.unit)}</span></header><div class="ch-objective-list">${cards}</div></section>`;
}

function countList(values) {
  const entries = Object.entries(values || {}).filter(([, count]) => Number.isSafeInteger(count) && count > 0).slice(0, 12);
  return entries.length ? `<ul>${entries.map(([label, count]) => `<li>${esc(label)} <strong>${count}</strong></li>`).join('')}</ul>` : '<p class="ch-muted">No retained samples.</p>';
}

function subjectiveSection(subjective) {
  const dimensions = ['locate', 'understand', 'verify'];
  const dimensionRows = dimensions.map((dimension) => `<tr><th scope="row">${dimension}</th><td>${subjective.helpfulFriction[dimension].helpful}</td><td>${subjective.helpfulFriction[dimension].friction}</td><td>${countList(subjective.distributions[dimension])}</td></tr>`).join('');
  const evidence = subjective.evidence.length
    ? `<ul class="ch-observation-list">${subjective.evidence.map((item) => `<li><span class="ch-pill">${esc(item.dimension)} · ${esc(item.polarity)}</span><span>${esc(item.summary || 'No summary supplied.')}</span><small>${esc(item.cause)} cause</small></li>`).join('')}</ul>`
    : '<p class="ch-muted">No worker occurrence examples are retained.</p>';
  return `<section class="card ch-subjective" aria-labelledby="ch-subjective-title">
    <header class="ch-metric-head"><div><h2 id="ch-subjective-title">Subjective evidence</h2><p>Separate worker observations and rubric assessments; these are not combined with objective metrics.</p></div>${statusBadge(subjective.status)}</header>
    <p class="ch-callout">Rubric <strong>${esc(subjective.rubric)}</strong>. ${esc(subjective.sampleNote)}</p>
    ${subjective.lastError ? `<p class="ch-reason">${esc(subjective.lastError)}</p>` : ''}
    <div class="ch-subjective-kpis"><div><strong>${subjective.workerSamples}</strong><span>worker records</span></div><div><strong>${subjective.observationOccurrences}</strong><span>worker occurrences</span></div><div><strong>${subjective.eligibleAssessments}</strong><span>eligible assessments</span></div><div><strong>—</strong><span>participation · denominator unknown</span></div></div>
    <p class="ch-muted">${esc(subjective.participationNote)} ${subjective.conflictedOccurrences ? `${subjective.conflictedOccurrences} conflicting occurrence(s) are excluded from helpful/friction counts.` : ''}</p>
    <div class="ch-subjective-grid"><div><h3>Helpful and friction occurrences</h3><div class="ch-table-wrap"><table><thead><tr><th>Dimension</th><th>Helpful</th><th>Friction</th><th>Assessment ratings</th></tr></thead><tbody>${dimensionRows}</tbody></table></div></div>
      <div class="ch-subjective-breakdown"><h3>Completeness</h3>${countList(subjective.completeness)}<h3>Outcomes</h3>${countList(subjective.outcomes)}<h3>Worker model cohort</h3>${countList(Object.fromEntries(subjective.cohorts.map((item) => [item.model, item.count])))}</div></div>
    <div class="ch-subjective-grid"><div><h3>Recurrent registered modules</h3>${subjective.recurrentModules.length ? `<ul>${subjective.recurrentModules.map((item) => `<li>${esc(item.label)} <strong>${item.count}</strong></li>`).join('')}</ul>` : `<p class="ch-muted">No module references resolved through a registered artifact.${subjective.unresolvedModuleRefs ? ` ${subjective.unresolvedModuleRefs} module reference(s) remain unresolved.` : ''}</p>`}</div><div><h3>Bounded examples</h3>${evidence}</div></div>
    <p class="ch-muted">${esc(subjective.cohortNote || 'Cohort filtering applies to subjective evidence only and uses the worker model observed by the producer.')}</p>
    <p class="ch-muted">${esc(subjective.summaryNote || 'Summary text is shown only for records retained as public; all other or unknown classifications are redacted.')}</p>
    <p class="ch-muted">Expected eligible task identities are not supplied, so no participation percentage is shown. Parent and Close observations provide context and do not increase occurrence counts.</p>
  </section>`;
}

function codeHealthPage(gitVersion, view) {
  const repoOptions = registeredRepositories().map((repo) => `<option value="${esc(repo.name)}"${repo.name === view.repository.name ? ' selected' : ''}>${esc(repo.label)}</option>`).join('');
  const periodOptions = view.filters.periods.map((days) => `<option value="${days}"${days === view.period.requestedDays ? ' selected' : ''}>${days} days</option>`).join('');
  const moduleOptions = ['all', ...view.filters.modules].map((module) => {
    const label = module === 'all' ? 'All modules' : module === 'repository' ? 'Repository scope' : view.filters.moduleLabels?.[module] || module;
    return `<option value="${esc(module)}"${module === view.filters.module ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const cohortOptions = ['all', ...view.filters.cohorts].map((cohort) => `<option value="${esc(cohort)}"${cohort === view.filters.cohort ? ' selected' : ''}>${esc(cohort === 'all' ? 'All worker models' : cohort)}</option>`).join('');
  const objectiveSections = view.objective.map((metric) => objectiveCard(metric, view)).join('');
  const status = view.objectiveCollection.status;
  const fresh = view.objectiveCollection.lastSuccessAt ? `Last stored success ${view.objectiveCollection.lastSuccessAt}` : 'No stored successful collection';
  const retentionNotice = view.period.olderEvidenceMayBeAbsent ? `<p class="ch-callout">Older records may be absent from this ${view.period.requestedDays}-day requested window; records are retained for ${view.period.retainedMonths} calendar months from collection.</p>` : '';
  const retentionLabel = `${view.period.retainedMonths} calendar month${view.period.retainedMonths === 1 ? '' : 's'}`;
  const collectionNote = view.objectiveCollection.note || view.objectiveCollection.lastError || 'Stored snapshots only; rendering does not collect evidence.';
  const content = `<main class="code-health-page">
    <header class="ch-page-head"><div><p class="ch-eyebrow">Code health · read-only evidence</p><h1>${esc(view.repository.label)}</h1><p>Objective measurements and subjective worker observations remain separate.</p></div><div class="ch-collection-status">${statusBadge(status)}<span>${esc(fresh)}</span></div></header>
    <form class="ch-filters" method="get" action="/code-health"><label>Repository<select name="repo">${repoOptions}</select></label><label>Period<select name="days">${periodOptions}</select></label><label>Module<select name="module">${moduleOptions}</select></label><label>Worker model cohort <span class="ch-muted">(subjective only)</span><select name="cohort">${cohortOptions}</select></label><button type="submit">Apply filters</button></form>
    ${retentionNotice}
    <p class="ch-note">${esc(collectionNote)} Last attempt: ${view.objectiveCollection.lastAttemptAt ? esc(view.objectiveCollection.lastAttemptAt) : 'none recorded'}; status: ${esc(STATUS_LABELS[view.objectiveCollection.lastAttemptStatus] || STATUS_LABELS[status] || status)}. Records are retained for ${retentionLabel} from collection.</p>
    ${view.acceptance.writesEnabled ? '' : '<p class="ch-callout">No live Hugin capture is connected. Fixture-only UI acceptance; no producer is enabled here.</p>'}
    <div class="ch-objective-grid">${objectiveSections}</div>
    ${subjectiveSection(view.subjective)}
    <footer class="ch-page-foot">As of ${esc(view.period.asOf)} · ${view.period.requestedDays}-day requested window · no score, ranking, or automatic action.</footer>
  </main>`;
  return pageShell({
    title: `Heimdall — Code health — ${view.repository.label}`,
    active: '/code-health',
    gitVersion,
    content,
    head: `  <link rel="stylesheet" href="/css/code-health.css?v=${esc(gitVersion || 'dev')}">`,
  });
}

module.exports = { METRICS, MAX_HISTORY_POINTS, buildCodeHealthView, codeHealthPage, registeredRepositories, summarizeSubjective };
