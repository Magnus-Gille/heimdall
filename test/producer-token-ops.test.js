'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'producer-token-ops.py');
const AUTH_MODULE = path.join(__dirname, '..', 'src', 'fleet', 'producer-auth.js');
const REGISTRY_KEY = 'HEIMDALL_INGEST_PRODUCERS_JSON';
const LEGACY = 'legacy-fleet-token-must-never-appear-in-output';
const EXISTING_TOKEN = 'existing-producer-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TOKEN = 'other-producer-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OLD_ACTIVE = 'old-active-producer-token-cccccccccccccccc';
const STAGED = 'staged-producer-token-dddddddddddddddddddd';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-producer-token-'));
}

function writeEnv(file, lines, mode = 0o600) {
  fs.writeFileSync(file, lines.join('\n'), { mode });
  fs.chmodSync(file, mode);
}

function spawnWithStdin(cmd, cmdArgs, stdin) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// Tokens and other data only ever travel over stdin, never on the command line.
function run(args, { stdin = '' } = {}) {
  return spawnWithStdin('python3', [SCRIPT, ...args], stdin);
}

// Calls main() in-process with injected faults, to exercise TTY refusals, the
// legacy-token collision and failures that cannot be provoked from outside.
// Options and arguments arrive as JSON on stdin.
const PATCH_DRIVER = `
import errno, importlib.util, io, json, os, stat, sys
spec = importlib.util.spec_from_file_location("pto", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
request = json.load(sys.stdin)
opts = request.get("opts", {})
class Tty(io.StringIO):
    def isatty(self):
        return True
class TtyIn:
    buffer = io.BytesIO(b"x" * 40 + b"\\n")
    def isatty(self):
        return True
class FailFirst(io.TextIOBase):
    def __init__(self, real):
        self.real = real
        self.failed = False
    def write(self, text):
        if not self.failed:
            self.failed = True
            raise BrokenPipeError(errno.EPIPE, "injected")
        return self.real.write(text)
    def flush(self):
        self.real.flush()
    def isatty(self):
        return False
if opts.get("stdout_tty"):
    sys.stdout = Tty()
if opts.get("stdin_tty"):
    sys.stdin = TtyIn()
if "stdin_text" in opts:
    sys.stdin = io.TextIOWrapper(io.BytesIO(opts["stdin_text"].encode()))
if opts.get("collide"):
    mod.secrets.token_urlsafe = lambda _n: "legacy-fleet-token-must-never-appear-in-output"
if opts.get("stdout_fail_first"):
    sys.stdout = FailFirst(sys.stdout)
if opts.get("stderr_fail_first"):
    sys.stderr = FailFirst(sys.stderr)
real_fsync, real_replace, real_link = os.fsync, os.replace, os.link
state = {"dir": 0, "replace": 0, "touched": False}
def fsync(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode):
        state["dir"] += 1
        if state["dir"] in opts.get("dirfsync_fail", []):
            raise OSError(errno.EIO, "injected")
    elif opts.get("touch") and not state["touched"]:
        state["touched"] = True
        with open(opts["touch"], "a") as handle:
            handle.write("X=1\\n")
    return real_fsync(fd)
def replace(*a, **kw):
    state["replace"] += 1
    if state["replace"] in opts.get("replace_fail", []):
        raise OSError(errno.EIO, "injected")
    return real_replace(*a, **kw)
def link(src, dst, **kw):
    if opts.get("link") == "fail":
        raise OSError(errno.EIO, "injected")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=kw["dst_dir_fd"])
    os.write(fd, opts["race_content"].encode())
    os.close(fd)
    raise FileExistsError(errno.EEXIST, "exists")
os.fsync, os.replace = fsync, replace
if opts.get("link"):
    os.link = link
sys.exit(mod.main(request["args"]))
`;

function runDriver(args, opts = {}) {
  return spawnWithStdin('python3', ['-c', PATCH_DRIVER], JSON.stringify({ args, opts }));
}

function runPatched(mode, args) {
  const opts = {
    'stdout-tty': { stdout_tty: true },
    'stdin-tty': { stdin_tty: true },
    'legacy-collision': { collide: true },
  }[mode];
  return runDriver(args, opts);
}

function registryOf(file) {
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .find((candidate) => candidate.startsWith(REGISTRY_KEY + '='));
  if (!line) return null;
  assert.match(line, new RegExp('^' + REGISTRY_KEY + "='[^']*'$"));
  return JSON.parse(line.slice(REGISTRY_KEY.length + 2, -1));
}

function registryLine(records) {
  return REGISTRY_KEY + "='" + JSON.stringify(records) + "'";
}

function serverFixture({ records, extra = [] } = {}) {
  const dir = tmpdir();
  const env = path.join(dir, 'heimdall.env');
  const lines = ['# heimdall host env', 'HEIMDALL_BIND=127.0.0.1', 'HEIMDALL_FLEET_TOKEN=' + LEGACY, ...extra];
  if (records) lines.push(registryLine(records));
  lines.push('PORT=3033', '');
  writeEnv(env, lines);
  return { dir, env, backup: env + '.pre-producer-tokens' };
}

function producerFixture(extra = []) {
  const dir = tmpdir();
  const env = path.join(dir, 'producer.env');
  writeEnv(env, [
    '# producer', 'HEIMDALL_URL=http://127.0.0.1:3033', 'FLEET_TOKEN=' + OLD_ACTIVE, ...extra, 'OTHER=1', '',
  ]);
  return { dir, env, backup: env + '.pre-producer-tokens' };
}

const EXISTING = [{ id: 'existing', token: EXISTING_TOKEN, hosts: ['node-a'] }];

function assertNoSecrets(result, tokens) {
  for (const token of tokens) {
    assert.ok(!result.stdout.includes(token), 'stdout leaked a token');
    assert.ok(!result.stderr.includes(token), 'stderr leaked a token');
  }
  assert.ok(!result.stdout.includes(LEGACY) && !result.stderr.includes(LEGACY));
}

