# Producer-token operations

Heimdall authenticates `POST /api/panels` and `POST /api/fleet/push` only
against the host-owned `HEIMDALL_INGEST_PRODUCERS_JSON` registry: a JSON array
of `{id, token, hosts?, services?}` records, one per producer. The legacy
`HEIMDALL_FLEET_TOKEN` is a read-back operator credential and can no longer
write. Every producer on every node therefore needs its own token, installed
without the value ever being seen by an operator or an agent.

`scripts/producer-token-ops.py` (python3, standard library only) does this. It
acts only on local files named by explicit absolute paths and never restarts
or reloads anything.

## Rule: tokens never appear on the command line or in logs

A token must never be placed in a command-line argument, a shell history entry,
a log, a ticket, a chat message, or terminal scrollback. Command lines are
readable by every local process. The helper therefore:

- generates tokens itself (`secrets.token_urlsafe(32)`) and writes them only to
  the private env file;
- hands a new token onward only through a pipe (`register --emit-token` into
  `stage`), and refuses `--emit-token` when stdout is a terminal and `stage`
  when stdin is a terminal;
- prints only allowlisted summaries (ids, scopes, counts, states) on stdout
  and stderr, never an environment value; and
- accepts a token only on stdin, never as an option.

Do not run `register --emit-token` with stdout captured by an agent harness or
redirected to a file you will read; the only consumer is the `stage` pipe.
Do not inspect process or service environments to check results (see the
forbidden diagnostics in [alert-token-operations.md](alert-token-operations.md));
use `diagnose`.

## File safety

Every env file must be a regular, non-symlink file owned by the current user
(under `sudo`, also by `SUDO_UID`) with no group/other permission bits, or the
command refuses.

Write transactions (`register`, `stage`, `cutover`, `rollback`) additionally:

- require the parent directory to be a real directory (not a symlink), owned
  by root or the current user, and not group/other-writable;
- hold that directory open for the whole operation and do the temp-file
  create, backup link, rename and directory fsync relative to it, under an
  exclusive lock on it;
- refuse to replace the file if its device, inode, size or mtime changed since
  it was read; and
- replace the file atomically (private temp file, fsync, rename, directory
  fsync), preserving mode, owner and group. Other lines are preserved
  byte-for-byte.

Before the first modification the helper publishes `<file>.pre-producer-tokens`
(mode 600, the content before the change): it is written to a private temp
file, fsynced, then linked into place so it is never visible half-written and
never overwritten. An already existing backup is validated first (regular,
non-symlink, allowed owner, no group/other bits, size limit, supported subset)
and the command refuses, with the live file untouched, if it fails. The backup
always holds the state before the first helper change and contains the old
credentials: delete it once the rollout is verified and you no longer need
`rollback`.

### Supported EnvironmentFile subset

systemd parses `EnvironmentFile=` differently from a shell, so the helper
accepts only a conservative subset and refuses (exit 3, file unchanged, with a
secret-free message) anything else in a file it must read or modify:

- no `export` prefix on any key the helper reads or writes (systemd does not
  accept it);
- no value, anywhere in the file, that opens a quote not closed on the same
  line (a multi-line quoted value could hide a fake assignment);
- no backslash in any value the helper reads or writes, and no line anywhere
  ending in a backslash (line continuation, including in comments);
- no carriage returns: CRLF files are refused, not edited;
- for the keys the helper reads or writes, quotes only as one wrapping pair
  (`KEY=value`, `KEY='value'` or `KEY="value"`); and
- a key that must be read or modified and is assigned more than once.

The helper always writes plain `KEY=value` (tokens) or `KEY='json'` (the
registry), never an `export` prefix. A double-quoted registry is refused
because JSON needs backslash escapes there; convert it to the single-quoted
form by hand first.

### Never echoing a credential

`register` refuses an existing or resulting registry in which any id, host or
service equals any token in the registry or the legacy fleet token, because
`diagnose` and the status output print ids and scopes. `diagnose` prints
`<redacted>` for any id, host or service equal to such a value (and still
validates normally).

## Commands

