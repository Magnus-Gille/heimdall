# Memory Health metrics and thresholds

`src/config/mem-health-thresholds.js` is the runtime source of truth. This file
is its human-readable mirror.

| Signal | OK | Warning | Critical / unknown |
|---|---|---|---|
| Embedding coverage | ≥99%, no failed or stuck entries | pending/stuck entries or <99% | failed entries or <95%; missing is stale |
| Embedding breaker | healthy | — | tripped; unknown is stale |
| Consolidation worker | available | disabled | unavailable; unknown is stale |
| Consolidation failures | 0 | 1 to `max_failures - 1` | at or above `max_failures` |
| Consolidation breaker | healthy | — | tripped; unknown is stale |
| Last synthesis | <24 hours | 24–72 hours | >72 hours; missing is stale |
| Namespace backlog | zero | any namespace above producer `min_logs` | incomplete backlog data is stale |
| Retrieved but unused | Informational quality signal; excluded from Attention and service rollup | — | unavailable is unknown |
| Resolvable maintenance | 0 | any consolidation backlog, past-due plan, missing status, or stale active status | unavailable section is stale |

Query volume, p50/p95 latency, entry counts, namespace count, classification,
and security-protection counts are informational until a baseline-backed alert
policy exists. Heimdall shows them without inventing red/amber thresholds.

There are no sampled Memory Health series today. Historical charts must not be
rendered until the sampler and retention contract actually exist.
