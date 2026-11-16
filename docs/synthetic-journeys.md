# Synthetic reliability journeys

Heimdall records four fixed, content-free read journeys:

- `heimdall-munin-read` performs an authenticated `memory_read` against the
  reserved missing key `probes/heimdall/content-free-read`. A pass requires an
  authenticated, valid response that confirms the sentinel is absent. Response
  content and credentials are never persisted.
- `heimdall-mimir-metadata` performs an authenticated GET for the fixed missing
  path `/list/__heimdall_content_free_probe__`. Mimir's authenticated 404 proves
  the metadata route and archive root were readable without listing names or
  reading a file. Its exact trusted origin and Bearer live together in the
  host-owned `MIMIR_BASE_URL` and `MIMIR_API_KEY`; repository service metadata
  is never used as a credential destination. Both direct journeys reject HTTP
  redirects so credentials cannot follow a response to a different origin.
- `hugin-gateway-preflight` is owned and executed by Hugin.
- `gateway-model-readiness` is owned and executed by gille-inference.

Producer-owned outcomes use the closed `synthetic-journey-outcome` v1 contract
at `POST /api/synthetic-journeys` with producer-specific
`Authorization: Bearer` credentials. Hugin uses
`HEIMDALL_HUGIN_JOURNEY_TOKEN`; gille-inference uses
`HEIMDALL_GATEWAY_JOURNEY_TOKEN`. The endpoint rejects direct Heimdall journey
identities and a producer cannot authenticate as the other producer. Every
pass binds one attempt ID, producer version, timestamps, total latency, all
declared steps, freshness, and an optional 32-hex trace ID. Unknown fields are
rejected, so prompts, task/result text, memory values, filenames, URLs,
credentials, and arbitrary error messages cannot enter the store.
Attempts more than five seconds ahead of Heimdall's clock are rejected before
persistence, preventing a future-dated producer result from displacing newer
valid history.

The existing Hugin `hugin-learning-task-preflight` status panel is useful but
does not contain the attempt, step, latency, version, and trace fields required
by this contract. It is therefore not promoted to a green journey. Likewise,
the gateway/model journey remains unknown until gille-inference publishes the
closed v1 outcome. Heimdall never runs or impersonates either internal client.

The `/reliability` page recomputes freshness using Heimdall's clock. It derives
24-hour success-rate and p95-latency objectives with a minimum of 12 samples;
smaller samples are `unknown`, not compliant. Success and latency are graded
independently, so a known breach in either dimension is not hidden by missing
samples in the other. A complete current journey failure raises one
deduplicated critical alert. A windowed objective breach raises one warning.
Both resolve on recovery through the existing alert store and notification
path. These calculations measure path operation only and never grade model,
prompt, task, or result quality.

## Producer delivery status (HEIM-49)

Heimdall only ingests; each producer repository owns running its journey and sending the
closed v1 outcome. A journey stays `unknown` until its producer delivers.

| Journey | Producer ticket | Producer implementation |
|---|---|---|
| `gateway-model-readiness` | INFER-250 | `scripts/post-readiness-journey.ts` + `src/homeserver/readiness-journey.ts` in gille-inference. Two steps (`gateway-readiness` via `GET /healthz`, `model-readiness` via `GET /models/residency`) with a read-only monitor key; five-minute timer, inert until the owner installs it. |
| `hugin-gateway-preflight` | HUGIN-388 | Not yet implemented (Hugin repository). See the checklist below. |

Producer checklist (what Heimdall's validator enforces, so a producer can self-check before
sending): `kind: "synthetic-journey-outcome"`, `schema_version: "v1"`, the fixed `journey_id`
and `producer`, a unique `attempt_id` matching `^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$`, stable
`version`, UTC `started_at <= observed_at`, `max_age_seconds` 1..86400, exactly the declared steps
(each `pass|fail|skipped`, a pass has a latency and no error class), `runner_outcome: "failed"`
only with `outcome: "unknown"` and an error class, `extensions: []`, and no other field. Resend
the identical document on delivery retry; Heimdall treats an identical `(journey_id, attempt_id)`
as a replay and a different one as `attempt_conflict` (409). Sending a fail, then a newer pass,
fires and then resolves the journey alert.