| Command | Purpose | Exit |
| --- | --- | --- |
| `diagnose --server-env PATH` | Registry present/valid, producer count, each id with its hosts/services, legacy token present (yes/no). | 0 valid, 1 absent, 2 invalid (secret-free reason), 3 refused or failed |
| `register --server-env PATH --id ID [--host H ...] [--service S ...] [--replace] [--emit-token]` | Generate a token and add (or with `--replace`, rotate) the record; validates the whole registry with the same rules as `src/fleet/producer-auth.js`; writes one `HEIMDALL_INGEST_PRODUCERS_JSON='...'` line. | 0 / 3 / 4 |
| `stage --producer-env PATH [--pending-key KEY]` | Read exactly one token line from stdin and store it as `KEY` (default `HEIMDALL_PRODUCER_TOKEN_PENDING`). | 0 / 3 / 4 |
| `cutover --producer-env PATH --active-key KEY [--pending-key KEY]` | Move the pending value into the active key and delete the pending line. | 0 / 3 / 4 |
| `rollback --env PATH` | Restore `<file>.pre-producer-tokens` over the file (server or producer). The backup is kept. | 0 / 3 / 4 |

Exit code 3 means refused or failed with the files unchanged; for `register`
it also covers a failure after the registry was replaced that was fully undone
(the message says the change was rolled back). Exit code 4 means the outcome is
uncertain: a rename succeeded but the directory sync failed, or a rollback of
`register` itself failed. Run `diagnose` (and inspect the file's state) before
retrying; never blindly repeat the command.

`register --emit-token` is transactional after the registry is replaced: the
token is written to stdout first and the status to stderr afterwards; a failure
of either (or of the directory sync) restores the previous registry and exits
3. Without `--emit-token` a directory-sync failure after the replace exits 4,
and a failed status write restores the registry and exits 3.

Registry rules enforced (kept in lockstep with `parseProducerRegistry` by a
test that runs both implementations on the same inputs): unique id matching
`^[a-z0-9][a-z0-9-]{0,63}$`; distinct non-empty tokens without CR/LF; no token
equal to `HEIMDALL_FLEET_TOKEN`; at least one of `hosts`/`services`, each a
non-empty, unique list of valid names; no other keys. An invalid registry makes
every write return 503, so `register` refuses to extend an already invalid
registry.

## Rollout ceremony (per producer)

Run `register` on the Heimdall host as the owner of its env file. Hosts and
paths below are placeholders.

1. Inspect the current state on the Heimdall host:

   ```sh
   sudo scripts/producer-token-ops.py diagnose --server-env <heimdall-env-file>
   ```

2. Register the producer and install its token on the producer node in one
   pipeline. The token travels only through the pipe, and `ssh` must not
   allocate a terminal (no `-t`):

   ```sh
   sudo scripts/producer-token-ops.py register \
     --server-env <heimdall-env-file> \
     --id <producer-id> --host <fleet-host-id> --service <service-id> \
     --emit-token \
   | ssh <producer-node> \
     'sudo <path-to>/producer-token-ops.py stage --producer-env <producer-env-file>'
   ```

   Never run `register --emit-token` without a token consumer on the pipe. If
   the pipeline fails, assume the token was not delivered and re-run with
   `--replace` to issue a new one. If the write to stdout itself fails,
   `register` restores the registry.

3. Restart or reload Heimdall with your normal service procedure so it reads
   the new registry, then run `diagnose` again and check the id and scopes.
   Other producers keep their existing tokens.

4. On the producer node, cut over and restart the producer with your normal
   procedure for that producer. The active key is whatever the producer reads
   its bearer token from (for the fleet agent, `FLEET_TOKEN`):

   ```sh
   sudo <path-to>/producer-token-ops.py cutover \
     --producer-env <producer-env-file> --active-key <ACTIVE_TOKEN_KEY>
   ```

5. Verify without printing a credential: wait for the producer's next push and
   confirm the panel's `updated_at` (or the host's last-seen time) advanced on
   the Heimdall dashboard. If you read it back through the API, supply the
   operator token from a private curl config file, never as a command-line
   header.

6. Repeat per producer. Remove each `*.pre-producer-tokens` backup after the
   producer is verified.

## Rollback

On the producer node, `rollback --env <producer-env-file>` restores the file as
it was before the first helper change (this also discards a staged but not yet
cut-over token); restart the producer. On the Heimdall host,
`rollback --env <heimdall-env-file>` restores the registry as it was before the
first `register`; restart Heimdall. Because the backup is taken once, rollback
returns to the state before the first change, not just the last one. A
rollback that re-activates an old token leaves that token as compromised as it
was before; rotate it afterwards.

## Tests

`node --test test/producer-token-ops.test.js` needs no `node_modules` and no
network. It drives the script against temporary files with piped stdin and
asserts that no token value reaches stdout or stderr in any non-emit mode.
