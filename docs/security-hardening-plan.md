# Heimdall Security Hardening Plan (historical)

> Fictionalized point-in-time audit record retained only to explain hardening rationale. Host state, permissions, ports, versions, findings, and remediation status are illustrative and must not be read as facts about any deployment. See `../SECURITY.md` for reporting and deployment guidance; verify every item against current code and infrastructure before acting on it.

**Created:** 2026-03-15
**Updated:** 2026-03-15 (comprehensive audit replacing initial plan)
**Audit scope:** Example codebase and host review covering services, permissions, SSH, network, dependencies, and threat modeling

## Executive Summary

Heimdall's security posture is **strong** after the March 2026 hardening sprint. The codebase uses parameterized SQL everywhere, HTML-escapes all dynamic output, validates shell inputs, has rate limiting, security headers, and comprehensive systemd sandboxing.

**Remaining findings: 17 total — 0 critical, 4 high, 8 medium, 5 low.**

The highest-priority items are: SSH server hardening on both Pis, the CLI SQL injection in `heimdall-query`, NAS authorized_keys file permission, and missing Content Security Policy header.

---

## What's Already Secure (post-hardening sprint)

These were identified in the initial audit and **have been fixed**:

- **Parameterized SQL queries** — all DB operations use `better-sqlite3` prepared statements (db.js)
- **HTML escaping** — `esc()` applied to all dynamic content in templates (html.js)
- **Command injection prevention** — `isValidHost()`, `isValidIP()`, `isValidHealthURL()` validate all shell-interpolated values (metrics.js, drift.js, events.js)
- **SSH host key pinning** — `StrictHostKeyChecking=yes` with dedicated `known_hosts` file
- **Rate limiting** — 100 req/min per IP via `@fastify/rate-limit`
- **Security headers** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- **Environment validation** — HOST/PORT validated at startup
- **Systemd sandboxing** — ProtectSystem=strict, NoNewPrivileges, PrivateTmp, PrivateDevices, RestrictNamespaces, etc.
- **Event sanitization** — `/api/events` strips `detail` field from public responses
- **Localhost-only endpoints** — `/api/status` and `/api/summary` blocked for CF tunnel traffic
- **DB file permissions** — heimdall.db is 600 (user-only)
- **SSH key permissions** — heimdall_ed25519 is 600
- **Minimal dependencies** — only 3 production packages (fastify, better-sqlite3, @fastify/rate-limit)

---

## Findings

### HIGH SEVERITY

#### H1. SSH server not hardened on either Pi
- **Severity:** High
- **Historical observation:** Both Pis use default `sshd_config` — password auth via PAM (KbdInteractiveAuthentication disabled, but PasswordAuthentication not explicitly disabled), X11Forwarding enabled, no AllowUsers restriction, no sshd_config.d drop-in files
- **Risk:** If a Tailscale node is compromised, the attacker can attempt password brute-force against SSH (only rate-limited by PAM defaults). X11 forwarding is unnecessary attack surface.
- **Fix:**
  Create `/etc/ssh/sshd_config.d/hardening.conf` on both Pis:
  ```
  PasswordAuthentication no
  PermitRootLogin no
  X11Forwarding no
  MaxAuthTries 3
  AllowUsers heimdall
  ```
  Then: `sudo systemctl reload ssh`
- **Implementable autonomously:** No — requires sudo and careful testing to avoid lockout
- **Effort:** S

#### H2. SQL injection in CLI tool `scripts/heimdall-query`
- **Severity:** High
- **Historical observation:** `--category`, `--severity`, `--host`, `--metric` parameters are concatenated directly into SQL WHERE clause without escaping (lines 47-48, 64-65, 74)
- **Risk:** Local SQL injection. Although accessible only to the service operator, this violates defense-in-depth and could be exploited if the script is ever called programmatically (e.g., by Hugin tasks)
- **Fix:** Escape single quotes in all parameters: `$(echo "$2" | sed "s/'/''/g")` — or better, rewrite in Node.js using parameterized queries
- **Implementable autonomously:** Yes
- **Effort:** S

