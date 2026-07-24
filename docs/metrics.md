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

# Insights KPI thresholds

`src/config/insight-thresholds.js` is the runtime source of truth for the
`/insights` KPI row. This section is its human-readable mirror.

| Signal | OK | Warning | Critical / unknown |
|---|---|---|---|
| Self-Improvement Score | ≥75 | 55–74 | <55; missing is stale |
| Outcome success | ≥80% | 60–79% | <60%; missing is stale |
| First-pass correctness | ≥70% | 50–69% | <50%; missing is stale |
| Commits (latest week) | Informational — no status band | — | missing shows as — |

Unknown or calibrating values render as stale, never as good. Each KPI carries
a tooltip stating its band, so the UI itself explains what good, degraded, and
bad mean.