describe('producer-token-ops diagnose', () => {
  it('reports an absent registry with exit 1 and legacy presence only', async () => {
    const fx = serverFixture();
    const result = await run(['diagnose', '--server-env', fx.env]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /registry=absent/);
    assert.match(result.stdout, /legacy_fleet_token=present/);
    assertNoSecrets(result, []);
  });

  it('summarises a valid registry without tokens', async () => {
    const fx = serverFixture({
      records: [
        ...EXISTING,
        { id: 'panel-writer', token: OTHER_TOKEN, hosts: ['node-b', 'node-c'], services: ['svc-one'] },
      ],
    });
    const result = await run(['diagnose', '--server-env', fx.env]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /registry_valid=yes/);
    assert.match(result.stdout, /producers=2/);
    assert.match(result.stdout, /producer id=existing hosts=node-a services=-/);
    assert.match(result.stdout, /producer id=panel-writer hosts=node-b,node-c services=svc-one/);
    assertNoSecrets(result, [EXISTING_TOKEN, OTHER_TOKEN]);
  });

  it('reports an invalid registry with exit 2 and a secret-free reason', async () => {
    const fx = serverFixture({ records: [{ id: 'bad', token: EXISTING_TOKEN }] });
    const result = await run(['diagnose', '--server-env', fx.env]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /registry_valid=no/);
    assert.match(result.stdout, /reason=record 1 has no hosts or services scope/);
    assertNoSecrets(result, [EXISTING_TOKEN]);
  });

  it('flags a registry token equal to the legacy fleet token', async () => {
    const fx = serverFixture({ records: [{ id: 'bad', token: LEGACY, hosts: ['node-a'] }] });
    const result = await run(['diagnose', '--server-env', fx.env]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /equals the legacy fleet token/);
    assertNoSecrets(result, []);
  });

  it('treats a duplicated registry assignment as invalid', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'heimdall.env');
    writeEnv(env, [registryLine(EXISTING), registryLine(EXISTING), '']);
    const result = await run(['diagnose', '--server-env', env]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /more than one registry assignment/);
  });
});

