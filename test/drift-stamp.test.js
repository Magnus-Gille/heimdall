'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDeployedCommitStamp, parseSystemdTimestamp, isSafeUnitName } = require('../src/drift');

// #97 (Codex review): systemctl show emits localized timestamps ("... CEST")
// that Node's Date can't parse, which nulled lastRun/nextRun and made every
// timer render "Config". drift now forces TZ=UTC on the systemctl calls; this
// helper is the parser it feeds.
describe('parseSystemdTimestamp', () => {
  it('parses a UTC-suffixed systemd timestamp to ISO', () => {
    assert.equal(parseSystemdTimestamp('Thu 2026-07-02 01:00:00 UTC'), '2026-07-02T01:00:00.000Z');
  });
  it('returns null for a localized abbreviation Node cannot parse (documents why TZ=UTC)', () => {
    assert.equal(parseSystemdTimestamp('Thu 2026-07-02 03:00:00 CEST'), null);
  });
  it('returns null for n/a, zero, and empty values', () => {
    assert.equal(parseSystemdTimestamp('n/a'), null);
    assert.equal(parseSystemdTimestamp('0'), null);
    assert.equal(parseSystemdTimestamp(''), null);
    assert.equal(parseSystemdTimestamp(null), null);
  });
});

// #97 (Codex review): unit names are interpolated into systemctl shell commands.
describe('isSafeUnitName', () => {
  it('accepts real systemd unit names', () => {
    for (const n of ['skuld', 'brokkr-maintenance-os', 'grimnir-security-scan', 'foo@bar', 'a.b_c']) {
      assert.equal(isSafeUnitName(n), true, n);
    }
  });
  it('rejects names with shell metacharacters or spaces', () => {
    for (const n of ['a; rm -rf /', 'a$(id)', 'a b', 'a|b', 'a`b`', '../x', '', null, 42]) {
      assert.equal(isSafeUnitName(n), false, String(n));
    }
  });
});

// getDeployedCommitStamp reads <deploy_path>/.deployed-commit — the authoritative
// deployed commit written by grimnir's deploy.sh. It replaces the unreliable
// /health-commit and stale-.git heuristics that produced false drift warnings.
describe('getDeployedCommitStamp', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-stamp-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeStamp(content) {
    fs.writeFileSync(path.join(dir, '.deployed-commit'), content);
  }

  it('returns the short hash from a local deploy_path stamp', () => {
    writeStamp('132a7c52ea569cd1b5bfed60eedc650c4f1557bc\n');
    assert.equal(getDeployedCommitStamp({ deploy_path: dir }), '132a7c5');
  });

  it('trims whitespace and takes the first token', () => {
    writeStamp('  93d64d0abc  deployed 2026-06-13\n');
    assert.equal(getDeployedCommitStamp({ deploy_path: dir }), '93d64d0');
  });

  it('tolerates a trailing slash on deploy_path', () => {
    writeStamp('abcdef1234567\n');
    assert.equal(getDeployedCommitStamp({ deploy_path: dir + '/' }), 'abcdef1');
  });

  it('returns null when no stamp file exists', () => {
    assert.equal(getDeployedCommitStamp({ deploy_path: dir }), null);
  });

  it('returns null for non-hex stamp content', () => {
    writeStamp('not-a-commit\n');
    assert.equal(getDeployedCommitStamp({ deploy_path: dir }), null);
  });

  it('returns null when deploy_path is absent', () => {
    assert.equal(getDeployedCommitStamp({}), null);
  });

  it('rejects deploy_path containing shell metacharacters', () => {
    // Guard against injection — must not execute or read anything.
    assert.equal(getDeployedCommitStamp({ deploy_path: '/tmp/x; rm -rf /' }), null);
    assert.equal(getDeployedCommitStamp({ deploy_path: '/tmp/$(whoami)' }), null);
    assert.equal(getDeployedCommitStamp({ deploy_path: '/tmp/`id`' }), null);
  });
});
