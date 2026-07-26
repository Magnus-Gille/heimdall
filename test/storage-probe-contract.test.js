'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('storage probe contract', () => {
  it('retires the obsolete forced-command deployment scripts', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'nas-collect.sh')), false);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'deploy-nas-probe.sh')), false);
  });

  it('keeps M5 out of the NAS SSH collector contract', () => {
    const collector = fs.readFileSync(path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
    assert.doesNotMatch(collector, /m5.*SSH|SSH.*m5/i);
  });

  it('requires an explicit storage key instead of reviving a home-directory fallback', () => {
    const collector = fs.readFileSync(path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
    assert.match(collector, /const SSH_KEY = process\.env\.HEIMDALL_STORAGE_SSH_KEY;/);
    assert.doesNotMatch(collector, /\.ssh.*heimdall_ed25519/);
  });
});
