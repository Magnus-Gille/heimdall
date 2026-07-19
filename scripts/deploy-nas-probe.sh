#!/bin/bash
# Deploy the canonical NAS metrics probe (scripts/nas-collect.sh) to the NAS,
# where it runs as the SSH forced-command for the heimdall_ed25519 key.
#
# Usage: scripts/deploy-nas-probe.sh user@host
#
# Safe by construction: validates syntax locally and remotely, backs up the
# live script with a timestamp, and runs a smoke test after swapping it in.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 user@host" >&2
  exit 2
fi
NAS="$1"
SRC="$(cd "$(dirname "$0")" && pwd)/nas-collect.sh"
DEST=/home/heimdall/heimdall-collect.sh

[ -f "$SRC" ] || { echo "ERROR: $SRC not found" >&2; exit 1; }
bash -n "$SRC" || { echo "ERROR: local syntax check failed" >&2; exit 1; }

echo "==> Copying $SRC → $NAS:$DEST.new"
scp -q "$SRC" "$NAS:$DEST.new"

echo "==> Validating + swapping in on $NAS"
ssh "$NAS" "bash -n $DEST.new \
  && { [ -f $DEST ] && cp -p $DEST $DEST.bak-\$(date +%Y%m%d-%H%M%S) || true; } \
  && mv $DEST.new $DEST \
  && chmod 755 $DEST"

echo "==> Smoke test (first 8 lines of probe output):"
ssh "$NAS" "$DEST" | head -8
echo "==> Done."
