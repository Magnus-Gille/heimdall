#!/usr/bin/env bash
# deploy-agent.sh <ssh-host>
#
# Rsync the Heimdall push agent to a remote Linux host, stamp VERSION, update
# the systemd user unit, enable it, and restart it. Host config.env is required,
# preserved, and validated before any remote mutation.
set -euo pipefail

TARGET_HOST="${1:?Usage: deploy-agent.sh <ssh-host>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

# Derive version locally before touching the remote. Mark a dirty working tree so
# the reported agent_version cannot claim a clean SHA it is not actually running.
VERSION="$(git -C "$AGENT_DIR" rev-parse --short HEAD)"
if [ -n "$(git -C "$AGENT_DIR" status --porcelain -- "$AGENT_DIR")" ]; then
  VERSION="${VERSION}-dirty"
fi

echo "==> Deploying heimdall-agent ${VERSION} to ${TARGET_HOST}"

# 1. Preflight protected host configuration. This must remain the first remote
# operation: a bad host must fail before source, units, VERSION, or process state
# changes. Never source config.env or print its values.
ssh "${TARGET_HOST}" bash << 'REMOTE_PREFLIGHT'
set -euo pipefail

CONFIG=~/repos/heimdall/agent/config.env

required_key_present() {
  local key="$1"
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    {
      separator = index($0, "=")
      if (!separator) next
      name = substr($0, 1, separator - 1)
      value = substr($0, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (name == wanted) {
        found = (value != "" && value != "\"\"" && value != "\047\047")
      }
    }
    END { exit found ? 0 : 1 }
  ' "$CONFIG"
}

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: protected config.env is missing; refusing to update or restart heimdall-agent" >&2
  exit 1
fi
config_mode="$(stat -c %a "$CONFIG" 2>/dev/null || stat -f %Lp "$CONFIG" 2>/dev/null)"
if [ "$config_mode" != "600" ]; then
  echo "ERROR: protected config.env must have mode 600; refusing to update or restart heimdall-agent" >&2
  exit 1
fi
if ! required_key_present HUB_URL || ! required_key_present FLEET_TOKEN; then
  echo "ERROR: protected config.env must contain non-empty HUB_URL and FLEET_TOKEN; refusing to update or restart heimdall-agent" >&2
  exit 1
fi
REMOTE_PREFLIGHT

# 2. Sync agent source. rsync excludes host-owned config.env and VERSION; without
# --delete-excluded, those exclusions are also protected from --delete.
rsync -av --delete \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude '*.pyc' \
  --exclude 'config.env' \
  --exclude 'VERSION' \
  "${AGENT_DIR}/" \
  "${TARGET_HOST}:~/repos/heimdall/agent/"

# 3. Stamp the exact version that was synced.
printf '%s\n' "$VERSION" | ssh "${TARGET_HOST}" 'cat > ~/repos/heimdall/agent/VERSION'

# 4. Always update the installed unit before daemon-reload, enable, and restart so
# sandbox changes reach existing hosts, not only first installs.
ssh "${TARGET_HOST}" bash << 'REMOTE_INSTALL'
set -euo pipefail

SERVICE_SRC=~/repos/heimdall/agent/deploy/heimdall-agent.service
SERVICE_DIR=~/.config/systemd/user
STATE_DIR=~/.local/state/heimdall-agent

mkdir -p "$SERVICE_DIR"
install -d -m 0700 "$STATE_DIR"
install -m 0644 "$SERVICE_SRC" "${SERVICE_DIR}/heimdall-agent.service"
echo "    updated heimdall-agent.service → ${SERVICE_DIR}/"
systemctl --user daemon-reload
systemctl --user enable heimdall-agent
systemctl --user restart heimdall-agent
REMOTE_INSTALL

# 5. Report both boot persistence and live state only after activation succeeds.
echo "==> Deployed version : ${VERSION}"
echo "==> Unit lifecycle   :"
ssh "${TARGET_HOST}" "systemctl --user is-enabled heimdall-agent && systemctl --user is-active heimdall-agent"