#### H3. NAS authorized_keys file permissions are 664 (world-readable)
- **Severity:** High
- **Historical observation:** `~/.ssh/authorized_keys` on NAS is `664` (`-rw-rw-r--`). Also contains 3 duplicate entries for the heimdall key.
- **Risk:** Any local user on NAS can read which keys have access and their `command=` restrictions, aiding targeted attack. OpenSSH may also refuse to honor the file if `StrictModes` is on (default).
- **Fix:**
  ```bash
  ssh heimdall@192.0.2.20 'chmod 600 ~/.ssh/authorized_keys'
  ```
  Also deduplicate the heimdall key entries (3 identical lines).
- **Implementable autonomously:** Yes
- **Effort:** S

#### H4. No Content Security Policy (CSP) header
- **Severity:** High
- **Historical observation:** Security headers include X-Frame-Options, X-Content-Type-Options, etc., but no CSP
- **Risk:** Without CSP, any XSS that bypasses `esc()` can load arbitrary external scripts. CSP provides a critical second layer of defense.
- **Fix:** Add to the `onRequest` hook in server.js:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
  ```
  Note: `'unsafe-inline'` needed for HTMX event handlers and inline styles. Can be tightened with nonces later.
- **Implementable autonomously:** Yes
- **Effort:** S

### MEDIUM SEVERITY

#### M1. No firewall on control-node Pi
- **Severity:** Medium
- **Historical observation:** No iptables/nft rules on control-node. SSH (port 22) listens on `0.0.0.0`. NAS has Tailscale iptables rules but control-node does not.
- **Risk:** In the example, connecting the host to an additional network could expose listeners beyond the intended private overlay.
- **Fix:** Install and configure `ufw`:
  ```bash
  sudo apt install ufw
  sudo ufw default deny incoming
  sudo ufw allow in on tailscale0
  sudo ufw enable
  ```
  This restricts all incoming traffic to Tailscale interface only.
- **Implementable autonomously:** No — risk of lockout, requires human
- **Effort:** S

#### M2. Samba `map to guest = bad user` on NAS
- **Severity:** Medium
- **Historical observation:** Samba config has `map to guest = bad user`, meaning any connection attempt with a non-existent username gets mapped to the guest account. `usershare allow guests = yes` is also set.
- **Risk:** Even when the backup share requires an explicit user, the `[homes]` share and any future shares could be inadvertently accessible. Guest mapping is a common misconfiguration vector.
- **Fix:** In `/etc/samba/smb.conf`:
  ```
  map to guest = never
  usershare allow guests = no
  ```
- **Implementable autonomously:** No — requires sudo on NAS
- **Effort:** S

#### M3. No unattended security upgrades on either Pi
- **Severity:** Medium
- **Historical observation:** `unattended-upgrades` service not found on either Pi. System packages may have known vulnerabilities.
- **Risk:** Kernel and system library CVEs go unpatched until manual intervention.
- **Fix:**
  ```bash
  sudo apt install unattended-upgrades
  sudo dpkg-reconfigure -plow unattended-upgrades
  ```
  Configure to auto-install security updates only (not full dist-upgrade).
- **Implementable autonomously:** No — requires sudo
- **Effort:** S

#### M4. `heimdall-collect.sh` on NAS is world-executable (775)
- **Severity:** Medium
- **Historical observation:** `/home/heimdall/heimdall-collect.sh` on NAS has permissions `775` (`-rwxrwxr-x`). This is the `command=` restricted script for the heimdall SSH key.
- **Risk:** Any local user can modify this script (group write) or execute it directly. Since the SSH key's `command=` forces this script, modifying it would change what runs on SSH connections.
- **Fix:**
  ```bash
  ssh heimdall@192.0.2.20 'chmod 700 ~/heimdall-collect.sh'
  ```
- **Implementable autonomously:** Yes
- **Effort:** S

#### M5. `known_hosts` file in `~/.heimdall/` is world-readable (644)
- **Severity:** Medium
- **Historical observation:** `~/.heimdall/known_hosts` is `644`. Contains NAS host key fingerprint.
- **Risk:** Leaks which hosts Heimdall connects to and their key fingerprints. Minor information disclosure.
- **Fix:** `chmod 600 ~/.heimdall/known_hosts`
- **Implementable autonomously:** Yes
- **Effort:** S

#### M6. cloudflared runs as root
- **Severity:** Medium
- **Historical observation:** `systemctl show cloudflared --property=User` returns empty (default = root).
- **Risk:** If cloudflared is compromised, attacker has root access to the Pi.
- **Fix:** Create a dedicated `cloudflared` user and update the service unit:
  ```
  [Service]
  User=cloudflared
  ```
  Requires re-configuring tunnel credentials for the new user.
- **Implementable autonomously:** No — requires sudo, credential migration
- **Effort:** M

#### M7. Metrics API endpoint lacks input validation on host/metric params
- **Severity:** Medium
- **Historical observation:** `GET /api/metrics/:host/:metric` passes `host` and `metric` params directly to parameterized SQL queries. While SQL injection is prevented by parameterization, there's no validation that these are expected values.
- **Risk:** Information disclosure — an attacker could enumerate all hosts and metric names by trying different values. The DB queries are safe, but responses confirm whether data exists.
- **Fix:** Validate `host` against a whitelist (`['control-node', 'nas']`) and `metric` against known metric names. Return 404 for unknown values.
- **Implementable autonomously:** Yes
- **Effort:** S

#### M8. `drift.js` uses `id_ed25519` while collector uses `heimdall_ed25519`
- **Severity:** Medium
- **Historical observation:** `drift.js` SSH command references `~/.ssh/id_ed25519` (the personal key) while `collector.js`/`metrics.js` correctly uses `~/.ssh/heimdall_ed25519` (the dedicated service key).
- **Risk:** drift.js uses the personal SSH key, which has broader permissions on the NAS than the restricted heimdall key (no `command=` restriction). If drift checks are ever expanded, this over-privileged key could execute arbitrary commands on the NAS.
- **Fix:** Update `drift.js` to use `~/.ssh/heimdall_ed25519` and ensure the NAS `authorized_keys` allows the health URL curl for that key, or create a separate restricted key for drift.
- **Implementable autonomously:** Partially — code change is easy, but NAS authorized_keys may need updating
- **Effort:** S

### LOW SEVERITY

#### L1. Bluetooth service running on both Pis
- **Severity:** Low
- **Historical observation:** `bluetooth.service` is active on both Pis.
- **Risk:** Unnecessary attack surface. Bluetooth vulnerabilities (BlueBorne, etc.) could provide local network access.
- **Fix:** `sudo systemctl disable --now bluetooth`
- **Implementable autonomously:** No — requires sudo
- **Effort:** S

#### L2. ModemManager service running on both Pis
- **Severity:** Low
- **Historical observation:** `ModemManager.service` is active on both Pis.
- **Risk:** Unnecessary service for a Pi that doesn't use cellular modems. Reduces attack surface.
- **Fix:** `sudo systemctl disable --now ModemManager`
- **Implementable autonomously:** No — requires sudo
- **Effort:** S

#### L3. No `Strict-Transport-Security` (HSTS) header
- **Severity:** Low
- **Historical observation:** No HSTS header. Traffic goes through Cloudflare Tunnel (which handles TLS termination), so direct HTTP connections are only on the LAN/Tailscale.
- **Risk:** Low — Cloudflare handles HSTS at the edge. But if the dashboard is ever accessed directly over HTTP on the Tailscale network, there's no transport security.
- **Fix:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` header. Only effective when accessed via HTTPS (harmless over HTTP).
- **Implementable autonomously:** Yes
- **Effort:** S