describe('producer-token-ops register', () => {
  it('adds a first record, writes a single quoted line and keeps other lines byte-for-byte', async () => {
    const fx = serverFixture();
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await run([
      'register', '--server-env', fx.env, '--id', 'link-health', '--host', 'node-a', '--service', 'link-health',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const records = registryOf(fx.env);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'link-health');
    assert.deepEqual(records[0].hosts, ['node-a']);
    assert.deepEqual(records[0].services, ['link-health']);
    assert.match(records[0].token, /^[A-Za-z0-9_-]{43}$/);
    const after = fs.readFileSync(fx.env, 'utf8');
    assert.equal(after.split('\n').filter((l) => l.startsWith(REGISTRY_KEY)).length, 1);
    assert.equal(after.split('\n').filter((l) => !l.startsWith(REGISTRY_KEY)).join('\n'), before);
    assert.equal(fs.statSync(fx.env).mode & 0o777, 0o600);
    assert.match(result.stdout, /registered id=link-health action=added producers=1/);
    assertNoSecrets(result, [records[0].token]);
  });

  it('appends a second record and keeps the first', async () => {
    const fx = serverFixture({ records: EXISTING });
    const result = await run(['register', '--server-env', fx.env, '--id', 'second', '--service', 'svc-two']);
    assert.equal(result.code, 0, result.stderr);
    const records = registryOf(fx.env);
    assert.deepEqual(records.map((r) => r.id), ['existing', 'second']);
    assert.equal(records[0].token, EXISTING_TOKEN);
    assertNoSecrets(result, [EXISTING_TOKEN, records[1].token]);
  });

  it('refuses a duplicate id without --replace and leaves the file untouched', async () => {
    const fx = serverFixture({ records: EXISTING });
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await run(['register', '--server-env', fx.env, '--id', 'existing', '--host', 'node-b']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already exists/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
    assert.ok(!fs.existsSync(fx.backup));
    assertNoSecrets(result, [EXISTING_TOKEN]);
  });

  it('--replace swaps the token and scopes of that record only', async () => {
    const fx = serverFixture({
      records: [...EXISTING, { id: 'other', token: OTHER_TOKEN, services: ['svc-x'] }],
    });
    const result = await run(['register', '--server-env', fx.env, '--id', 'existing', '--host', 'node-z', '--replace']);
    assert.equal(result.code, 0, result.stderr);
    const records = registryOf(fx.env);
    assert.deepEqual(records.map((r) => r.id), ['existing', 'other']);
    assert.notEqual(records[0].token, EXISTING_TOKEN);
    assert.deepEqual(records[0].hosts, ['node-z']);
    assert.equal(records[1].token, OTHER_TOKEN);
    assert.match(result.stdout, /action=replaced/);
    assertNoSecrets(result, [EXISTING_TOKEN, OTHER_TOKEN, records[0].token]);
  });

  it('--replace refuses an id that does not exist', async () => {
    const fx = serverFixture({ records: EXISTING });
    const result = await run(['register', '--server-env', fx.env, '--id', 'ghost', '--host', 'node-a', '--replace']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no record with that id/);
  });

  for (const [label, args, pattern] of [
    ['uppercase service', ['--id', 'newcomer', '--service', 'Bad_Service'], /services scope is invalid/],
    ['bad host', ['--id', 'newcomer', '--host', 'bad host'], /hosts scope is invalid/],
    ['duplicate host', ['--id', 'newcomer', '--host', 'node-a', '--host', 'node-a'], /hosts scope is invalid/],
    ['bad id', ['--id', 'Bad_ID', '--host', 'node-a'], /id is missing or malformed/],
    ['no scope', ['--id', 'newcomer'], /at least one/],
  ]) {
    it('refuses an invalid scope or id: ' + label, async () => {
      const fx = serverFixture();
      const before = fs.readFileSync(fx.env, 'utf8');
      const result = await run(['register', '--server-env', fx.env, ...args]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, pattern);
      assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
      assert.ok(!fs.existsSync(fx.backup));
    });
  }

  it('refuses when the generated token would equal the legacy fleet token', async () => {
    const fx = serverFixture();
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await runPatched('legacy-collision', [
      'register', '--server-env', fx.env, '--id', 'collide', '--host', 'node-a',
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /equals the legacy fleet token/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
    assertNoSecrets(result, []);
  });

  it('refuses to extend an already invalid registry', async () => {
    const fx = serverFixture({ records: [{ id: 'bad', token: EXISTING_TOKEN }] });
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await run(['register', '--server-env', fx.env, '--id', 'fresh', '--host', 'node-a']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /existing registry is invalid/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
    assertNoSecrets(result, [EXISTING_TOKEN]);
  });

  it('refuses a duplicated legacy token assignment instead of guessing', async () => {
    const fx = serverFixture({ extra: ['HEIMDALL_FLEET_TOKEN=' + LEGACY] });
    const result = await run(['register', '--server-env', fx.env, '--id', 'fresh', '--host', 'node-a']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /more than one HEIMDALL_FLEET_TOKEN/);
    assertNoSecrets(result, []);
  });

  it('creates the backup once, with mode 600 and the pre-change content', async () => {
    const fx = serverFixture();
    const original = fs.readFileSync(fx.env);
    const first = await run(['register', '--server-env', fx.env, '--id', 'one', '--host', 'node-a']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /backup=created/);
    assert.deepEqual(fs.readFileSync(fx.backup), original);
    assert.equal(fs.statSync(fx.backup).mode & 0o777, 0o600);
    const second = await run(['register', '--server-env', fx.env, '--id', 'two', '--host', 'node-b']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /backup=existing/);
    assert.deepEqual(fs.readFileSync(fx.backup), original);
  });

  it('--emit-token writes exactly one token line to a pipe and keeps stderr token-free', async () => {
    const fx = serverFixture();
    const result = await run(['register', '--server-env', fx.env, '--id', 'emitter', '--host', 'node-a', '--emit-token']);
    assert.equal(result.code, 0, result.stderr);
    const records = registryOf(fx.env);
    assert.equal(result.stdout, records[0].token + '\n');
    assert.ok(!result.stderr.includes(records[0].token));
    assert.match(result.stderr, /registered id=emitter action=added/);
    assert.match(result.stderr, /token=emitted-to-stdout/);
  });

  it('--emit-token refuses a terminal stdout before modifying anything', async () => {
    const fx = serverFixture();
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await runPatched('stdout-tty', [
      'register', '--server-env', fx.env, '--id', 'emitter', '--host', 'node-a', '--emit-token',
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stdout is a terminal/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
    assert.ok(!fs.existsSync(fx.backup));
  });

  it('the emitted token pipes straight into stage', async () => {
    const fx = serverFixture();
    const producer = path.join(fx.dir, 'producer.env');
    writeEnv(producer, ['FLEET_TOKEN=old-value-eeeeeeeeeeeeeeeeeeeeee', '']);
    const registered = await run(['register', '--server-env', fx.env, '--id', 'pipe', '--host', 'node-a', '--emit-token']);
    const staged = await run(['stage', '--producer-env', producer], { stdin: registered.stdout });
    assert.equal(staged.code, 0, staged.stderr);
    const token = registryOf(fx.env)[0].token;
    assert.ok(fs.readFileSync(producer, 'utf8').includes('HEIMDALL_PRODUCER_TOKEN_PENDING=' + token + '\n'));
    assertNoSecrets(staged, [token]);
  });
});

describe('producer-token-ops stage', () => {
  it('writes the default pending key from stdin and prints no token', async () => {
    const fx = producerFixture();
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    assert.equal(result.code, 0, result.stderr);
    const after = fs.readFileSync(fx.env, 'utf8');
    assert.equal(after, before + 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED + '\n');
    assert.match(result.stdout, /staged pending_key=HEIMDALL_PRODUCER_TOKEN_PENDING/);
    assertNoSecrets(result, [STAGED, OLD_ACTIVE]);
  });

  it('replaces an existing quoted pending value with a plain assignment and accepts a missing final newline', async () => {
    const fx = producerFixture(['MY_PENDING="stale-pending-value-ffffffffffffffff"']);
    const result = await run(['stage', '--producer-env', fx.env, '--pending-key', 'MY_PENDING'], { stdin: STAGED });
    assert.equal(result.code, 0, result.stderr);
    const text = fs.readFileSync(fx.env, 'utf8');
    assert.ok(text.includes('\nMY_PENDING=' + STAGED + '\n'));
    assert.ok(!text.includes('stale-pending-value'));
  });

  for (const [label, stdin, pattern] of [
    ['empty stdin', '', /stdin is empty/],
    ['only a newline', '\n', /stdin is empty/],
    ['two lines', STAGED + '\n' + STAGED + '\n', /exactly one token line/],
    ['trailing blank line', STAGED + '\n\n', /exactly one token line/],
    ['embedded space', 'has a space-in-it-xxxxxxxxxxxxxxxx\n', /exactly one token line/],
    ['CRLF', STAGED + '\r\n', /exactly one token line/],
    ['too short', 'short\n', /exactly one token line/],
  ]) {
    it('refuses ' + label, async () => {
      const fx = producerFixture();
      const before = fs.readFileSync(fx.env, 'utf8');
      const result = await run(['stage', '--producer-env', fx.env], { stdin });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, pattern);
      assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
      assert.ok(!fs.existsSync(fx.backup));
      assertNoSecrets(result, [STAGED]);
    });
  }

  it('refuses a terminal stdin', async () => {
    const fx = producerFixture();
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await runPatched('stdin-tty', ['stage', '--producer-env', fx.env]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /terminal/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
  });

  it('refuses a duplicated pending key', async () => {
    const fx = producerFixture(['HEIMDALL_PRODUCER_TOKEN_PENDING=a', 'HEIMDALL_PRODUCER_TOKEN_PENDING=b']);
    const result = await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /more than one/);
  });

  it('creates the backup once', async () => {
    const fx = producerFixture();
    const original = fs.readFileSync(fx.env);
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    await run(['stage', '--producer-env', fx.env], { stdin: OTHER_TOKEN + '\n' });
    assert.deepEqual(fs.readFileSync(fx.backup), original);
    assert.equal(fs.statSync(fx.backup).mode & 0o777, 0o600);
  });
});

describe('producer-token-ops cutover and rollback', () => {
  it('swaps the active value, removes the pending line and keeps other lines', async () => {
    const fx = producerFixture();
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    const result = await run(['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), [
      '# producer', 'HEIMDALL_URL=http://127.0.0.1:3033', 'FLEET_TOKEN=' + STAGED, 'OTHER=1', '',
    ].join('\n'));
    assert.match(result.stdout, /cutover active_key=FLEET_TOKEN/);
    assertNoSecrets(result, [STAGED, OLD_ACTIVE]);
  });

  it('writes a plain KEY=value even when the old lines were quoted', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'producer.env');
    writeEnv(env, [
      "HEIMDALL_FLEET_TOKEN='" + OLD_ACTIVE + "'",
      'HEIMDALL_PRODUCER_TOKEN_PENDING="' + STAGED + '"',
      '',
    ]);
    const result = await run(['cutover', '--producer-env', env, '--active-key', 'HEIMDALL_FLEET_TOKEN']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(env, 'utf8'), 'HEIMDALL_FLEET_TOKEN=' + STAGED + '\n');
  });

  it('refuses without a pending value, with a missing active key, and with a duplicated active key', async () => {
    const fx = producerFixture();
    let result = await run(['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no HEIMDALL_PRODUCER_TOKEN_PENDING assignment/);

    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    result = await run(['cutover', '--producer-env', fx.env, '--active-key', 'MISSING_KEY']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no MISSING_KEY assignment/);

    const dup = producerFixture(['FLEET_TOKEN=duplicate', 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED]);
    result = await run(['cutover', '--producer-env', dup.env, '--active-key', 'FLEET_TOKEN']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /more than one FLEET_TOKEN/);
    assertNoSecrets(result, [STAGED, OLD_ACTIVE]);
  });

  it('refuses an empty pending value', async () => {
    const fx = producerFixture(['HEIMDALL_PRODUCER_TOKEN_PENDING=']);
    const before = fs.readFileSync(fx.env, 'utf8');
    const result = await run(['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN']);
    assert.notEqual(result.code, 0);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), before);
  });

  it('rollback restores the original producer file and keeps the backup', async () => {
    const fx = producerFixture();
    const original = fs.readFileSync(fx.env);
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    await run(['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN']);
    const result = await run(['rollback', '--env', fx.env]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(fx.env), original);
    assert.ok(fs.existsSync(fx.backup));
    assert.equal(fs.statSync(fx.env).mode & 0o777, 0o600);
    assertNoSecrets(result, [STAGED, OLD_ACTIVE]);
    const again = await run(['rollback', '--env', fx.env]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /unchanged/);
  });

  it('rollback restores a server env file after register', async () => {
    const fx = serverFixture({ records: EXISTING });
    const original = fs.readFileSync(fx.env);
    await run(['register', '--server-env', fx.env, '--id', 'second', '--host', 'node-b']);
    assert.notDeepEqual(fs.readFileSync(fx.env), original);
    const result = await run(['rollback', '--env', fx.env]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(fx.env), original);
  });

  it('rollback refuses when there is no backup', async () => {
    const fx = producerFixture();
    const result = await run(['rollback', '--env', fx.env]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /backup/);
  });
});

describe('producer-token-ops file safety', () => {
  const invocations = (file) => [
    ['diagnose', '--server-env', file],
    ['register', '--server-env', file, '--id', 'x', '--host', 'node-a'],
    ['stage', '--producer-env', file],
    ['cutover', '--producer-env', file, '--active-key', 'FLEET_TOKEN'],
    ['rollback', '--env', file],
  ];

  for (const mode of [0o640, 0o604, 0o644, 0o660]) {
    it('refuses a group/other accessible file (mode ' + mode.toString(8) + ')', async () => {
      const fx = serverFixture();
      fs.chmodSync(fx.env, mode);
      for (const args of invocations(fx.env)) {
        const result = await run(args, { stdin: STAGED + '\n' });
        assert.notEqual(result.code, 0, args[0]);
        assert.match(result.stderr, /group\/world accessible/, args[0]);
      }
      assert.ok(!fs.existsSync(fx.backup));
    });
  }

  it('refuses a symlinked env file', async () => {
    const fx = serverFixture();
    const link = path.join(fx.dir, 'link.env');
    fs.symlinkSync(fx.env, link);
    for (const args of invocations(link)) {
      const result = await run(args, { stdin: STAGED + '\n' });
      assert.notEqual(result.code, 0, args[0]);
      assert.match(result.stderr, /symlink|cannot open/, args[0]);
    }
    assert.ok(!fs.existsSync(link + '.pre-producer-tokens'));
  });

  it('refuses a symlinked backup path on rollback', async () => {
    const fx = producerFixture();
    fs.writeFileSync(path.join(fx.dir, 'real-backup'), 'x\n', { mode: 0o600 });
    fs.symlinkSync(path.join(fx.dir, 'real-backup'), fx.backup);
    const result = await run(['rollback', '--env', fx.env]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /symlink|cannot open/);
  });

  it('refuses a relative path and a directory', async () => {
    const fx = serverFixture();
    let result = await run(['diagnose', '--server-env', 'heimdall.env']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /absolute/);
    result = await run(['diagnose', '--server-env', fx.dir]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a regular file/);
  });

  it('refuses a rollback whose backup is group/other readable', async () => {
    const fx = producerFixture();
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    fs.chmodSync(fx.backup, 0o644);
    const result = await run(['rollback', '--env', fx.env]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /group\/world accessible/);
  });

  it('leaves no temp files behind after writes', async () => {
    const fx = producerFixture();
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    await run(['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN']);
    assert.deepEqual(fs.readdirSync(fx.dir).sort(), ['producer.env', 'producer.env.pre-producer-tokens']);
  });
});

// --- Python validation vs the real loadProducerRegistry ---------------------

const NODE_DRIVER = `
const { loadProducerRegistry } = require(${JSON.stringify(AUTH_MODULE)});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map(({ raw, legacy }) => {
    const result = loadProducerRegistry(raw, legacy);
    return result.ok ? { ok: true, producers: result.producers } : { ok: false };
  });
  process.stdout.write(JSON.stringify(out));
});
`;

const PY_DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pto", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
cases = json.load(sys.stdin)
out = []
for case in cases:
    producers, _reason = mod.parse_registry(case["raw"], case["legacy"])
    if producers is None:
        out.append({"ok": False})
    else:
        out.append({"ok": True, "producers": [
            {"id": p["id"], "hosts": p["hosts"], "services": p["services"]} for p in producers]})
sys.stdout.write(json.dumps(out))
`;

const rec = (over = {}) => ({ id: 'alpha', token: 'tok-alpha', hosts: ['node-a'], ...over });
const j = (value) => JSON.stringify(value);
const CROSS_CASES = [
  // valid
  ['hosts only', j([rec()])],
  ['services only', j([{ id: 'a', token: 't', services: ['svc'] }])],
  ['hosts and services', j([rec({ services: ['svc'] })])],
  ['several records', j([rec(), rec({ id: 'beta', token: 'tok-beta', hosts: ['node-b', 'Node.C_1'] })])],
  ['token with inner spaces and unicode', j([rec({ token: 'tok with space é中' })])],
  ['token of only a non-JS-whitespace control char', j([rec({ token: '\u001c' })])],
  ['whitespace around the array', '  \n' + j([rec()]) + '\t '],
  ['64-char id', j([rec({ id: 'a'.repeat(64) })])],
  ['64-char host', j([rec({ hosts: ['H'.repeat(64)] })])],
  ['duplicate JSON key last wins', '[{"id":"a","id":"b","token":"t","hosts":["h"]}]'],
  // invalid
  ['empty string', ''],
  ['whitespace only', ' \n\t'],
  ['not JSON', 'nope'],
  ['NaN literal', '[{"id":"a","token":NaN,"hosts":["h"]}]'],
  ['object not array', '{}'],
  ['empty array', '[]'],
  ['null', 'null'],
  ['array of number', '[1]'],
  ['array of null', '[null]'],
  ['array of array', '[[]]'],
  ['duplicate id', j([rec(), rec({ token: 'other' })])],
  ['duplicate token', j([rec(), rec({ id: 'beta' })])],
  ['blank token', j([rec({ token: '   ' })])],
  ['NBSP-only token', j([rec({ token: ' ' })])],
  ['BOM-only token', j([rec({ token: '﻿' })])],
  ['ideographic-space token', j([rec({ token: '　' })])],
  ['empty token', j([rec({ token: '' })])],
  ['token with newline', j([rec({ token: 'a\nb' })])],
  ['token with CR', j([rec({ token: 'a\rb' })])],
  ['non-string token', j([rec({ token: 5 })])],
  ['missing token', j([{ id: 'a', hosts: ['h'] }])],
  ['token equals legacy', j([rec({ token: 'LEGACY-VALUE' })]), 'LEGACY-VALUE'],
  ['distinct lone-surrogate token vs legacy', '[{"id":"a","token":"\\ud800","hosts":["h"]}]', '\ud801'],
  ['extra key', j([rec({ extra: 1 })])],
  ['__proto__ key', '[{"id":"a","token":"t","hosts":["h"],"__proto__":{}}]'],
  ['uppercase id', j([rec({ id: 'Alpha' })])],
  ['id leading dash', j([rec({ id: '-a' })])],
  ['65-char id', j([rec({ id: 'a'.repeat(65) })])],
  ['id with trailing newline', j([rec({ id: 'alpha\n' })])],
  ['non-string id', j([rec({ id: 7 })])],
  ['missing id', j([{ token: 't', hosts: ['h'] }])],
  ['no scope', j([{ id: 'a', token: 't' }])],
  ['empty hosts list', j([rec({ hosts: [] })])],
  ['null hosts', j([rec({ hosts: null })])],
  ['string hosts', j([rec({ hosts: 'node-a' })])],
  ['empty services list with hosts', j([rec({ services: [] })])],
  ['duplicate host', j([rec({ hosts: ['node-a', 'node-a'] })])],
  ['bad host', j([rec({ hosts: ['bad host'] })])],
  ['host with trailing newline', j([rec({ hosts: ['node-a\n'] })])],
  ['65-char host', j([rec({ hosts: ['h'.repeat(65)] })])],
  ['wildcard host', j([rec({ hosts: ['*'] })])],
  ['uppercase service', j([rec({ hosts: undefined, services: ['Svc'] })])],
  ['service underscore', j([rec({ hosts: undefined, services: ['svc_x'] })])],
  ['service trailing newline', j([rec({ hosts: undefined, services: ['svc\n'] })])],
  ['non-string host entry', j([rec({ hosts: [1] })])],
  ['one bad record among good ones', j([rec(), rec({ id: 'beta', token: 'tb', hosts: [] })])],
];

describe('producer-token-ops registry validation matches producer-auth.js', () => {
  it('loads producer-auth.js without node_modules', () => {
    assert.equal(typeof require(AUTH_MODULE).loadProducerRegistry, 'function');
  });

  it('agrees with loadProducerRegistry on valid and invalid registries', async () => {
    const cases = CROSS_CASES.map(([, raw, legacy]) => ({ raw, legacy: legacy ?? '' }));
    const payload = JSON.stringify(cases);
    const [jsResult, pyResult] = await Promise.all([
      spawnWithStdin(process.execPath, ['-e', NODE_DRIVER], payload),
      spawnWithStdin('python3', ['-c', PY_DRIVER], payload),
    ]);
    assert.equal(jsResult.code, 0, jsResult.stderr);
    assert.equal(pyResult.code, 0, pyResult.stderr);
    const js = JSON.parse(jsResult.stdout);
    const py = JSON.parse(pyResult.stdout);
    assert.equal(js.length, CROSS_CASES.length);
    CROSS_CASES.forEach(([label], index) => {
      assert.deepEqual(py[index], js[index], 'mismatch for: ' + label);
    });
    assert.ok(js.some((entry) => entry.ok), 'cross-check needs valid cases');
    assert.ok(js.some((entry) => !entry.ok), 'cross-check needs invalid cases');
  });
});

describe('producer-token-ops never prints token values', () => {
  it('keeps every token out of stdout/stderr across a full rollout', async () => {
    const fx = serverFixture({ records: EXISTING });
    const producer = path.join(fx.dir, 'producer.env');
    writeEnv(producer, ['FLEET_TOKEN=' + OLD_ACTIVE, '']);
    const outputs = [];
    outputs.push(await run(['diagnose', '--server-env', fx.env]));
    outputs.push(await run(['register', '--server-env', fx.env, '--id', 'rollout', '--host', 'node-a']));
    outputs.push(await run(['register', '--server-env', fx.env, '--id', 'rollout', '--host', 'node-a']));
    outputs.push(await run(['register', '--server-env', fx.env, '--id', 'rollout', '--host', 'node-a', '--replace']));
    outputs.push(await run(['diagnose', '--server-env', fx.env]));
    outputs.push(await run(['stage', '--producer-env', producer], { stdin: STAGED + '\n' }));
    outputs.push(await run(['stage', '--producer-env', producer], { stdin: 'bad token\n' }));
    outputs.push(await run(['cutover', '--producer-env', producer, '--active-key', 'FLEET_TOKEN']));
    outputs.push(await run(['rollback', '--env', producer]));
    outputs.push(await run(['rollback', '--env', fx.env]));
    const tokens = [EXISTING_TOKEN, OLD_ACTIVE, STAGED, LEGACY, 'bad token'];
    for (const result of outputs) assertNoSecrets(result, tokens);
    // Generated tokens must not appear in non-emit mode either.
    const registered = await run(['register', '--server-env', fx.env, '--id', 'again', '--host', 'node-q']);
    const generated = registryOf(fx.env).find((r) => r.id === 'again').token;
    assertNoSecrets(registered, [generated]);
  });
});

// --- Review findings: systemd subset, path safety, backups, transactions ----

const listing = (dir) => fs.readdirSync(dir).sort();

// Finding 1: the helper only supports the EnvironmentFile subset it can parse
// identically to systemd, and refuses everything else with the file untouched.
describe('producer-token-ops supported EnvironmentFile subset', () => {
  const reg = registryLine(EXISTING);
  const SERVER_BAD = [
    ['export prefix on the registry key', ['export ' + reg, 'PORT=1', '']],
    ['export prefix on the legacy token', ['export HEIMDALL_FLEET_TOKEN=' + LEGACY, reg, '']],
    ['multi-line quoted value hiding a fake assignment',
      ["NOTE='first line", reg.replace(EXISTING_TOKEN, 'fake-token-hidden-in-quote-aaaaaaaaaa'), "end'", '']],
    ['multi-line double-quoted value elsewhere', ['NOTE="first line', 'second line"', reg, '']],
    ['quote opened mid-value', ['NOTE=ab"cd', reg, '']],
    ['backslash in the registry value', [REGISTRY_KEY + "='[{\"id\":\"a\",\"token\":\"t\\\\u0041\",\"hosts\":[\"h\"]}]'", '']],
    ['backslash in the legacy token', ['HEIMDALL_FLEET_TOKEN=abc\\def', reg, '']],
    ['backslash line continuation', ['NOTE=abc\\', reg, '']],
    ['backslash-continued comment', ['# comment \\', reg, '']],
    ['double-quoted registry (needs backslash escapes)',
      [REGISTRY_KEY + '="' + JSON.stringify(EXISTING).replace(/"/g, '\\"') + '"', '']],
    ['unquoted JSON registry', [REGISTRY_KEY + '=' + JSON.stringify(EXISTING), '']],
    ['CRLF line endings', ['PORT=1\r', reg + '\r', '']],
  ];

  for (const [label, lines] of SERVER_BAD) {
    it('server env refused (exit 3, unchanged): ' + label, async () => {
      const dir = tmpdir();
      const env = path.join(dir, 'heimdall.env');
      writeEnv(env, lines);
      const before = fs.readFileSync(env);
      for (const args of [
        ['diagnose', '--server-env', env],
        ['register', '--server-env', env, '--id', 'fresh', '--host', 'node-a'],
      ]) {
        const result = await run(args);
        assert.equal(result.code, 3, args[0] + ' ' + result.stderr);
        assert.match(result.stderr, /refusing|unsupported/);
        assertNoSecrets(result, [EXISTING_TOKEN]);
      }
      assert.deepEqual(fs.readFileSync(env), before);
      assert.deepEqual(listing(dir), ['heimdall.env']);
    });
  }

  const PRODUCER_BAD = [
    ['export prefix on the pending key', ['export HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED, 'FLEET_TOKEN=' + OLD_ACTIVE, '']],
    ['export prefix on the active key', ['export FLEET_TOKEN=' + OLD_ACTIVE, 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED, ''], 'cutover'],
    ['multi-line quoted value elsewhere', ["NOTE='a", "b'", 'FLEET_TOKEN=' + OLD_ACTIVE, 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED, '']],
    ['backslash in the active value', ['FLEET_TOKEN=old\\value', 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED, ''], 'cutover'],
    ['backslash in the pending value', ['FLEET_TOKEN=' + OLD_ACTIVE, 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED + '\\x', '']],
    ['CRLF line endings', ['FLEET_TOKEN=' + OLD_ACTIVE + '\r', 'HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED + '\r', '']],
  ];

  for (const [label, lines, only] of PRODUCER_BAD) {
    it('producer env refused (exit 3, unchanged): ' + label, async () => {
      const dir = tmpdir();
      const env = path.join(dir, 'producer.env');
      writeEnv(env, lines);
      const before = fs.readFileSync(env);
      for (const [args, stdin] of [
        [['stage', '--producer-env', env], OTHER_TOKEN + '\n'],
        [['cutover', '--producer-env', env, '--active-key', 'FLEET_TOKEN'], ''],
      ].filter(([args]) => !only || args[0] === only)) {
        const result = await run(args, { stdin });
        assert.equal(result.code, 3, args[0] + ' ' + result.stderr);
        assertNoSecrets(result, [STAGED, OLD_ACTIVE, OTHER_TOKEN]);
      }
      assert.deepEqual(fs.readFileSync(env), before);
      assert.deepEqual(listing(dir), ['producer.env']);
    });
  }

  it('accepts comments, blank lines and single-quoted values and writes plain assignments', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'producer.env');
    writeEnv(env, ['# note: it\'s fine in a comment', '; also a comment', '', "FLEET_TOKEN='" + OLD_ACTIVE + "'", '']);
    let result = await run(['stage', '--producer-env', env], { stdin: STAGED + '\n' });
    assert.equal(result.code, 0, result.stderr);
    result = await run(['cutover', '--producer-env', env, '--active-key', 'FLEET_TOKEN']);
    assert.equal(result.code, 0, result.stderr);
    const text = fs.readFileSync(env, 'utf8');
    assert.ok(text.includes('\nFLEET_TOKEN=' + STAGED + '\n'));
    assert.ok(!/export/.test(text.replace('# note', '')));
  });
});

// Finding 2: write-transaction path safety.
describe('producer-token-ops write path safety', () => {
  const writers = (file, extra) => [
    [['register', '--server-env', file, '--id', 'x', '--host', 'node-a'], ''],
    [['stage', '--producer-env', file], STAGED + '\n'],
    [['cutover', '--producer-env', file, '--active-key', 'FLEET_TOKEN'], ''],
    [['rollback', '--env', file], ''],
  ];

  for (const mode of [0o770, 0o777, 0o720]) {
    it('refuses writes into a group/other-writable directory (mode ' + mode.toString(8) + ')', async () => {
      const fx = serverFixture();
      const before = fs.readFileSync(fx.env);
      fs.chmodSync(fx.dir, mode);
      try {
        for (const [args, stdin] of writers(fx.env)) {
          const result = await run(args, { stdin });
          assert.equal(result.code, 3, args[0]);
          assert.match(result.stderr, /group\/world writable/, args[0]);
        }
        assert.deepEqual(fs.readFileSync(fx.env), before);
        assert.deepEqual(listing(fx.dir), ['heimdall.env']);
        // Read-only diagnosis does not modify anything and stays available.
        assert.equal((await run(['diagnose', '--server-env', fx.env])).code, 1);
      } finally {
        fs.chmodSync(fx.dir, 0o700);
      }
    });
  }

  it('refuses a symlinked parent directory', async () => {
    const fx = serverFixture();
    const holder = tmpdir();
    const linkDir = path.join(holder, 'linked');
    fs.symlinkSync(fx.dir, linkDir);
    const file = path.join(linkDir, 'heimdall.env');
    const before = fs.readFileSync(fx.env);
    for (const [args, stdin] of writers(file)) {
      const result = await run(args, { stdin });
      assert.equal(result.code, 3, args[0]);
      assert.match(result.stderr, /environment directory/, args[0]);
    }
    assert.equal((await run(['diagnose', '--server-env', file])).code, 3);
    assert.deepEqual(fs.readFileSync(fx.env), before);
    assert.deepEqual(listing(fx.dir), ['heimdall.env']);
  });

  it('refuses to overwrite a file modified after it was read (register)', async () => {
    const fx = serverFixture();
    const original = fs.readFileSync(fx.env, 'utf8');
    const result = await runDriver(
      ['register', '--server-env', fx.env, '--id', 'raced', '--host', 'node-a'],
      { touch: fx.env },
    );
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /changed during the operation/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), original + 'X=1\n');
    assert.ok(!listing(fx.dir).some((name) => name.includes('producer-token-')), 'temp file left behind');
  });

  it('refuses to overwrite a file modified after it was read (rollback)', async () => {
    const fx = producerFixture();
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    const staged = fs.readFileSync(fx.env, 'utf8');
    const result = await runDriver(['rollback', '--env', fx.env], { touch: fx.env });
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /changed during the operation/);
    assert.equal(fs.readFileSync(fx.env, 'utf8'), staged + 'X=1\n');
    assert.ok(!listing(fx.dir).some((name) => name.includes('producer-token-')));
  });

  it('a failing rename leaves the file unchanged and no temp file', async () => {
    const fx = serverFixture();
    const before = fs.readFileSync(fx.env);
    const result = await runDriver(
      ['register', '--server-env', fx.env, '--id', 'x', '--host', 'node-a'],
      { replace_fail: [1] },
    );
    assert.equal(result.code, 3);
    assert.deepEqual(fs.readFileSync(fx.env), before);
    assert.ok(!listing(fx.dir).some((name) => name.includes('producer-token-')));
  });
});

// Finding 3: an existing backup is validated before the live file changes.
describe('producer-token-ops existing backup validation', () => {
  const VALID_BACKUP = '# earlier state\nFLEET_TOKEN=earlier-value-gggggggggggggggg\n';
  const makers = [
    ['group-readable', (backup) => { fs.writeFileSync(backup, VALID_BACKUP, { mode: 0o644 }); fs.chmodSync(backup, 0o644); }],
    ['symlink', (backup) => {
      const target = backup + '.target';
      fs.writeFileSync(target, VALID_BACKUP, { mode: 0o600 });
      fs.symlinkSync(target, backup);
    }],
    ['directory', (backup) => fs.mkdirSync(backup, { mode: 0o700 })],
    ['multi-line quoted content', (backup) => fs.writeFileSync(backup, "NOTE='a\nb'\n", { mode: 0o600 })],
    ['CRLF content', (backup) => fs.writeFileSync(backup, 'A=1\r\n', { mode: 0o600 })],
    ['oversized', (backup) => fs.writeFileSync(backup, 'A=' + 'x'.repeat(1024 * 1024 + 10) + '\n', { mode: 0o600 })],
  ];

  for (const [label, make] of makers) {
    it('refuses writers while the existing backup is invalid: ' + label, async () => {
      const fx = producerFixture(['HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED]);
      make(fx.backup);
      const before = fs.readFileSync(fx.env);
      const names = listing(fx.dir);
      for (const [args, stdin] of [
        [['stage', '--producer-env', fx.env], OTHER_TOKEN + '\n'],
        [['cutover', '--producer-env', fx.env, '--active-key', 'FLEET_TOKEN'], ''],
        [['rollback', '--env', fx.env], ''],
      ]) {
        const result = await run(args, { stdin });
        assert.equal(result.code, 3, args[0] + ' ' + result.stderr);
        assert.match(result.stderr, /backup/);
        assertNoSecrets(result, [STAGED, OTHER_TOKEN, OLD_ACTIVE]);
      }
      assert.deepEqual(fs.readFileSync(fx.env), before);
      assert.deepEqual(listing(fx.dir), names);
    });
  }

  it('refuses register while the existing backup is invalid', async () => {
    const fx = serverFixture();
    fs.writeFileSync(fx.backup, VALID_BACKUP, { mode: 0o644 });
    fs.chmodSync(fx.backup, 0o644);
    const before = fs.readFileSync(fx.env);
    const result = await run(['register', '--server-env', fx.env, '--id', 'x', '--host', 'node-a']);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /backup/);
    assert.deepEqual(fs.readFileSync(fx.env), before);
  });

  it('keeps using a valid existing backup unchanged', async () => {
    const fx = producerFixture();
    fs.writeFileSync(fx.backup, VALID_BACKUP, { mode: 0o600 });
    const result = await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /backup=existing/);
    assert.equal(fs.readFileSync(fx.backup, 'utf8'), VALID_BACKUP);
  });
});

// Finding 4: the backup is published atomically and never half-written.
describe('producer-token-ops atomic backup creation', () => {
  it('a failing publish leaves no backup, no temp file and the live file unchanged', async () => {
    const fx = producerFixture();
    const before = fs.readFileSync(fx.env);
    const result = await runDriver(['stage', '--producer-env', fx.env], { link: 'fail', stdin_text: STAGED + '\n' });
    assert.equal(result.code, 3, result.stderr);
    assert.deepEqual(fs.readFileSync(fx.env), before);
    assert.deepEqual(listing(fx.dir), ['producer.env']);
  });

  it('losing the publish race falls back to validating the winner and proceeds', async () => {
    const fx = producerFixture();
    const result = await runDriver(['stage', '--producer-env', fx.env], {
      link: 'race', race_content: '# winner\nFLEET_TOKEN=winner-value-hhhhhhhhhhhhhhhhh\n', stdin_text: STAGED + '\n',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /backup=existing/);
    assert.equal(fs.readFileSync(fx.backup, 'utf8'), '# winner\nFLEET_TOKEN=winner-value-hhhhhhhhhhhhhhhhh\n');
    assert.deepEqual(listing(fx.dir), ['producer.env', 'producer.env.pre-producer-tokens']);
    assert.ok(fs.readFileSync(fx.env, 'utf8').includes('HEIMDALL_PRODUCER_TOKEN_PENDING=' + STAGED));
  });

  it('losing the race to an invalid backup refuses and leaves the live file unchanged', async () => {
    const fx = producerFixture();
    const before = fs.readFileSync(fx.env);
    const result = await runDriver(['stage', '--producer-env', fx.env], {
      link: 'race', race_content: "NOTE='a\nb'\n", stdin_text: STAGED + '\n',
    });
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /backup/);
    assert.deepEqual(fs.readFileSync(fx.env), before);
    assert.ok(!listing(fx.dir).some((name) => name.includes('.tmp-')));
  });

  it('a failing directory sync before the live replace leaves the live file unchanged', async () => {
    const fx = producerFixture();
    const before = fs.readFileSync(fx.env);
    const result = await runDriver(['stage', '--producer-env', fx.env], { dirfsync_fail: [1], stdin_text: STAGED + '\n' });
    assert.equal(result.code, 3, result.stderr);
    assert.deepEqual(fs.readFileSync(fx.env), before);
  });

  it('leaves no temp files after a successful publish', async () => {
    const fx = producerFixture();
    const result = await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    assert.equal(result.code, 0);
    assert.deepEqual(listing(fx.dir), ['producer.env', 'producer.env.pre-producer-tokens']);
  });
});

// Finding 5: register is transactional once the registry has been replaced.
describe('producer-token-ops register transaction', () => {
  const REG_ARGS = (file, extra = []) => ['register', '--server-env', file, '--id', 'newcomer', '--host', 'node-a', ...extra];

  async function scenario(opts, extra = ['--emit-token']) {
    const fx = serverFixture({ records: EXISTING });
    const original = fs.readFileSync(fx.env);
    const result = await runDriver(REG_ARGS(fx.env, extra), opts);
    return { fx, original, result, now: fs.readFileSync(fx.env) };
  }

  it('emit: a failing token write restores the registry (exit 3, rolled back)', async () => {
    const { original, result, now, fx } = await scenario({ stdout_fail_first: true });
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /rolled back/);
    assert.deepEqual(now, original);
    assert.equal(result.stdout, '');
    assert.ok(!listing(fx.dir).some((name) => name.includes('producer-token-')));
  });

  it('emit: the token is written before the status; a failing status write restores the registry', async () => {
    const { original, result, now } = await scenario({ stderr_fail_first: true });
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /rolled back/);
    assert.match(result.stdout, /^[A-Za-z0-9_-]{43}\n$/);
    assert.deepEqual(now, original);
    assert.ok(!result.stderr.includes(result.stdout.trim()));
  });

  it('emit: a failing directory sync after the replace restores the registry before any token is written', async () => {
    const { original, result, now } = await scenario({ dirfsync_fail: [2] });
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /rolled back/);
    assert.equal(result.stdout, '');
    assert.deepEqual(now, original);
  });

  it('emit: failed directory sync plus failed restore is the distinct uncertain exit 4', async () => {
    const { result } = await scenario({ dirfsync_fail: [2], replace_fail: [2] });
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /uncertain/);
    assert.match(result.stderr, /diagnose/);
    assert.equal(result.stdout, '');
  });

  it('emit: failed token write plus failed restore is exit 4 and says so', async () => {
    const { result } = await scenario({ stdout_fail_first: true, replace_fail: [2] });
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /uncertain/);
  });

  it('non-emit: a failing directory sync after the replace is exit 4 (uncertain)', async () => {
    const { original, result, now } = await scenario({ dirfsync_fail: [2] }, []);
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /uncertain/);
    assert.match(result.stderr, /diagnose/);
    assert.notDeepEqual(now, original);
  });

  it('non-emit: a failing status write restores the registry (exit 3, rolled back)', async () => {
    const { original, result, now } = await scenario({ stdout_fail_first: true }, []);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /rolled back/);
    assert.deepEqual(now, original);
  });

  it('a failing rename before anything is replaced is exit 3 with the registry unchanged', async () => {
    const { original, result, now } = await scenario({ replace_fail: [1] });
    assert.equal(result.code, 3);
    assert.deepEqual(now, original);
    assert.equal(result.stdout, '');
  });

  it('a stage whose directory sync fails after the replace reports exit 4', async () => {
    const fx = producerFixture();
    const result = await runDriver(['stage', '--producer-env', fx.env], { dirfsync_fail: [2], stdin_text: STAGED + '\n' });
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /uncertain/);
    assertNoSecrets(result, [STAGED]);
  });

  it('success still emits exactly the token on stdout and the status on stderr', async () => {
    const { result, fx } = await scenario({});
    assert.equal(result.code, 0, result.stderr);
    const token = registryOf(fx.env).find((r) => r.id === 'newcomer').token;
    assert.equal(result.stdout, token + '\n');
    assert.ok(!result.stderr.includes(token));
  });
});

// Finding 6: identifiers never equal (and so never print) a credential.
describe('producer-token-ops credential echo protection', () => {
  const SHARED = 'shared-value-token-aaaaaaaaaaaa';
  const LOWER_TOKEN = 'lowercase-token-value-bbbbbbbbbbbb';

  it('register refuses an existing registry whose host equals a token', async () => {
    const fx = serverFixture({ records: [
      { id: 'a', token: SHARED, hosts: ['node-a'] },
      { id: 'b', token: OTHER_TOKEN, hosts: [SHARED] },
    ] });
    const before = fs.readFileSync(fx.env);
    const result = await run(['register', '--server-env', fx.env, '--id', 'c', '--host', 'node-c']);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /equal to a credential/);
    assert.deepEqual(fs.readFileSync(fx.env), before);
    assertNoSecrets(result, [SHARED, OTHER_TOKEN]);
  });

  it('register refuses an existing registry whose service equals the legacy token', async () => {
    const fx = serverFixture({ records: [{ id: 'a', token: EXISTING_TOKEN, services: [LEGACY] }] });
    const result = await run(['register', '--server-env', fx.env, '--id', 'c', '--host', 'node-c']);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /equal to a credential/);
    assertNoSecrets(result, [EXISTING_TOKEN]);
  });

  it('register refuses a new id or scope equal to the legacy token or an existing token', async () => {
    const fx = serverFixture({ records: [{ id: 'a', token: LOWER_TOKEN, hosts: ['node-a'] }] });
    const before = fs.readFileSync(fx.env);
    for (const extra of [
      ['--id', LEGACY, '--host', 'node-c'],
      ['--id', 'c', '--service', LEGACY],
      ['--id', LOWER_TOKEN, '--host', 'node-c'],
      ['--id', 'c', '--host', LOWER_TOKEN],
    ]) {
      const result = await run(['register', '--server-env', fx.env, ...extra]);
      assert.equal(result.code, 3, extra.join(' '));
      assert.match(result.stderr, /equal a credential/);
      assertNoSecrets(result, [LOWER_TOKEN]);
    }
    assert.deepEqual(fs.readFileSync(fx.env), before);
  });

  it('diagnose prints <redacted> for ids and scopes equal to a token and still validates', async () => {
    const fx = serverFixture({ records: [
      { id: 'a', token: LOWER_TOKEN, hosts: ['node-a'] },
      { id: LOWER_TOKEN, token: OTHER_TOKEN, hosts: [SHARED, 'node-b'], services: [LEGACY] },
      { id: 'c', token: SHARED, services: ['svc-c'] },
    ] });
    const result = await run(['diagnose', '--server-env', fx.env]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /registry_valid=yes/);
    assert.match(result.stdout, /producer id=<redacted> hosts=<redacted>,node-b services=<redacted>/);
    assert.match(result.stdout, /producer id=a hosts=node-a services=-/);
    assertNoSecrets(result, [LOWER_TOKEN, SHARED, OTHER_TOKEN]);
  });
});

// Coverage the review flagged as missing.
describe('producer-token-ops additional coverage', () => {
  it('rollback right after stage (no cutover) removes the staged token and keeps the backup', async () => {
    const fx = producerFixture();
    const original = fs.readFileSync(fx.env);
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    assert.ok(fs.readFileSync(fx.env, 'utf8').includes(STAGED));
    const result = await run(['rollback', '--env', fx.env]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(fx.env), original);
    assert.ok(fs.existsSync(fx.backup));
    assertNoSecrets(result, [STAGED, OLD_ACTIVE]);
  });

  it('refuses CRLF files rather than editing them (documented choice)', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'producer.env');
    writeEnv(env, ['FLEET_TOKEN=' + OLD_ACTIVE + '\r', '']);
    const result = await run(['stage', '--producer-env', env], { stdin: STAGED + '\n' });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /CRLF/);
    assert.deepEqual(listing(dir), ['producer.env']);
  });

  it('a failing rename during rollback leaves the live file unchanged', async () => {
    const fx = producerFixture();
    await run(['stage', '--producer-env', fx.env], { stdin: STAGED + '\n' });
    const staged = fs.readFileSync(fx.env);
    const result = await runDriver(['rollback', '--env', fx.env], { replace_fail: [1] });
    assert.equal(result.code, 3);
    assert.deepEqual(fs.readFileSync(fx.env), staged);
    assert.ok(!listing(fx.dir).some((name) => name.includes('producer-token-')));
  });
});
