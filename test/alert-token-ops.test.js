'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'alert-token-ops.py');
const OLD_TOKEN = 'old-token-must-never-appear-in-output';

function writePrivateEnv(file, lines) {
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function tokenFrom(file) {
  const line = fs.readFileSync(file, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith('HEIMDALL_ALERT_TOKEN='));
  return line ? line.slice('HEIMDALL_ALERT_TOKEN='.length) : null;
}

function setupFixture({ serverToken = OLD_TOKEN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-alert-token-'));
  const heimdallEnv = path.join(dir, 'heimdall.env');
  const consumerEnv = path.join(dir, 'ratatoskr.env');
  const heimdallDropIn = path.join(dir, 'alert-token.conf');
  const systemctlLog = path.join(dir, 'systemctl.log');
  const systemctl = path.join(dir, 'systemctl');
  const journalctl = path.join(dir, 'journalctl');
  const httpProbe = path.join(dir, 'http-probe');
  const httpProbeLog = path.join(dir, 'http-probe.jsonl');
  const healthCounter = path.join(dir, 'health-counter');
  const interruptMarker = path.join(dir, 'interrupt.marker');

  const heimdallLines = ['HEIMDALL_BIND=127.0.0.1'];
  if (serverToken != null) heimdallLines.push(`HEIMDALL_ALERT_TOKEN=${serverToken}`);
  writePrivateEnv(heimdallEnv, heimdallLines);
  writePrivateEnv(consumerEnv, [
    'HEIMDALL_INGEST_URL=http://127.0.0.1/ignored',
    `HEIMDALL_ALERT_TOKEN=${OLD_TOKEN}`,
  ]);
  fs.writeFileSync(heimdallDropIn,
    `[Service]\nEnvironment="HEIMDALL_ALERT_TOKEN=${OLD_TOKEN}"\n`,
    { mode: 0o644 });
  fs.writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" = "show" ]; then
  printf 'MainPID=123\\nActiveState=active\\nSubState=running\\n'
fi
if [ "\${INTERRUPT_ON_RESTART:-}" = "1" ] &&
   [ "$1" = "restart" ] &&
   [ "$2" = "heimdall.service" ] &&
   [ ! -e "$INTERRUPT_MARKER" ]; then
  : > "$INTERRUPT_MARKER"
  kill -TERM "$PPID"
fi
exit 0
`, { mode: 0o700 });
  fs.writeFileSync(journalctl, `#!/bin/sh
printf '%s\\n' 'Heimdall ingest returned 401'
printf '%s\\n' 'unrelated line that must be ignored'
`, { mode: 0o700 });
  fs.writeFileSync(httpProbe, `#!/usr/bin/env python3
import json
import os
import sys
request = json.load(sys.stdin)
kind = request.get("kind", "alert")
with open(os.environ["HTTP_PROBE_LOG"], "a", encoding="utf-8") as handle:
    row = {"kind": kind}
    if kind == "alert":
        row.update({
            "token": request["token"],
            "state": request["body"]["state"],
            "dedup_key": request["body"]["dedup_key"],
        })
    handle.write(json.dumps(row) + "\\n")
if kind == "health":
    counter_path = os.environ["HEALTH_COUNTER"]
    try:
        count = int(open(counter_path, encoding="utf-8").read())
    except (FileNotFoundError, ValueError):
        count = 0
    count += 1
    with open(counter_path, "w", encoding="utf-8") as handle:
        handle.write(str(count))
    failures = int(os.environ.get("HEALTH_FAILURES_BEFORE_READY", "0"))
    print(503 if count <= failures else 200)
elif request["token"] == os.environ["OLD_TOKEN"]:
    print(401)
elif os.environ.get("REJECT_REPLACEMENT") == "1":
    print(500)
else:
    print(200)
`, { mode: 0o700 });

  return {
    dir, heimdallEnv, consumerEnv, heimdallDropIn,
    systemctlLog, systemctl, journalctl,
    httpProbe, httpProbeLog, healthCounter, interruptMarker,
  };
}

describe('secret-safe alert-token operations', () => {
  it('reports only allowlisted presence and fails unhealthy on an inline token', async () => {
    const fixture = setupFixture();
    const result = await runScript([
      'diagnose',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      SYSTEMCTL_LOG: fixture.systemctlLog,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /heimdall_token=present/);
    assert.match(result.stdout, /consumer_token=present/);
    assert.match(result.stdout, /consumer_url=present/);
    assert.match(result.stdout, /inline_token=present/);
    assert.match(result.stdout, /dropin_env_file=missing/);
    assert.match(result.stdout, /tokens_match=yes/);
    assert.match(result.stdout, /recent_auth_failures=1/);
    assert.ok(!result.stdout.includes(OLD_TOKEN));
    assert.ok(!result.stderr.includes(OLD_TOKEN));
  });

  it('reports healthy only after the drop-in uses the private environment file', async () => {
    const fixture = setupFixture();
    fs.writeFileSync(fixture.heimdallDropIn,
      `[Service]\nEnvironmentFile=${fixture.heimdallEnv}\n`,
      { mode: 0o644 });
    const result = await runScript([
      'diagnose',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      SYSTEMCTL_LOG: fixture.systemctlLog,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /inline_token=absent/);
    assert.match(result.stdout, /dropin_env_file=present/);
    assert.match(result.stdout, /tokens_match=yes/);
    assert.ok(!result.stdout.includes(OLD_TOKEN));
    assert.ok(!result.stderr.includes(OLD_TOKEN));
  });

  it('rotates both private files, proves replacement auth, rejects old auth, and resolves the probe', async () => {
    const fixture = setupFixture({ serverToken: null });
    const result = await runScript([
      'rotate',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
      '--ingest-url', 'http://127.0.0.1:3033/api/alerts',
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      HEIMDALL_ALERT_HTTP_PROBE_BIN: fixture.httpProbe,
      SYSTEMCTL_LOG: fixture.systemctlLog,
      HTTP_PROBE_LOG: fixture.httpProbeLog,
      HEALTH_COUNTER: fixture.healthCounter,
      OLD_TOKEN,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /replacement_auth=accepted/);
    assert.match(result.stdout, /previous_auth=rejected/);
    assert.match(result.stdout, /probe_alert=resolved/);
    assert.ok(!result.stdout.includes(OLD_TOKEN));
    assert.ok(!result.stderr.includes(OLD_TOKEN));

    const replacement = tokenFrom(fixture.heimdallEnv);
    assert.ok(replacement);
    assert.notEqual(replacement, OLD_TOKEN);
    assert.equal(tokenFrom(fixture.consumerEnv), replacement);
    const dropIn = fs.readFileSync(fixture.heimdallDropIn, 'utf8');
    assert.equal(dropIn,
      `[Service]\nEnvironmentFile=${fixture.heimdallEnv}\n`);
    assert.ok(!dropIn.includes(OLD_TOKEN));
    assert.ok(!dropIn.includes(replacement));
    const requests = fs.readFileSync(fixture.httpProbeLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const alertRequests = requests.filter(({ kind }) => kind === 'alert');
    assert.equal(requests[0].kind, 'health');
    assert.deepEqual(alertRequests.map(({ state }) => state), ['firing', 'firing', 'resolved']);
    assert.equal(alertRequests[0].token, replacement);
    assert.equal(alertRequests[1].token, OLD_TOKEN);
    assert.equal(alertRequests[2].token, replacement);
    assert.match(
      fs.readFileSync(fixture.systemctlLog, 'utf8'),
      /stop ratatoskr\.service[\s\S]*daemon-reload[\s\S]*restart heimdall\.service[\s\S]*restart ratatoskr\.service/
    );
  });

  it('restores both old files and services if replacement validation fails', async () => {
    const fixture = setupFixture();
    const result = await runScript([
      'rotate',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
      '--ingest-url', 'http://127.0.0.1:3033/api/alerts',
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      HEIMDALL_ALERT_HTTP_PROBE_BIN: fixture.httpProbe,
      SYSTEMCTL_LOG: fixture.systemctlLog,
      HTTP_PROBE_LOG: fixture.httpProbeLog,
      HEALTH_COUNTER: fixture.healthCounter,
      OLD_TOKEN,
      REJECT_REPLACEMENT: '1',
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /rotation_failed=rolled_back/);
    assert.ok(!result.stdout.includes(OLD_TOKEN));
    assert.ok(!result.stderr.includes(OLD_TOKEN));
    assert.equal(tokenFrom(fixture.heimdallEnv), OLD_TOKEN);
    assert.equal(tokenFrom(fixture.consumerEnv), OLD_TOKEN);
    assert.match(fs.readFileSync(fixture.heimdallDropIn, 'utf8'),
      /Environment="HEIMDALL_ALERT_TOKEN=/);
  });

  it('rolls back both files and services when SIGTERM interrupts rotation', async () => {
    const fixture = setupFixture();
    const result = await runScript([
      'rotate',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
      '--ingest-url', 'http://127.0.0.1:3033/api/alerts',
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      HEIMDALL_ALERT_HTTP_PROBE_BIN: fixture.httpProbe,
      SYSTEMCTL_LOG: fixture.systemctlLog,
      HTTP_PROBE_LOG: fixture.httpProbeLog,
      HEALTH_COUNTER: fixture.healthCounter,
      OLD_TOKEN,
      INTERRUPT_ON_RESTART: '1',
      INTERRUPT_MARKER: fixture.interruptMarker,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /rotation_failed=rolled_back/);
    assert.ok(!result.stdout.includes(OLD_TOKEN));
    assert.ok(!result.stderr.includes(OLD_TOKEN));
    assert.equal(tokenFrom(fixture.heimdallEnv), OLD_TOKEN);
    assert.equal(tokenFrom(fixture.consumerEnv), OLD_TOKEN);
    assert.match(fs.readFileSync(fixture.heimdallDropIn, 'utf8'),
      /Environment="HEIMDALL_ALERT_TOKEN=/);
    assert.match(
      fs.readFileSync(fixture.systemctlLog, 'utf8'),
      /stop ratatoskr\.service[\s\S]*restart heimdall\.service[\s\S]*restart heimdall\.service[\s\S]*restart ratatoskr\.service/
    );
  });

  it('waits through transient HTTP health failures before probing auth', async () => {
    const fixture = setupFixture();
    const result = await runScript([
      'rotate',
      '--heimdall-env', fixture.heimdallEnv,
      '--consumer-env', fixture.consumerEnv,
      '--heimdall-drop-in', fixture.heimdallDropIn,
      '--ingest-url', 'http://127.0.0.1:3033/api/alerts',
      '--health-url', 'http://127.0.0.1:3033/api/health',
    ], {
      HEIMDALL_ALERT_SYSTEMCTL_BIN: fixture.systemctl,
      HEIMDALL_ALERT_JOURNALCTL_BIN: fixture.journalctl,
      HEIMDALL_ALERT_HTTP_PROBE_BIN: fixture.httpProbe,
      SYSTEMCTL_LOG: fixture.systemctlLog,
      HTTP_PROBE_LOG: fixture.httpProbeLog,
      HEALTH_COUNTER: fixture.healthCounter,
      HEALTH_FAILURES_BEFORE_READY: '2',
      OLD_TOKEN,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /heimdall_ready=yes/);
    const requests = fs.readFileSync(fixture.httpProbeLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(requests.slice(0, 3).map(({ kind }) => kind),
      ['health', 'health', 'health']);
    assert.equal(requests[3].kind, 'alert');
  });

  it('keeps broad environment-dump commands out of operational scripts', () => {
    const scriptsDir = path.join(__dirname, '..', 'scripts');
    const scripts = fs.readdirSync(scriptsDir)
      .map((name) => path.join(scriptsDir, name))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const forbidden = [
      /systemctl\s+show-environment/,
      /systemctl\s+show\b[^\n]*\bEnvironment=/,
      /\/proc\/[^\s]+\/environ/,
      /\bprintenv\b/,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(scripts, pattern);
    }
  });
});