#### L4. No systemd `RestrictAddressFamilies` or `UMask`
- **Severity:** Low
- **Historical observation:** Systemd services don't restrict socket address families or set explicit UMask.
- **Risk:** Services could theoretically create Unix domain sockets or other socket types. UMask defaults to 0022, which may create files with group/world read access.
- **Fix:** Add to all service files:
  ```
  RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
  UMask=0077
  ```
- **Implementable autonomously:** Yes
- **Effort:** S

#### L5. npm dependencies use caret ranges (^)
- **Severity:** Low
- **Historical observation:** Dependencies use `^` semver ranges. Lock file is present and pinned.
- **Risk:** If `package-lock.json` is deleted and regenerated, newer (potentially compromised) minor/patch versions could be pulled. Lock file mitigates this in normal operation.
- **Fix:** Consider exact pinning (remove `^`) or add `npm audit` to a CI/CD step. Not urgent since lock file is present.
- **Implementable autonomously:** Yes
- **Effort:** S

---

## Threat Model Analysis

### Scenario 1: Compromised private-network peer
- **Attack path:** An attacker compromises a peer that can reach the monitoring and storage hosts.
- **Illustrative mitigations:** Private-interface binding, SSH key authentication, firewall policy, and systemd sandboxing limit blast radius.
- **Gaps:** A listener on every interface or a broad overlay ACL can turn one compromised peer into fleet-wide reachability.
- **Recommendation:** Restrict listeners, firewall rules, and overlay ACLs to the smallest necessary peer set.

