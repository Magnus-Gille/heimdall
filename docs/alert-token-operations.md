# Alert-ingest token operations

`HEIMDALL_ALERT_TOKEN` authenticates `POST /api/alerts`. Treat it as an
independent ingest credential, not as a fleet, panel, dashboard, or operator
credential.

## Consumer inventory

In the Grimnir deployment there are two consumers:

- Heimdall reads `HEIMDALL_ALERT_TOKEN` and validates the Bearer credential.
- Ratatoskr reads the same name and sends it when it echoes an alert envelope
  to `HEIMDALL_INGEST_URL`.

Reverify this before every rotation. Search tracked source and examples, not
private environment files:

```sh
git grep -n HEIMDALL_ALERT_TOKEN
git -C ../ratatoskr grep -n HEIMDALL_ALERT_TOKEN
```

If another sender appears, stop and add it to the coordinated rotation. Do not
silently leave a consumer on the previous credential.

## Secret-safe diagnostics

Never use broad environment diagnostics such as `systemctl
show-environment`, `systemctl show ... Environment`, `env`, `printenv`, or
`/proc/<pid>/environ`. Do not enable shell tracing and do not put a Bearer token
in a command-line argument. Those approaches can copy every service credential
into logs, process listings, terminal scrollback, or agent output.

Use the allowlist-only helper with explicit private paths instead:

```sh
sudo scripts/alert-token-ops.py diagnose \
  --heimdall-env /home/magnus/.heimdall/env \
  --consumer-env /home/magnus/repos/ratatoskr/.env \
  --heimdall-drop-in /etc/systemd/system/heimdall.service.d/alert-token.conf
```

It reports only:

- presence of the allowlisted token and ingest-URL names;
- presence of an inline token directive or the expected secret-free
  `EnvironmentFile` reference in the named systemd drop-in;
- whether the two in-memory token values match;
- `ActiveState`, `SubState`, and `MainPID` for the two named units; and
- a count from at most 100 journal lines in the last ten minutes that match
  explicit alert-auth warning phrases.

It never prints an environment value, request header, or journal line.
Environment files must be regular files with no group/world permissions.

## Coordinated rotation

Run this on the host that owns both services. The example paths are the Grimnir
production paths; use explicit paths for other installations.

```sh
sudo scripts/alert-token-ops.py rotate \
  --heimdall-env /home/magnus/.heimdall/env \
  --consumer-env /home/magnus/repos/ratatoskr/.env \
  --heimdall-drop-in /etc/systemd/system/heimdall.service.d/alert-token.conf \
  --ingest-url http://127.0.0.1:3033/api/alerts \
  --health-url http://127.0.0.1:3033/api/health
```

The helper:

1. confirms the sender has one non-empty old token and that any current
   Heimdall private-file or inline systemd token matches it;
2. generates a 256-bit replacement in memory;
3. stops Ratatoskr so the sender cannot lose alerts during a split credential
   window;
4. atomically replaces only the token assignment in both private files while
   preserving file mode and ownership, then replaces the token-bearing systemd
   drop-in with a secret-free `EnvironmentFile=` reference and daemon-reloads;
5. restarts Heimdall, waits for both systemd active state and HTTP health
   readiness, then restarts Ratatoskr and waits for it to become active;
6. submits and resolves a harmless probe alert with the replacement;
7. proves the previous token receives HTTP 401 or 403; and
8. reports only fixed status labels and a bounded auth-warning count.

The token is not accepted on stdin, the command line, or an option. It is never
printed and no backup containing it is created. In particular, do not use
`systemctl cat` while an older inline-token drop-in may still exist.
An empty mode-0600 lock file remains beside the Heimdall environment file to
serialize future rotations; it contains no credential or operational output.

## Failure and rollback

If a file update, restart, or validation step fails, the helper keeps Ratatoskr
stopped while it atomically restores both original file contents from memory,
including the original systemd drop-in, daemon-reloads, then restarts both
services. It reports `rotation_failed=rolled_back` without
printing either credential. `SIGINT`, `SIGTERM`, and `SIGHUP` enter this same
rollback path; additional interruption signals are ignored while rollback is
in progress.

After a rollback, the previous token is active again but remains compromised.
Correct the reported non-secret failure and repeat the rotation immediately.
`SIGKILL`, kernel failure, power loss, or a host crash cannot be handled by any
process-local rollback. If one occurs during the short update window, keep
Ratatoskr stopped, rerun `diagnose`, restore matching values through the private
secret path if needed, restart Heimdall first, and repeat the rotation.

After success, rerun `diagnose`. Investigate any new bounded auth-failure count
without widening the journal query or dumping headers/environment values.
