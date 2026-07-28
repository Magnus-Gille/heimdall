'use strict';

// Byte-for-byte contract source is vendored under docs/vendor; this is the
// deliberately small JS verifier for the closed, metadata-only v1 projection.
// It has no controller, delivery, policy, target, or recovery capability.
const crypto = require('node:crypto');
const ID = /^[a-z][a-z0-9-]{2,62}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const PHASES = new Set(['prepare', 'apply', 'verify', 'watch', 'commit', 'unknown', 'recover', 'quarantine', 'disarm', 'terminally-blocked']);
const BOUNDS = { prepare: [1, 1], apply: [2, 2], verify: [3, 3], watch: [4, 4], commit: [5, 5], unknown: [2, 5], recover: [3, 6], quarantine: [4, 7], disarm: [5, 8], 'terminally-blocked': [3, 8] };
const MAX_WITHOUT_WATCH = { prepare: 1, apply: 2, verify: 3, unknown: 4, recover: 5, quarantine: 6, disarm: 7, 'terminally-blocked': 7 };
const MIN_WITH_WATCH = { watch: 4, commit: 5, unknown: 5, recover: 6, quarantine: 7, disarm: 8, 'terminally-blocked': 6 };
const TOP = ['kind', 'schema_version', 'result_id', 'source', 'freshness', 'execution_epoch', 'journal', 'receipt', 'probe_coverage', 'reconciliation', 'phase', 'outcome', 'health', 'promotion_eligible', 'recovery', 'result_digest', 'extensions'];
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const validResultUtc = (v) => typeof v === 'string' && UTC.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v;
const strictUtc = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v;
const validId = (v) => typeof v === 'string' && ID.test(v);
const validDigest = (v) => typeof v === 'string' && DIGEST.test(v);
const canonicalJson = (v) => v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}` : Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]` : JSON.stringify(v);
function autonomyDigest(v, omit) { const copy = JSON.parse(JSON.stringify(v)); if (omit) delete copy[omit]; return `sha256:${crypto.createHash('sha256').update(canonicalJson(copy)).digest('hex')}`; }
function fail(reason) { return { ok: false, reason }; }
function boundedStructure(root) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++nodes > 10000 || depth > 64) return false;
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}
function expectedOutcome(r) {
  if (r.reconciliation === 'unreconciled') return 'unreconciled';
  if (r.reconciliation === 'failed') return 'failed';
  if (r.phase === 'unknown') return 'unknown';
  if (r.phase === 'terminally-blocked') return 'terminally-blocked';
  if (r.phase === 'disarm') return 'disarmed';
  if (r.phase === 'recover' || r.phase === 'quarantine') return 'recovered-by-worker';
  if (r.phase === 'commit') return Date.parse(r.freshness.evaluated_at) >= Date.parse(r.freshness.valid_until) ? 'stale' : (r.probe_coverage.expected_count > 0 && r.probe_coverage.state === 'complete' ? 'clean' : 'unknown');
  return 'failed';
}
function recoveryFor(outcome) { return outcome === 'clean' ? 'not-required' : ['unknown', 'stale', 'unreconciled'].includes(outcome) ? 'unknown' : outcome; }
function validateMaintenanceExecutionResult(r, now = Date.now()) {
  if (!Number.isFinite(now) || !boundedStructure(r) || !exact(r, TOP) || r.kind !== 'maintenance-execution-result' || r.schema_version !== 'v1' || !Array.isArray(r.extensions) || r.extensions.length || !validDigest(r.result_digest) || r.result_digest !== autonomyDigest(r, 'result_digest')) return fail('schema');
  if (!exact(r.source, ['source_id', 'source_revision_digest', 'configuration_digest']) || r.source.source_id !== 'brokkr-maintenance' || !validId(r.source.source_id) || !validDigest(r.source.source_revision_digest) || !validDigest(r.source.configuration_digest)) return fail('source');
  if (!exact(r.freshness, ['observed_at', 'valid_until', 'evaluated_at']) || !validResultUtc(r.freshness.observed_at) || !validResultUtc(r.freshness.valid_until) || !validResultUtc(r.freshness.evaluated_at) || Date.parse(r.freshness.valid_until) <= Date.parse(r.freshness.observed_at) || Date.parse(r.freshness.evaluated_at) < Date.parse(r.freshness.observed_at) || Date.parse(r.freshness.observed_at) > now || Date.parse(r.freshness.evaluated_at) > now) return fail('freshness');
  if (!Number.isSafeInteger(r.execution_epoch) || r.execution_epoch < 1) return fail('epoch');
  if (!exact(r.journal, ['journal_id', 'binding_digest', 'config_digest', 'tail_sequence', 'tail_recorded_at', 'tail_receipt_digest', 'watch_anchor']) || !validId(r.journal.journal_id) || !validDigest(r.journal.binding_digest) || r.result_id !== `result-${r.journal.binding_digest.slice(7, 39)}` || !validId(r.result_id) || r.journal.config_digest !== r.source.configuration_digest || !Number.isInteger(r.journal.tail_sequence) || r.journal.tail_sequence < 1 || !strictUtc(r.journal.tail_recorded_at) || Date.parse(r.freshness.evaluated_at) < Date.parse(r.journal.tail_recorded_at) || !validDigest(r.journal.tail_receipt_digest)) return fail('journal');
  const bounds = BOUNDS[r.phase]; if (!bounds || r.journal.tail_sequence < bounds[0] || r.journal.tail_sequence > bounds[1]) return fail('sequence');
  const a = r.journal.watch_anchor; const anchorRequired = r.phase === 'watch' || r.phase === 'commit' || (MAX_WITHOUT_WATCH[r.phase] !== undefined && r.journal.tail_sequence > MAX_WITHOUT_WATCH[r.phase]);
  if (a === null ? anchorRequired : !(MIN_WITH_WATCH[r.phase] !== undefined && r.journal.tail_sequence >= MIN_WITH_WATCH[r.phase] && exact(a, ['kind', 'schema_version', 'journal_id', 'mutation_id', 'attempt_id', 'target_scope_digest', 'candidate_digest', 'binding_digest', 'journal_tail_digest', 'anchored_at', 'anchor_digest']) && a.kind === 'brokkr-durable-watch-anchor' && a.schema_version === 'v1' && a.journal_id === r.journal.journal_id && a.mutation_id === r.journal.journal_id && a.binding_digest === r.journal.binding_digest && validId(a.mutation_id) && validId(a.attempt_id) && validDigest(a.target_scope_digest) && validDigest(a.candidate_digest) && validDigest(a.journal_tail_digest) && strictUtc(a.anchored_at) && Date.parse(r.freshness.evaluated_at) >= Date.parse(a.anchored_at) && (r.phase === 'watch' || Date.parse(r.journal.tail_recorded_at) >= Date.parse(a.anchored_at)) && a.anchor_digest === autonomyDigest(a, 'anchor_digest'))) return fail('watch_anchor');
  if (r.phase === 'commit' && (Date.parse(r.journal.tail_recorded_at) - Date.parse(a && a.anchored_at) < 3600000 || Date.parse(r.journal.tail_recorded_at) - Date.parse(a && a.anchored_at) > 3900000)) return fail('watch_window');
  if (!exact(r.receipt, ['receipt_id', 'receipt_digest', 'journal_id', 'binding_digest', 'journal_tail_digest', 'reconciliation']) || !validId(r.receipt.receipt_id) || r.receipt.receipt_digest !== autonomyDigest(r.receipt, 'receipt_digest') || r.receipt.journal_id !== r.journal.journal_id || r.receipt.binding_digest !== r.journal.binding_digest || r.receipt.journal_tail_digest !== r.journal.tail_receipt_digest || r.receipt.reconciliation !== r.reconciliation || !['reconciled', 'unreconciled', 'failed'].includes(r.reconciliation)) return fail('receipt');
  if (!exact(r.probe_coverage, ['expected_count', 'observed_count', 'state']) || !Number.isInteger(r.probe_coverage.expected_count) || r.probe_coverage.expected_count < 0 || r.probe_coverage.expected_count > 1024 || !Number.isInteger(r.probe_coverage.observed_count) || r.probe_coverage.observed_count < 0 || r.probe_coverage.observed_count > r.probe_coverage.expected_count || r.probe_coverage.state !== (r.probe_coverage.expected_count === 0 ? 'unknown' : r.probe_coverage.observed_count === r.probe_coverage.expected_count ? 'complete' : 'incomplete')) return fail('coverage');
  if (!PHASES.has(r.phase) || !['clean', 'unknown', 'stale', 'unreconciled', 'failed', 'recovered-by-worker', 'disarmed', 'terminally-blocked'].includes(r.outcome) || !['healthy', 'unknown', 'unhealthy'].includes(r.health) || typeof r.promotion_eligible !== 'boolean' || !exact(r.recovery, ['state', 'reason_digest']) || !['not-required', 'unknown', 'failed', 'recovered-by-worker', 'disarmed', 'terminally-blocked'].includes(r.recovery.state) || (r.recovery.reason_digest !== null && !validDigest(r.recovery.reason_digest))) return fail('state');
  const outcome = expectedOutcome(r); const clean = outcome === 'clean' && r.probe_coverage.expected_count > 0 && r.probe_coverage.state === 'complete' && r.probe_coverage.observed_count === r.probe_coverage.expected_count; const health = clean ? 'healthy' : ['unknown', 'stale', 'unreconciled'].includes(outcome) ? 'unknown' : 'unhealthy';
  if (r.outcome !== outcome || r.health !== health || r.promotion_eligible !== clean || r.recovery.state !== recoveryFor(outcome) || (clean ? r.recovery.reason_digest !== null : !validDigest(r.recovery.reason_digest))) return fail('health_claim');
  return { ok: true, value: r };
}
function displayState(r, now = Date.now()) { const valid = validateMaintenanceExecutionResult(r, now); if (!valid.ok) return 'unknown'; if (Date.parse(r.freshness.valid_until) <= now) return 'stale'; return r.health === 'healthy' && r.promotion_eligible ? 'healthy' : r.outcome; }
module.exports = { validateMaintenanceExecutionResult, displayState, autonomyDigest, canonicalJson };
