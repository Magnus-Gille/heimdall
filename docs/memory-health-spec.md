# Memory Health consumer specification

**Status:** Live, schema version 2

**Producer:** munin-memory

**Consumer:** Heimdall `/services/munin-memory`

Munin Memory owns the canonical wire contract in its
`docs/memory-health.schema.json` and `docs/memory-health-spec.md`. Heimdall keeps
`docs/memory-health.schema.json` as a synchronized validation copy; contract
changes start upstream and land here with a fixture and consumer tests.

This document defines what Heimdall does with that payload. It intentionally
does not duplicate every producer field.

## Data boundary

`fetchMemoryHealth()` calls the owner-only `memory_health` MCP tool over the
existing loopback transport with a five-second timeout. Heimdall validates the
full schema-version-2 envelope before unwrapping `sections` for rendering.
`fetchMemoryAttention()` separately calls `memory_attention` with a bounded,
status-maintenance-only filter to obtain the exact namespaces, previews, ages,
and recommended actions behind the aggregate counts.

The fetch result is typed:

- `ok`: validated current payload.
- `transport_error`: Munin could not be reached.
- `invalid_schema`: malformed or contract-incomplete response.
- `unsupported_version`: Heimdall must be upgraded before interpreting it.
- `stale_payload`: the optional freshness gate rejected the producer timestamp.

A failed read never renders green. The last good payload may be retained for a
future stale-data view, but it is not presented as current.

## Operator information hierarchy

The main card answers three questions in this order:

1. **Is memory working?** A plain-language summary and five core state tiles:
   embedding coverage, queue, synthesis age, consolidation backlog, and total
   maintenance attention.
2. **What should I do?** Only resolvable maintenance kinds contribute to the
   Attention total: consolidation backlog, past-due plans, missing statuses,
   and stale active statuses. Each status row expands to the exact namespaces,
   current preview, age, and the decision needed. Consolidation links to its
   drill-down.
3. **Are protections firing?** Seven-day counts for secret redactions,
   cross-zone blocks, and denied requests, with 30-day context where available.
   Successful blocks are protection activity, not system failures.

Repeatedly retrieved-but-unused entries appear separately as a **Retrieval
quality signal**. That count is observational telemetry: preview-only use and
missing feedback can create false positives, and reviewing an entry does not
deterministically clear its 30-day history. It therefore does not inflate the
Attention total or service badge and must never encourage deletion merely to
reach zero.

Secondary diagnostics are collapsed under **Technical details**:

- entry totals, state/log split, and namespace count;
- 7-day and 30-day query volume;
- p50 and p95 query latency;
- lexical, semantic, and hybrid mode mix;
- embedding model, worker and breaker state, average synthesis latency;
- classification distribution and last consolidation error.

This keeps the first screen actionable while preserving the detail needed for
diagnosis.

## State semantics

Heimdall uses `ok`, `warn`, `crit`, and `stale` consistently:

- `ok`: known and healthy.
- `warn`: working, but degraded, disabled, or requiring attention.
- `crit`: intervention required; a core path is failing.
- `stale`: missing, invalid, degraded at source, or unknown future enum.

Unknown and zero are never conflated. A missing field renders `—`; a confirmed
zero renders `0`.

The service badge rolls up runtime failures plus resolvable maintenance attention. The
plain-language card summary deliberately separates engine health from cleanup
work, so `Warning` can still say “Memory is working; maintenance items need
review.”

Thresholds are implemented in `src/config/mem-health-thresholds.js` and mirrored
in `docs/metrics.md`.

## Trend policy

Heimdall does not currently sample `memory_health` into historical series. The
card must not display “collecting samples,” calibration placeholders, or empty
charts. Trend UI ships only with a real sampling pipeline, retention policy,
freshness rules, and enough observations to produce honest charts.

## Consolidation drill-down

`/services/munin-memory/consolidation` is the detailed action surface. Namespace
coverage is merged with backlog rows, including namespaces that have backlog but
have never produced a synthesis.

The page shows:

- summary counts for backlogged, quiet (>14 days), never synthesized, and
  recently synthesized namespaces. Quiet is informational: age alone is not a
  problem when there is no unincorporated-log backlog;
- an action-first table for backlog / never-synthesized work, capped at 20 rows;
- explicit `0` backlog values;
- the complete sorted table behind a collapsed “All namespaces” disclosure.

## Regression requirements

Tests must prove that:

- Heimdall's schema copy requires p50/p95 latency and seven-day access denials;
- missing or degraded sections never render healthy zeros;
- maintenance warnings name the underlying actions;
- item-level attention rows identify the exact namespaces and required decision;
- retrieved-unused telemetry is separated from the zeroable action count;
- security blocks are visible without being mislabeled as failures;
- scale, latency, mode mix, and classification remain available in details;
- fake sampling placeholders cannot return;
- the deployed commit stamp, not a stale rsync checkout HEAD, supplies Heimdall's
  runtime version.
