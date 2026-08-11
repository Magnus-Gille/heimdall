'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  openDatabase,
  getFleetHosts,
  getLatestFleetMetric,
  reconcileFleetHostConfig,
} = require('../src/db');
const { handlePush } = require('../src/fleet/ingest');
const {
  deriveDisplayState,
  shouldAlert,
} = require('../src/fleet/liveness');
const { buildMachines, aggregateMachineCounts } = require('../src/fleet/render');
const { buildOverviewStatus } = require('../src/render/overview');

const NOW = Date.parse('2026-06-23T12:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-membership-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('fleet membership lifecycle (#56)', () => {
  it('keeps config as membership authority while retaining observed history', () => {
    const db = tmpDb();
    handlePush(db, {
      body: { hostname: 'old-pi', cpu_pct: 31 },
      allowInsecureLoopback: true,
      now: NOW,
    });

    reconcileFleetHostConfig(db, [
      { hostname: 'control-node', label: 'Control node', always_on: true },
    ], { 'old-pi': 'control-node' }, NOW + 1000);

    const rows = getFleetHosts(db);
    const old = rows.find((row) => row.hostname === 'old-pi');
    const canonical = rows.find((row) => row.hostname === 'control-node');
    assert.equal(old.membership_state, 'retired');
    assert.equal(old.alias_of, 'control-node');
    assert.equal(canonical.membership_state, 'configured');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_metrics').get().n, 1,
      'retiring an identity must not delete metric history');
    assert.equal(getLatestFleetMetric(db, 'control-node').cpu_pct, 31,
      'canonical cards should read telemetry sent under the aliased identity');

    const machines = buildMachines(db, NOW + 1000, {});
    const active = machines.filter((machine) => machine.active !== false);
    assert.deepEqual(active.map((machine) => machine.hostname), ['control-node']);
    assert.equal(buildOverviewStatus({ machines }).fleetTotal, 1,
      'retired alias rows must not inflate fleetTotal');
    db.close();
  });

  it('does not admit a newly observed unregistered hostname into live membership', () => {
    const db = tmpDb();
    handlePush(db, {
      body: { hostname: 'ghost', cpu_pct: 10 },
      allowInsecureLoopback: true,
      configuredHostnames: ['control-node'],
      aliases: {},
      now: NOW,
    });
    const ghost = getFleetHosts(db).find((row) => row.hostname === 'ghost');
    assert.equal(ghost.membership_state, 'retired');
    assert.equal(buildOverviewStatus({ machines: buildMachines(db, NOW, {}) }).fleetTotal, 0);
    db.close();
  });

  it('renders configured never-seen hosts, including the alertable always-on distinction', () => {
    const db = tmpDb();
    reconcileFleetHostConfig(db, [
      { hostname: 'pi', label: 'Pi', always_on: true },
      { hostname: 'laptop', label: 'Laptop', always_on: false },
    ], {}, NOW);
    const byHost = Object.fromEntries(buildMachines(db, NOW, {}).map((machine) => [machine.hostname, machine]));

    assert.equal(byHost.pi.state, 'never-seen');
    assert.equal(byHost.laptop.state, 'never-seen');
    assert.equal(shouldAlert(byHost.pi.state, { always_on: 1 }), true);
    assert.equal(shouldAlert(byHost.laptop.state, { always_on: 0 }), false);
    assert.deepEqual(aggregateMachineCounts(Object.values(byHost)), { ok: 0, warn: 0, crit: 1, stale: 1 });
    db.close();
  });

  it('keeps the threshold states and sleeping non-actionable', () => {
    const cfg = { staleAfterS: 90, offlineAfterS: 600, sleepAfterS: 1800 };
    assert.equal(deriveDisplayState({ last_seen: ago(30), always_on: true }, NOW, cfg), 'online');
    assert.equal(deriveDisplayState({ last_seen: ago(120), always_on: true }, NOW, cfg), 'stale');
    assert.equal(deriveDisplayState({ last_seen: ago(900), always_on: true }, NOW, cfg), 'offline');
    assert.equal(deriveDisplayState({ last_seen: ago(900), always_on: false }, NOW, cfg), 'stale');
    assert.equal(deriveDisplayState({ last_seen: ago(1900), always_on: false }, NOW, cfg), 'sleeping');
    assert.equal(shouldAlert('offline', { always_on: true }), true);
    assert.equal(shouldAlert('sleeping', { always_on: false }), false);
    assert.equal(deriveDisplayState({ membership_state: 'retired', last_seen: ago(10) }, NOW, cfg), 'retired-unregistered');
  });
});
