# Project status

Heimdall is functional and actively used. The dashboard, collectors, fleet agent, descriptor contract, alert engine, and primary ecosystem integrations have automated coverage.

Newly fired critical alerts use a persistent Ratatoskr delivery outbox. Active repeats are
deduplicated, failures retain only a safe error class and retry time, and a resolved condition can
notify again when it recurs. Delivery is opt-in through `HEIMDALL_NOTIFY_CHAT_ID` and at least once;
the exact crash window is documented in `docs/architecture-v2.md`.

For a new installation, the remaining work is deployment configuration rather than unfinished core functionality:

- provide a service and fleet inventory;
- choose a private-network or authenticated-ingress policy;
- configure independent ingest tokens;
- provision least-privilege SSH credentials for optional remote probes;
- explicitly decide whether notification, provider-specific tunnel monitoring, and recovery-task submission should be enabled.

Known design limits are documented in the README and `SECURITY.md`: there is no built-in multi-user authentication, local operator mutations do not pass through a proxy, and self-heal authority is delegated to Hugin's runtime controls.

Alert-ingest credential maintenance has an allowlist-only diagnostic and
coordinated rotation helper. It updates the server and sender private secret
paths together, verifies replacement acceptance and previous-token rejection,
and rolls both services back without printing credential values if validation
fails.

The four declared Node systemd service templates use Grimnir's bounded runtime
placeholders for the service account, home, and deploy target. They require the
registered host-owned environment file and must be rendered and preflighted by
Grimnir's `systemd_runtime` deployment path before installation.

Issue #7 capability negotiation is implemented in the current review branch:
legacy fleet pushes remain compatible, while v1 agents can negotiate bounded
observation-only Brokkr freshness/lifecycle evidence. It is not deployed.

Issue #23 storage-probe code is prepared in a local review branch: Heimdall now
requires an explicit, readable dedicated SSH key and reports missing identity
as `ssh_broken`; obsolete `/home/heimdall` forced-command scripts are retired.
The NAS restricted account/key and forced-command authorization remain a
separate substrate operation, so this advances rather than closes #23.

Issue #16's read-only Brokkr maintenance-evidence observer consumes the exact
closed `maintenance-execution-result/v1` contract behind a dedicated,
fail-closed token. It stores one monotonic latest record, renders unsupported,
malformed, missing, stale, and negative evidence without changing service
liveness or creating alert, promotion, policy, recovery, or actuation authority.
Producer delivery and all live autonomy remain separately disabled.

Issue #47's diagnosis-only self-heal hardening is implemented in the current
review branch: Heimdall now persists immutable bounded observation snapshots to
Munin, submits diagnosis tasks with Hugin-resolvable `Context-refs:`, and
records durable per-service pending/submitted reservations so overlapping
collector runs stay fail-closed. The current autonomous scope is limited to
local `control-node` services; remote services remain excluded until host-correct
restart evidence exists. Typed actuation remains permanently blocked. It is not
deployed.
