# Project status

Heimdall is functional and actively used. The dashboard, collectors, fleet agent, descriptor contract, alert engine, and primary ecosystem integrations have automated coverage.

For a new installation, the remaining work is deployment configuration rather than unfinished core functionality:

- provide a service and fleet inventory;
- choose a private-network or authenticated-ingress policy;
- configure independent ingest tokens;
- provision least-privilege SSH credentials for optional remote probes;
- explicitly decide whether notification, provider-specific tunnel monitoring, and recovery-task submission should be enabled.

Known design limits are documented in the README and `SECURITY.md`: there is no built-in multi-user authentication, local operator mutations do not pass through a proxy, and self-heal authority is delegated to Hugin's runtime controls.
