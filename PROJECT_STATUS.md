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
