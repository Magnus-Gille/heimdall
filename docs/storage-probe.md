# Storage SSH probe

The NAS storage and backup collector is an intended, read-only SSH probe. It is
separate from the NAS fleet push agent: fresh CPU/load telemetry from the push
agent is not evidence that storage or backup data is current.

Provision it with a dedicated, restricted SSH key and set all three values in
the host-owned Heimdall environment file:

```text
HEIMDALL_STORAGE_SSH_HOST=<NAS address>
HEIMDALL_STORAGE_SSH_USER=<restricted probe user>
HEIMDALL_STORAGE_SSH_KEY=<absolute path to the dedicated private key>
```

The key must have a matching NAS `authorized_keys` entry that allows only the
read-only probe command. Heimdall uses `IdentitiesOnly=yes` and
`IdentityAgent=none`; it will not silently use a service account's personal
keys. If the key is absent or authentication fails, the NAS state is
`ssh_broken` and overall status is degraded/attention rather than treating
unrelated fleet-push metrics as proof of storage health.

The former `scripts/nas-collect.sh` and `scripts/deploy-nas-probe.sh` procedure
was retired because it assumed a `/home/heimdall` account and forced-command
layout that no longer exists on the NAS. Do not recreate that account or alter
NAS authorization from a Heimdall code deployment; provision the identity as a
separate, reviewed substrate operation.

M5 has no SSH storage probe. Its health comes from the inference gateway and
fleet push paths, so it must not share NAS probe credentials or deployment
scripts. This change advances #23; the NAS restricted identity and its
forced-command authorization remain a separate substrate operation.
