'use strict';

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ID_RE = /^[a-z][a-z0-9-]{2,62}$/;
const UNIT_RE = /^(?!.*[\r\n])[A-Za-z0-9:_.@-]+\.(?:service|timer)$/;
const SHA_RE = /^sha256:[a-f0-9]{64}$/;
const TOP_KEYS = new Set(['kind', 'schema_version', 'baseline_id', 'baseline_digest', 'topology_authority', 'observed_at', 'evaluated_at', 'evaluated_at_source', 'freshness', 'notifiers', 'summary', 'units', 'findings', 'extensions']);
const UNIT_KEYS = new Set(['target_node_id', 'unit', 'owner', 'scope', 'workload_shape', 'timer_class', 'status', 'findings', 'evidence']);
const FINDING_KEYS = new Set(['code', 'severity', 'route']);
const GLOBAL_FINDING_KEYS = new Set([...FINDING_KEYS, 'target_node_id', 'scope', 'unit', 'owner']);
const EVIDENCE_KEYS = new Set(['unit_result', 'restart', 'watchdog', 'oom', 'timer']);
const RESULT_KEYS = new Set(['active_state', 'sub_state', 'result']);
const RESTART_KEYS = new Set(['count', 'window_start', 'window_end']);
const TIMER_KEYS = new Set(['last_run_at', 'next_run_at', 'last_result', 'missed_runs', 'persistent']);
const SCOPES = new Set(['system', 'user']);
const SHAPES = new Set(['long-running', 'oneshot', 'timer', 'unknown']);
const ACTIVE_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown']);
const RESULTS = new Set(['success', 'exit-code', 'signal', 'core-dump', 'watchdog', 'oom-kill', 'timeout', 'start-limit-hit', 'resources', 'protocol', 'condition', 'unknown']);
const WATCHDOG_RESULTS = new Set(['not-requested', 'ok', 'timeout', 'unknown']);
const OOM_RESULTS = new Set(['not-applicable', 'none', 'killed', 'unknown']);
const TIMER_RESULTS = new Set(['success', 'failed', 'not-run', 'unknown']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUtc = (value) => {
  if (typeof value !== 'string' || !UTC_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value;
};

function findingKey(value) {
  if (!isObject(value)) return '';
  return [value.code, value.severity, value.route, value.target_node_id, value.scope, value.unit, value.owner]
    .map((part) => part == null ? '' : String(part)).join('\u0000');
}

function hasDuplicateFindings(values) {
  const keys = values.map(findingKey);
  return new Set(keys).size !== keys.length;
}

function closedObject(value, allowed, path, errors) {
  if (!isObject(value)) { errors.push(`${path}:object`); return false; }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}:unknown-field`);
  return true;
}

function validateFinding(value, path, errors, global = false) {
  if (!closedObject(value, global ? GLOBAL_FINDING_KEYS : FINDING_KEYS, path, errors)) return;
  if (typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(value.code)) errors.push(`${path}:code`);
  if (!['error', 'warning'].includes(value.severity)) errors.push(`${path}:severity`);
  if (!['substrate', 'component-owner'].includes(value.route)) errors.push(`${path}:route`);
  if (value.target_node_id !== undefined && !ID_RE.test(value.target_node_id)) errors.push(`${path}:target-node`);
  if (value.scope !== undefined && !SCOPES.has(value.scope)) errors.push(`${path}:scope`);
  if (value.unit !== undefined && (typeof value.unit !== 'string' || value.unit.length > 128 || !UNIT_RE.test(value.unit))) errors.push(`${path}:unit`);
  if (value.owner !== undefined && !ID_RE.test(value.owner)) errors.push(`${path}:owner`);
}

function validateEvidence(value, path, errors) {
  if (!closedObject(value, EVIDENCE_KEYS, path, errors)) return;
  const result = value.unit_result;
  if (closedObject(result, RESULT_KEYS, `${path}.unit-result`, errors)) {
    if (!ACTIVE_STATES.has(result.active_state)) errors.push(`${path}:active-state`);
    if (typeof result.sub_state !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(result.sub_state)) errors.push(`${path}:sub-state`);
    if (!RESULTS.has(result.result)) errors.push(`${path}:result`);
  }
  if (value.restart !== null && closedObject(value.restart, RESTART_KEYS, `${path}.restart`, errors)) {
    if (!Number.isSafeInteger(value.restart.count) || value.restart.count < 0 || value.restart.count > 100000) errors.push(`${path}:restart-count`);
    if (!isUtc(value.restart.window_start) || !isUtc(value.restart.window_end)) errors.push(`${path}:restart-window`);
  }
  if (closedObject(value.watchdog, new Set(['result']), `${path}.watchdog`, errors)
      && !WATCHDOG_RESULTS.has(value.watchdog.result)) errors.push(`${path}:watchdog`);
  if (closedObject(value.oom, new Set(['result']), `${path}.oom`, errors)
      && !OOM_RESULTS.has(value.oom.result)) errors.push(`${path}:oom`);
  if (value.timer !== null && closedObject(value.timer, TIMER_KEYS, `${path}.timer`, errors)) {
    if (value.timer.last_run_at !== null && !isUtc(value.timer.last_run_at)) errors.push(`${path}:last-run`);
    if (value.timer.next_run_at !== null && !isUtc(value.timer.next_run_at)) errors.push(`${path}:next-run`);
    if (!TIMER_RESULTS.has(value.timer.last_result)) errors.push(`${path}:timer-result`);
    if (value.timer.missed_runs !== null && (!Number.isSafeInteger(value.timer.missed_runs) || value.timer.missed_runs < 0 || value.timer.missed_runs > 100000)) errors.push(`${path}:missed-runs`);
    if (value.timer.persistent !== null && typeof value.timer.persistent !== 'boolean') errors.push(`${path}:persistent`);
  }
}

function validateUnit(value, index, errors) {
  const path = `unit-${index}`;
  if (!closedObject(value, UNIT_KEYS, path, errors)) return;
  if (!ID_RE.test(value.target_node_id)) errors.push(`${path}:target-node`);
  if (typeof value.unit !== 'string' || value.unit.length > 128 || !UNIT_RE.test(value.unit)) errors.push(`${path}:unit`);
  if (!ID_RE.test(value.owner)) errors.push(`${path}:owner`);
  if (!SCOPES.has(value.scope)) errors.push(`${path}:scope`);
  if (!SHAPES.has(value.workload_shape)) errors.push(`${path}:shape`);
  if (value.timer_class !== null && !['calendar', 'monotonic'].includes(value.timer_class)) errors.push(`${path}:timer-class`);
  if (!['pass', 'fail'].includes(value.status)) errors.push(`${path}:status`);
  if (!Array.isArray(value.findings) || value.findings.length > 64) errors.push(`${path}:findings`);
  else {
    if (hasDuplicateFindings(value.findings)) errors.push(`${path}:duplicate-findings`);
    value.findings.forEach((finding, i) => validateFinding(finding, `${path}.finding-${i}`, errors));
  }
  if (value.evidence !== null) validateEvidence(value.evidence, `${path}.evidence`, errors);
}

function validateSupervisionAudit(value) {
  const errors = [];
  if (!closedObject(value, TOP_KEYS, 'audit', errors)) return { ok: false, errors };
  if (value.kind !== 'systemd-supervision-audit') errors.push('audit:kind');
  if (value.schema_version !== 'v1') errors.push('audit:version');
  if (value.baseline_id !== 'fleet-systemd-supervision') errors.push('audit:baseline');
  if (!SHA_RE.test(value.baseline_digest)) errors.push('audit:baseline-digest');
  if (value.topology_authority !== 'grimnir-service-registry') errors.push('audit:topology-authority');
  if (!isUtc(value.observed_at) || !isUtc(value.evaluated_at)) errors.push('audit:timestamp');
  if (!['clock', 'fixture-override'].includes(value.evaluated_at_source)) errors.push('audit:clock-source');

  if (closedObject(value.freshness, new Set(['status', 'age_seconds', 'max_age_seconds']), 'freshness', errors)) {
    if (!['fresh', 'stale', 'future'].includes(value.freshness.status)) errors.push('freshness:status');
    if (!Number.isSafeInteger(value.freshness.age_seconds) || value.freshness.age_seconds < 0) errors.push('freshness:age');
    if (!Number.isSafeInteger(value.freshness.max_age_seconds) || value.freshness.max_age_seconds < 1 || value.freshness.max_age_seconds > 86400) errors.push('freshness:max-age');
  }
  if (!Array.isArray(value.notifiers) || value.notifiers.length > 512) errors.push('audit:notifiers');
  else value.notifiers.forEach((notifier, i) => {
    const path = `notifier-${i}`;
    if (!closedObject(notifier, new Set(['target_node_id', 'status']), path, errors)) return;
    if (!ID_RE.test(notifier.target_node_id)) errors.push(`${path}:target-node`);
    if (!['available', 'absent', 'unknown'].includes(notifier.status)) errors.push(`${path}:status`);
  });
  if (closedObject(value.summary, new Set(['status', 'unit_count', 'compliant_unit_count', 'finding_count']), 'summary', errors)) {
    if (!['pass', 'fail'].includes(value.summary.status)) errors.push('summary:status');
    for (const field of ['unit_count', 'compliant_unit_count', 'finding_count']) {
      const maximum = field === 'finding_count' ? 4096 : 512;
      if (!Number.isSafeInteger(value.summary[field]) || value.summary[field] < 0 || value.summary[field] > maximum) errors.push(`summary:${field}`);
    }
  }
  if (!Array.isArray(value.units) || value.units.length > 512) errors.push('audit:units');
  else value.units.forEach((unit, i) => validateUnit(unit, i, errors));
  if (!Array.isArray(value.findings) || value.findings.length > 4096) errors.push('audit:findings');
  else {
    if (hasDuplicateFindings(value.findings)) errors.push('audit:duplicate-findings');
    value.findings.forEach((finding, i) => validateFinding(finding, `finding-${i}`, errors, true));
  }
  if (!Array.isArray(value.extensions) || value.extensions.length !== 0) errors.push('audit:extensions');
  return { ok: errors.length === 0, errors: errors.slice(0, 100) };
}

function deriveUnitState(unit, context = {}) {
  const codes = new Set((unit.findings || []).map((finding) => finding.code));
  const notifier = context.notifiers instanceof Map ? context.notifiers.get(`${unit.target_node_id}:${unit.scope}`) : undefined;
  const stale = context.freshness === 'stale' || context.freshness === 'future';
  const managerUnavailable = notifier === 'absent' || notifier === 'unknown' || codes.has('failure_delivery_unavailable');
  const absent = unit.evidence === null || codes.has('observation_missing');
  let state = 'pass';
  let classification = 'healthy';
  if (stale) { state = 'stale'; classification = 'stale-producer'; }
  else if (managerUnavailable) { state = 'unknown'; classification = 'manager-unavailable'; }
  else if (absent) { state = 'unknown'; classification = 'unit-absent'; }
  else {
    const evidence = unit.evidence;
    const timer = evidence.timer;
    const failed = evidence.unit_result.active_state === 'failed'
      || !['success', 'unknown'].includes(evidence.unit_result.result) || evidence.watchdog.result === 'timeout'
      || evidence.oom.result === 'killed' || codes.has('restart_storm');
    const unknown = evidence.unit_result.active_state === 'unknown' || evidence.unit_result.result === 'unknown'
      || evidence.watchdog.result === 'unknown' || evidence.oom.result === 'unknown';
    const neverRun = unit.workload_shape === 'timer' && timer
      && (timer.last_run_at === null || timer.last_result === 'not-run');
    const overdue = unit.workload_shape === 'timer' && timer
      && (codes.has('timer_overdue') || (Number.isInteger(timer.missed_runs) && timer.missed_runs > 0));
    const inactiveSuccess = unit.workload_shape === 'oneshot'
      && evidence.unit_result.active_state === 'inactive' && evidence.unit_result.result === 'success';
    if (failed) { state = 'fail'; classification = 'failed'; }
    else if (overdue) { state = 'fail'; classification = 'overdue'; }
    else if (neverRun) { state = 'unknown'; classification = 'never-run'; }
    else if (unknown) { state = 'unknown'; classification = 'unknown'; }
    else if (unit.status === 'fail') { state = 'fail'; classification = 'failed'; }
    else if (inactiveSuccess) classification = 'inactive-success';
  }
  const evidence = unit.evidence;
  const timer = evidence && evidence.timer;
  return {
    targetNodeId: unit.target_node_id, scope: unit.scope, unit: unit.unit,
    owner: unit.owner, workloadShape: unit.workload_shape, timerClass: unit.timer_class,
    state, classification,
    activeState: evidence ? evidence.unit_result.active_state : null,
    subState: evidence ? evidence.unit_result.sub_state : null,
    result: evidence ? evidence.unit_result.result : null,
    enabledState: null, processStartedAt: null, lastFailureAt: null, loadedRelease: null,
    restart: evidence && evidence.restart ? { count: evidence.restart.count, windowStart: evidence.restart.window_start, windowEnd: evidence.restart.window_end } : null,
    watchdog: evidence ? evidence.watchdog.result : null,
    oom: evidence ? evidence.oom.result : null,
    timer: unit.workload_shape === 'timer' ? {
      lastRunAt: timer ? timer.last_run_at : null, nextRunAt: timer ? timer.next_run_at : null,
      lastResult: timer ? timer.last_result : null, missedRuns: timer ? timer.missed_runs : null,
      lastDuration: null, persistent: timer ? timer.persistent : null,
      expectedCadence: null, retryState: null,
    } : null,
    findingCodes: [...codes].sort(),
  };
}

function unavailableProjection(reason, errors = []) {
  return { state: 'unknown', freshness: reason, observedAt: null, receivedEvidence: false, units: [], counts: { pass: 0, fail: 0, stale: 0, unknown: 0 }, validationErrors: errors.slice(0, 20) };
}

function projectSupervisionAudit(value, options = {}) {
  const checked = validateSupervisionAudit(value);
  if (!checked.ok) return unavailableProjection(value == null ? 'missing' : 'invalid', checked.errors);
  const now = options.now == null ? Date.now() : Number(options.now);
  const maxAgeMs = options.maxAgeMs == null ? 15 * 60 * 1000 : Math.max(1, Number(options.maxAgeMs));
  const futureSkewMs = options.futureSkewMs == null ? 5000 : Math.max(0, Number(options.futureSkewMs));
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || !Number.isFinite(futureSkewMs)) {
    return unavailableProjection('invalid-clock', ['projection:clock']);
  }
  const age = now - Date.parse(value.observed_at);
  const freshness = age < -futureSkewMs ? 'future' : (age >= maxAgeMs ? 'stale' : 'fresh');
  const notifiers = new Map();
  for (const notifier of value.notifiers) notifiers.set(`${notifier.target_node_id}:system`, notifier.status);
  const units = value.units.map((unit) => deriveUnitState(unit, { freshness, notifiers }));
  units.sort((a, b) => a.targetNodeId.localeCompare(b.targetNodeId) || a.scope.localeCompare(b.scope) || a.unit.localeCompare(b.unit));
  const counts = { pass: 0, fail: 0, stale: 0, unknown: 0 };
  for (const unit of units) counts[unit.state] += 1;
  const state = counts.fail > 0 ? 'fail' : (counts.stale > 0 ? 'stale' : (counts.unknown > 0 ? 'unknown' : 'pass'));
  return { state, freshness, observedAt: value.observed_at, receivedEvidence: true, units, counts, validationErrors: [] };
}

function enrichSupervisionProjection(projection, context = {}) {
  if (!projection || !Array.isArray(projection.units)) return projection;
  const versions = Array.isArray(context.versions) ? context.versions : [];
  const events = Array.isArray(context.events) ? context.events : [];
  return {
    ...projection,
    units: projection.units.map((unit) => {
      const base = unit.unit.replace(/\.(service|timer)$/, '');
      const version = versions.find((row) => row && row.service === base)
        || versions.find((row) => row && row.service === unit.owner);
      const failure = events.find((event) => event && event.severity === 'error'
        && event.title === `Service event: ${unit.unit}`);
      return {
        ...unit,
        loadedRelease: version && typeof version.deployed_commit === 'string'
          ? version.deployed_commit : unit.loadedRelease,
        lastFailureAt: failure && typeof failure.timestamp === 'string'
          ? failure.timestamp : unit.lastFailureAt,
      };
    }),
  };
}

module.exports = {
  validateSupervisionAudit,
  projectSupervisionAudit,
  deriveUnitState,
  enrichSupervisionProjection,
};
