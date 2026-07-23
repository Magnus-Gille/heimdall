'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SYSTEMD_DIR = path.join(__dirname, '..', 'systemd');
const DECLARED_NODE_UNITS = [
  'heimdall.service',
  'heimdall-collect.service',
  'heimdall-maintain.service',
  'heimdall-boot-check.service',
];
const RUNTIME = {
  user: 'observer',
  home: '/srv/observer',
  deployPath: '/opt/grimnir/heimdall-release',
};

function sourceFor(unit) {
  return fs.readFileSync(path.join(SYSTEMD_DIR, unit), 'utf8');
}

function activeLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'));
}

function render(source) {
  return source
    .replaceAll('<user>', RUNTIME.user)
    .replaceAll('<home>', RUNTIME.home)
    .replaceAll('<deploy-path>', RUNTIME.deployPath)
    .replaceAll('<install-dir>', path.posix.basename(RUNTIME.deployPath));
}

test('declared Node units use only bounded placeholders for runtime-owned host facts', () => {
  for (const unit of DECLARED_NODE_UNITS) {
    const lines = activeLines(sourceFor(unit));

    assert.ok(lines.includes('User=<user>'), `${unit} must use <user>`);
    assert.ok(
      lines.includes('WorkingDirectory=<deploy-path>'),
      `${unit} must use <deploy-path> as its working directory`
    );
    assert.ok(
      lines.includes('Environment=DB_PATH=<home>/.heimdall/heimdall.db'),
      `${unit} must derive its database path from <home>`
    );
    assert.ok(
      lines.includes('EnvironmentFile=<home>/.heimdall/env'),
      `${unit} must require the registered private environment file`
    );
    assert.ok(
      lines.includes('ReadWritePaths=<home>/.heimdall'),
      `${unit} must derive its writable state path from <home>`
    );
    assert.equal(
      lines.some((line) => line.includes('User=heimdall') || line.includes('/home/heimdall')),
      false,
      `${unit} must not reintroduce the clean-install identity or home`
    );
  }
});

test('declared Node units render for a non-default runtime without touching system paths', () => {
  for (const unit of DECLARED_NODE_UNITS) {
    const rendered = render(sourceFor(unit));
    const lines = activeLines(rendered);

    assert.ok(lines.includes(`User=${RUNTIME.user}`), `${unit} renders runtime user`);
    assert.ok(
      lines.includes(`WorkingDirectory=${RUNTIME.deployPath}`),
      `${unit} renders deploy target`
    );
    assert.ok(
      lines.includes(`Environment=DB_PATH=${RUNTIME.home}/.heimdall/heimdall.db`),
      `${unit} renders database path`
    );
    assert.ok(
      lines.includes(`EnvironmentFile=${RUNTIME.home}/.heimdall/env`),
      `${unit} renders required environment file`
    );
    assert.ok(
      lines.includes('ExecStart=/usr/bin/node ' + {
        'heimdall.service': 'src/server.js',
        'heimdall-collect.service': 'src/collector.js',
        'heimdall-maintain.service': 'src/maintain.js',
        'heimdall-boot-check.service': 'src/boot-check.js',
      }[unit]),
      `${unit} preserves the genuine /usr/bin/node system path`
    );
    assert.doesNotMatch(
      rendered,
      /<(?:user|home|deploy-path|install-dir)>/,
      `${unit} must not leave supported placeholders unresolved`
    );
  }
});

test('server pre-start and external read-only dependencies render through bounded roots', () => {
  const serverLines = activeLines(render(sourceFor('heimdall.service')));
  const collectorLines = activeLines(render(sourceFor('heimdall-collect.service')));

  assert.ok(
    serverLines.includes(
      `ExecStartPre=-${RUNTIME.deployPath}/scripts/clear-heimdall-port.sh`
    )
  );
  assert.ok(
    serverLines.includes(
      `ReadOnlyPaths=${RUNTIME.deployPath} ${RUNTIME.home}/.munin-memory`
    )
  );
  assert.ok(
    collectorLines.includes(
      `ReadOnlyPaths=${RUNTIME.deployPath} ${RUNTIME.home}/.munin-memory ` +
        `${RUNTIME.home}/.ssh/heimdall_ed25519`
    )
  );
});
