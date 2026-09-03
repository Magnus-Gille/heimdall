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
