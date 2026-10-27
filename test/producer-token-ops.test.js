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

// Calls main() in-process with a patched stream, to exercise the TTY refusals
// and the legacy-token collision. Mode and arguments arrive as JSON on stdin.
const PATCH_DRIVER = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("pto", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
request = json.load(sys.stdin)
mode = request["mode"]
class Tty(io.StringIO):
    def isatty(self):
        return True
class TtyIn:
    buffer = io.BytesIO(b"x" * 40 + b"\\n")
    def isatty(self):
        return True
if mode == "stdout-tty":
    sys.stdout = Tty()
elif mode == "stdin-tty":
    sys.stdin = TtyIn()
elif mode == "legacy-collision":
    mod.secrets.token_urlsafe = lambda _n: "legacy-fleet-token-must-never-appear-in-output"
sys.exit(mod.main(request["args"]))
`;

function runPatched(mode, args) {
  return spawnWithStdin('python3', ['-c', PATCH_DRIVER], JSON.stringify({ mode, args }));
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

  it('reads exported, double-quoted registry assignments', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'heimdall.env');
    const json = JSON.stringify(EXISTING).replace(/"/g, '\\"');
    writeEnv(env, ['export ' + REGISTRY_KEY + '="' + json + '"', '']);
    const result = await run(['diagnose', '--server-env', env]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /producer id=existing/);
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

  it('replaces an existing pending value in place and accepts a missing final newline', async () => {
    const fx = producerFixture(['export MY_PENDING="stale-pending-value-ffffffffffffffff"']);
    const result = await run(['stage', '--producer-env', fx.env, '--pending-key', 'MY_PENDING'], { stdin: STAGED });
    assert.equal(result.code, 0, result.stderr);
    const text = fs.readFileSync(fx.env, 'utf8');
    assert.ok(text.includes('export MY_PENDING="' + STAGED + '"\n'));
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

  it('keeps the quoting style of a quoted active line', async () => {
    const dir = tmpdir();
    const env = path.join(dir, 'producer.env');
    writeEnv(env, [
      "export HEIMDALL_FLEET_TOKEN='" + OLD_ACTIVE + "'",
      'HEIMDALL_PRODUCER_TOKEN_PENDING="' + STAGED + '"',
      '',
    ]);
    const result = await run(['cutover', '--producer-env', env, '--active-key', 'HEIMDALL_FLEET_TOKEN']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(env, 'utf8'), "export HEIMDALL_FLEET_TOKEN='" + STAGED + "'\n");
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
