'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectRemoteViaSSH, buildStorageSshArgs } = require('../src/metrics');

describe('storage SSH probe identity', () => {
  it('fails visibly before SSH when the dedicated key is absent', () => {
    assert.throws(
      () => collectRemoteViaSSH('/definitely/missing/heimdall-key', 'nas.example.test'),
      /Storage SSH probe credential is unavailable/
    );
  });

  it('treats an unreadable dedicated key as unavailable', () => {
    const original = fs.accessSync;
    fs.accessSync = () => { throw new Error('EACCES'); };
    try {
      assert.throws(
        () => collectRemoteViaSSH('/present-but-unreadable/key', 'nas.example.test'),
        /Storage SSH probe credential is unavailable/
      );
    } finally {
      fs.accessSync = original;
    }
  });

  it('uses argv-safe SSH arguments and never agent or personal fallback', () => {
    const tempKey = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-key-')), 'key');
    fs.writeFileSync(tempKey, 'test');
    const args = buildStorageSshArgs(tempKey, 'nas.example.test', 'probe', '/tmp/known_hosts');
    assert.deepEqual(args.slice(0, 12), [
      '-i', tempKey,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=/tmp/known_hosts',
    ]);
    assert.equal(args.at(-2), 'probe@nas.example.test');
    assert.equal(typeof args.at(-1), 'string');
  });
});
