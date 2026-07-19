# Authenticated reverse-proxy example

Heimdall has no built-in user login. This document shows one optional way to place Cloudflare Access in front of the loopback listener. Equivalent authenticated reverse proxies are equally valid.

## Example state

- **Hostname:** `monitor.example.com`
- **Origin:** `http://127.0.0.1:3033`
- **Requirement:** deny access until an identity policy succeeds

## Steps to configure CF Access

### 1. Create a new Access Application

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Application name:** `Heimdall Dashboard`
   - **Session duration:** 30 days
   - **Application domain:** `monitor.example.com`

### 2. Add Allow policies

Add two policies to the application:

#### Policy 1: operator browser access

- **Policy name:** `Allow operator email OTP`
- **Action:** Allow
- **Include rule:** Emails — `operator@example.com`

Prefer a reusable operator group or identity-provider policy over a single hard-coded address.

#### Policy 2: service token (agent access)

- **Policy name:** `Allow Munin Service Token`
- **Action:** Service Auth
- **Include rule:** Service Token — select a dedicated Heimdall client

This permits agents to reach read or ingest routes through the proxy. Heimdall bearer authentication is still required for push endpoints; proxy authentication does not replace application authentication.

### 3. Save and verify

1. Save the application
2. Visit `https://monitor.example.com` in an incognito window — should redirect to Cloudflare login
3. Authenticate with `operator@example.com` — should show the dashboard
4. Verify service-token access to a non-local read route:
   ```bash
   curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        https://monitor.example.com/api/health
   ```

## Important limitation

Keep `HEIMDALL_BIND=127.0.0.1`; a local reverse proxy can reach it without binding to every interface. Sensitive localhost-only routes such as `/api/status`, `/api/summary`, and alert dismissal intentionally reject forwarded requests, so they remain available only to a process connecting directly from the host.
