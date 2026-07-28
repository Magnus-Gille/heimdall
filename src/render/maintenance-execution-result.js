'use strict';
const { card } = require('./cards');
const { esc } = require('./util');
const { validateMaintenanceExecutionResult, displayState } = require('../maintenance-execution-result');

// Observation only. This renderer is deliberately not fed into service/fleet
// liveness, alerting, promotion, or any actuator.
function renderMaintenanceExecutionResult(row, now = Date.now()) {
  const limits = 'Policy compliance, pending reboot, maintenance-schedule overdue, and denial/deferral details: not reported by v1.';
  if (!row || row.state === 'missing') return card({ title: 'Maintenance evidence', body: `<div class="svc-meta"><strong>Execution evidence: unknown — no evidence received</strong><br>${limits}</div>` });
  if (row.state === 'unsupported') return card({ title: 'Maintenance evidence', body: `<div class="svc-meta"><strong>Execution evidence: unknown — unsupported version</strong><br>Version: ${esc(row.schema_version || 'unknown')}. No unvalidated body was retained.<br>${limits}</div>` });
  if (row.state === 'malformed') return card({ title: 'Maintenance evidence', body: `<div class="svc-meta"><strong>Execution evidence: unknown — stored evidence is malformed</strong><br>${limits}</div>` });
  const checked = validateMaintenanceExecutionResult(row.result, now);
  if (!checked.ok) return card({ title: 'Maintenance evidence', body: `<div class="svc-meta"><strong>Execution evidence: unknown — validation failed</strong><br>${limits}</div>` });
  const r = checked.value; const state = displayState(r, now);
  return card({ title: 'Maintenance evidence', body: `<div class="svc-meta"><strong>Execution evidence: ${esc(state)}</strong><br>Phase: ${esc(r.phase)} · reconciliation: ${esc(r.reconciliation)}<br>Probe coverage: ${esc(String(r.probe_coverage.observed_count))}/${esc(String(r.probe_coverage.expected_count))} · valid until: ${esc(r.freshness.valid_until)}<br>Last attempt: ${esc(r.journal.tail_recorded_at)} · recovery: ${esc(r.recovery.state)}<br>${limits}</div>` });
}
module.exports = { renderMaintenanceExecutionResult };
