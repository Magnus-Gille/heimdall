# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting feature for this repository. Include the affected version, deployment assumptions, reproduction steps, and impact.

## Supported version

Security fixes target the latest commit on the default branch. No older release line is currently maintained.

## Deployment boundaries

Heimdall is designed for one trusted operator and does not provide built-in user login or tenant isolation. Bind to loopback or a private interface. If remote browser access is required, use an authenticated reverse proxy and treat the proxy as a separate trust boundary.

Bearer tokens are mandatory for fleet, alert, and panel ingestion in real deployments. Use independent random tokens, avoid query-string credentials, and rotate a token after suspected exposure. Development-only insecure-loopback flags must not be used behind a proxy.

Local operator endpoints and alert dismissal validate the socket peer and reject forwarded identity headers. Consequently, these operations do not work through a reverse proxy by design.

The remote collector invokes SSH with strict host-key checking. Use a dedicated unprivileged account, a dedicated key, a pinned known-hosts file, and forced commands where practical.

Autonomous recovery is disabled by default. Enabling `HEIMDALL_SELF_HEAL_ENABLED` allows Heimdall to submit Hugin tasks, but Hugin's runtime credentials, SSH access, and sudo policy determine the effective authority. Restrict sudo to named service restarts and retain task/audit logs.

Never commit `~/.heimdall/env`, agent `config.env` files, SQLite databases, SSH material, API keys, chat identifiers, or production inventory details.
