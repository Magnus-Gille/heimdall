'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase } = require('../src/db');
const { STATES, getState, getStaleLevel, recordState, ensureNASStateTable } = require('../src/nas-state');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('STATES', () => {
  it('defines expected states', () => {
    assert.strictEqual(STATES.UNKNOWN, 'unknown');
    assert.strictEqual(STATES.HEALTHY, 'healthy');
    assert.strictEqual(STATES.UNREACHABLE, 'unreachable');
    assert.strictEqual(STATES.SSH_BROKEN, 'ssh_broken');
    assert.strictEqual(STATES.DEGRADED, 'degraded');
  });
});

describe('getStaleLevel', () => {
  it('returns "red" for null lastSuccess', () => {
    assert.strictEqual(getStaleLevel(null), 'red');
  });

  it('returns "red" for >1h ago', () => {
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    assert.strictEqual(getStaleLevel(old), 'red');
  });

  it('returns "amber" for >15m but <1h', () => {
    const ts = new Date(Date.now() - 30 * 60000).toISOString();
    assert.strictEqual(getStaleLevel(ts), 'amber');
  });

  it('returns null for fresh (<15m)', () => {
    const ts = new Date(Date.now() - 5 * 60000).toISOString();
    assert.strictEqual(getStaleLevel(ts), null);
  });
});

describe('NAS state machine', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('default state is unknown until the SSH collector proves it healthy', () => {
    const state = getState(db);
    assert.strictEqual(state.state, 'unknown');
    db.close();
  });

  it('recordState transitions to unreachable', () => {
    recordState(db, STATES.UNREACHABLE, 'ping timeout');
    const state = getState(db);
    assert.strictEqual(state.state, 'unreachable');
    assert.strictEqual(state.detail, 'ping timeout');
    db.close();
  });

  it('recordState healthy updates last_success', () => {
    recordState(db, STATES.HEALTHY, null);
    const state = getState(db);
    assert.strictEqual(state.state, 'healthy');
    assert.ok(state.lastSuccess);
    db.close();
  });

  it('recordState non-healthy does NOT update last_success', () => {
    recordState(db, STATES.HEALTHY, null);
    const before = getState(db).lastSuccess;

    recordState(db, STATES.SSH_BROKEN, 'connection refused');
    const after = getState(db);
    assert.strictEqual(after.state, 'ssh_broken');
    assert.strictEqual(after.lastSuccess, before); // unchanged
    db.close();
  });

  it('stale level reflects last_success age', () => {
    // Set last_success to 2 hours ago by direct DB update
    ensureNASStateTable(db);
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    db.prepare('UPDATE nas_state SET last_success = ? WHERE id = 1').run(old);

    const state = getState(db);
    assert.strictEqual(state.stale, 'red');
    db.close();
  });
});
