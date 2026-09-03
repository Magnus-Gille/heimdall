# Systemd supervision projection

Heimdall accepts Brokkr's closed `systemd-supervision-audit` v1 JSON at
`POST /api/systemd-supervision` and renders the current projection at
`GET /supervision`.

The producer sends the exact audit JSON as the request body with
`Authorization: Bearer <HEIMDALL_SUPERVISION_TOKEN>`. The route is capped at
256 KiB and has no insecure-loopback mode. The token belongs in each host's
private runtime configuration, never in a repository or command output.

Heimdall validates the closed v1 shape, keeps only the latest monotonically
newer observation, and recomputes freshness against its own clock on every
read. Missing, partial, stale, future-dated, or malformed evidence remains
unknown or stale and cannot render healthy. System and user managers are
projected separately, so absence from a system-manager enumeration says
nothing about Skuld-style user timers.

The dashboard is observation-only. Brokkr remains the supervision audit and
deduplicated failed-unit delivery authority. Heimdall has no endpoint for
restarting, enabling, or disabling a unit. Brokkr v1 does not carry enabled
state, process start time, run duration, expected cadence, or retry state; these
fields render explicitly as not reported instead of being inferred. Loaded releases and last failure times
are joined only from Heimdall's existing bounded deployment and event metadata
when available.