### Scenario 2: Stolen SSH key
- **Attack path:** `heimdall_ed25519` private key is exfiltrated
- **Illustrative mitigations:** A dedicated key can be restricted to the collection command with forwarding disabled, mode `0600`, and read-only service access.
- **Gaps:** Reusing an operator key or granting an unrestricted shell would expand the blast radius.
- **Risk:** Depends on the command restriction and privileges of the remote account.
- **Recommendation:** Never use the monitoring key for unrestricted access; consider short-lived SSH certificates for easier rotation.

### Scenario 3: Malicious Hugin task
- **Attack path:** A Hugin task writes malicious content to Munin DB, which Heimdall reads and displays
- **Illustrative mitigations:** HTML escaping, read-only data access, output limits, and a restrictive CSP reduce stored-content risk.
- **Gaps:** A missed escaping path or unsafe CSP relaxation could still enable XSS.
- **Recommendation:** Implement H4 (CSP header) as defense-in-depth.

### Scenario 4: Supply chain attack on npm
- **Attack path:** One of the 3 dependencies (fastify, better-sqlite3, @fastify/rate-limit) is compromised
- **Illustrative mitigations:** A lockfile pins exact versions and a small dependency set limits exposure.
- **Gaps:** A deployment without automated vulnerability scanning may miss newly disclosed issues.
- **Risk:** Dependency risk must be reassessed continuously rather than inferred from an old audit result.
- **Recommendation:** Run dependency auditing in CI or a scheduled maintenance job.

### Scenario 5: Physical access to a Pi
- **Attack path:** Attacker has physical access to a Pi, pulls the SD card
- **Illustrative mitigations:** The example assumes no full-disk encryption.
- **Gaps:** Data and credentials on removable media may be readable after physical capture.
- **Risk:** Deployment-specific; unattended boot and disk encryption have operational tradeoffs.
- **Recommendation:** Document the physical-access risk, keep overlay-network credentials revocable, and choose an unattended-key strategy that matches the deployment's threat model.

### Scenario 6: DNS rebinding attack
- **Attack path:** Attacker tricks browser into making requests to Heimdall's internal IP via DNS rebinding
- **Illustrative mitigations:** Frame protections, loopback/private binding, authenticated ingress, and explicit Host validation reduce browser-mediated attacks.
- **Gaps:** DNS rebinding remains relevant if a browser can reach an unauthenticated private listener.
- **Recommendation:** Validate expected hosts and origins where the ingress architecture permits it.

---

## Implementation Priority

### Implement Now (autonomous — no human action needed)

| # | Finding | Effort |
|---|---------|--------|
| H2 | Fix SQL injection in `heimdall-query` | S |
| H3 | Fix NAS authorized_keys permissions + deduplicate | S |
| H4 | Add Content Security Policy header | S |
| M4 | Fix `heimdall-collect.sh` permissions on NAS | S |
| M5 | Fix `known_hosts` permissions in `~/.heimdall/` | S |
| M7 | Add input validation to metrics API endpoint | S |
| M8 | Fix drift.js to use correct SSH key | S |
| L3 | Add HSTS header | S |
| L4 | Add RestrictAddressFamilies + UMask to systemd units | S |

