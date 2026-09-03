# Incident timeline

`/timeline` is a read-only forensic view over evidence already held by Heimdall.
It does not ingest logs or traces and it does not assert causation.

## Evidence shown

The view projects bounded fields from alert transitions, structured service
events, collector/probe observations, deployment-release changes, Brokkr's
current systemd-supervision audit, and closed v1 synthetic-journey outcomes.
Each row names its source and evidence authority and shows separate observation
and collection timestamps. When a source has no distinct collection timestamp,
the UI says that it is unavailable instead of substituting the observation
time. Alert acknowledgement remains separate from resolution.

Arbitrary event and alert details, journal output, raw supervision audits,
synthetic step payloads, prompt/model/task contents, response bodies, and raw
traces are not copied into the timeline.

## Correlation semantics

Correlation is evidence navigation, not incident diagnosis:

1. An exact, validated producer trace ID links matching synthetic outcomes.
   "Producer-authored" describes only the identifier's provenance; even this
   link is explicitly non-causal.
2. Otherwise, observations may be labelled "Inferred" only when their host and
   unit, or host and release, match inside the visible maximum-skew window. The
   single comparison clock is `observed_at`. Such a link is non-authoritative,
   may be coincidental, and is never promoted to audit truth.
3. Same-time observations on different units remain uncorrelated.

Diagnostic links stay inside Heimdall. Trace filters accept only a closed
32-character lowercase hexadecimal identifier and never construct an external
trace URL.

## Bounds and retention

The page defaults to 24 hours, permits at most 180 days, and renders at most 500
timeline items from bounded source queries. Daily maintenance removes synthetic
journey rows by `received_at` after 180 days, implementing the parent
platform's six-month operational-telemetry/trace retention convention. The
count cap remains a secondary safety bound.