### Implement Later (autonomous, lower priority)

| # | Finding | Effort |
|---|---------|--------|
| L5 | Pin npm dependencies / add audit check | S |

### Requires Human Action

| # | Finding | Effort | Why |
|---|---------|--------|-----|
| H1 | SSH server hardening (both Pis) | S | Risk of lockout — need console access as backup |
| M1 | Firewall on control-node | S | Risk of lockout — need console access as backup |
| M2 | Fix Samba guest mapping on NAS | S | Requires sudo on NAS |
| M3 | Install unattended-upgrades (both Pis) | S | Requires sudo |
| M6 | Run cloudflared as non-root | M | Requires credential migration |
| L1 | Disable Bluetooth service | S | Requires sudo |
| L2 | Disable ModemManager service | S | Requires sudo |

### Previously Fixed (for reference)

These items from the initial audit have been remediated:
- Command injection in drift.js (commit f1a45a4)
- Command injection in metrics.js ping() and collectRemoteViaSSH() (commit f1a45a4)
- Missing security headers (commit c1f36d7)
- No rate limiting (commit 5a120c9)
- Environment variable validation (commit c1f36d7)
- Systemd sandboxing (commit 1940f2b)
- Static file Cache-Control headers (commit c1f36d7)
- DB file permissions (now 600)
- SSH key permissions (always correct at 600)

---

## Dependency Audit

```
$ npm audit
found 0 vulnerabilities

Dependencies (3):
  @fastify/rate-limit  ^10.3.0  (lock: pinned)
  better-sqlite3       ^12.8.0  (lock: pinned)
  fastify              ^5.8.2   (lock: pinned)

Lock file: present (package-lock.json, lockfileVersion 3)
Dev dependencies: none
```

No known vulnerabilities. Minimal supply chain surface.

---

## Network Audit Summary

### control-node (192.0.2.10)
| Port | Binding | Service | Notes |
|------|---------|---------|-------|
| 22 | 0.0.0.0 | SSH | Should bind to Tailscale IP only (H1/M1) |
| 3030 | 127.0.0.1 | Munin Memory | Localhost only — good |
| 3032 | 127.0.0.1 | Unknown node service | Localhost only — good |
| 3033 | 192.0.2.10 | Heimdall | Tailscale IP only — good |
| 20241 | 127.0.0.1 | Tailscale local API | Expected |
| 41457 | 192.0.2.10 | Tailscale relay | Expected |

### NAS (192.0.2.20)
| Port | Binding | Service | Notes |
|------|---------|---------|-------|
| 22 | 0.0.0.0 | SSH | Should bind to Tailscale IP only (H1/M1) |
| 139/445 | 0.0.0.0 | Samba | Needed for Time Machine — should restrict to LAN |
| 3031 | 127.0.0.1 | Mimir | Localhost only — good |
| 20241 | 127.0.0.1 | Tailscale local API | Expected |

---

## Data Stored in heimdall.db

| Table | Contains | Sensitive? | Retention |
|-------|----------|-----------|-----------|
| metrics | CPU temp, RAM %, disk %, load, network bytes, uptime | No PII | Raw: 7d, hourly rollup: 90d |
| events | SSH logins (IP/user), service restarts, threshold alerts | SSH IPs are semi-sensitive | 1 year |
| alerts | Backup failures, threshold violations | No PII | Indefinite (but resolved) |
| service_versions | Git commit hashes, service names | No secrets | 30 days |
| process_snapshots | Top processes (user, command, CPU/mem) | Usernames, command lines | Latest only |

**Assessment:** No credentials, API keys, or high-sensitivity PII. SSH login IPs in events are the most sensitive data. Process command lines could theoretically contain secrets passed as arguments.

**Recommendation:** The current retention policy is reasonable. Consider redacting command-line arguments in process snapshots if they contain `--password`, `--token`, etc.
