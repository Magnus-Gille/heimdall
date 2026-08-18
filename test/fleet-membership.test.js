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
const { loadFleetConfig } = require('../src/fleet/config');
const {
  deriveDisplayState,
  shouldAlert,
} = require('../src/fleet/liveness');
const {
  buildMachines,
  fleetGridFragment,
  aggregateMachineCounts,
  isFleetException,
} = require('../src/fleet/render');
const { buildOverviewStatus } = require('../src/render/overview');

const NOW = Date.parse('2026-06-23T12:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-membership-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('fleet membership lifecycle (#56)', () => {
  it('derives fleet identity, labels, aliases, and monitor policy from Grimnir nodes (#61)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-registry-projection-'));
    const overlayPath = path.join(dir, 'overlay.json');
    const registryPath = path.join(dir, 'services.json');
    fs.writeFileSync(overlayPath, JSON.stringify({
      fleet: {
        stale_after_s: 42,
        hosts: [{ hostname: 'edge-node', label: 'stale duplicate', always_on: true }],
        host_aliases: {
          'orin-nano': 'orin',
          'huginmunin': 'control-node',
          ghost: 'not-a-node',
        },
      },
    }));
    fs.writeFileSync(registryPath, JSON.stringify({
      components: [
        { name: 'heimdall', target_node_id: 'node-huginmunin', host: 'huginmunin.local' },
      ],
      nodes: [
        { name: 'huginmunin', node_id: 'node-huginmunin', hostname: 'huginmunin.local', role: 'service-host', status: 'active', monitor: true },
        { name: 'nas', node_id: 'node-nas', hostname: 'nas.local', role: 'storage', status: 'active', monitor: true },
        { name: 'm5', node_id: 'node-m5', hostname: '100.76.72.59', ssh_alias: 'm5', role: 'inference', status: 'active', monitor: false },
        { name: 'orin', node_id: 'node-orin', hostname: '100.127.176.78', ssh_alias: 'orin', role: 'inference', status: 'active', monitor: false },
        { name: 'laptop', node_id: 'node-laptop', hostname: null, role: 'inference', status: 'active', monitor: false },
        { name: 'munin-zero', node_id: 'node-munin-zero', hostname: 'munin-zero.local', role: 'memory-appliance', status: 'active', monitor: true },
        { name: 'retired-node', node_id: 'node-retired', status: 'retired', monitor: true },
      ],
    }));

    const cfg = loadFleetConfig(overlayPath, { grimnirPath: registryPath });
    assert.equal(cfg.authority.status, 'loaded');
    assert.equal(cfg.authority.source, 'grimnir');
    assert.equal(cfg.thresholds.staleAfterS, 42);
    assert.deepEqual(cfg.hosts.map((host) => host.hostname), [
      'huginmunin', 'nas', 'm5', 'orin', 'laptop', 'munin-zero',
    ]);
    assert.ok(!cfg.hosts.some((host) => host.hostname === 'edge-node'));
    assert.ok(!cfg.hosts.some((host) => host.hostname === 'retired-node'));
    assert.deepEqual(
      Object.fromEntries(cfg.hosts.map((host) => [host.hostname, host.always_on])),
      { huginmunin: true, nas: true, m5: false, orin: false, laptop: false, 'munin-zero': true },
    );
    assert.equal(cfg.hosts.find((host) => host.hostname === 'orin').role, 'inference');
    assert.equal(cfg.hostAliases['control-node'], 'huginmunin',
      'local collector identity follows Grimnir workload placement');
    assert.equal(cfg.hostAliases['orin-nano'], 'orin');
    assert.equal(cfg.hostAliases['100.127.176.78'], 'orin');
    assert.equal(cfg.hostAliases['node-orin'], 'orin');
    assert.equal(cfg.hostAliases.huginmunin, undefined, 'overlay cannot remap a canonical registry node');
    assert.equal(cfg.hostAliases.ghost, undefined, 'overlay alias targets must resolve to a registry node');
  });

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

  it('does not retire pushes while the Grimnir node authority is unavailable, malformed, or node-less', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-authority-'));
    const missing = path.join(dir, 'missing.json');
    const malformed = path.join(dir, 'malformed.json');
    const nodesMissing = path.join(dir, 'nodes-missing.json');
    const overlay = path.join(dir, 'overlay.json');
    fs.writeFileSync(malformed, '{not-json');
    fs.writeFileSync(nodesMissing, JSON.stringify({ components: [] }));
    fs.writeFileSync(overlay, JSON.stringify({ fleet: { stale_after_s: 45 } }));

    const cases = [
      [missing, 'unavailable'],
      [malformed, 'malformed'],
      [nodesMissing, 'nodes-missing'],
    ];
    const db = tmpDb();
    for (const [registryPath, status] of cases) {
      const cfg = loadFleetConfig(overlay, { grimnirPath: registryPath });
      assert.equal(cfg.authority.status, status);
      const hostname = `authority-${status.replace('-', '')}`;
      const result = handlePush(db, {
        body: { hostname, cpu_pct: 10 },
        allowInsecureLoopback: true,
        now: NOW,
        // Failed authority states deliberately omit configuredHostnames. An
        // empty array would mean an intentionally empty, valid fleet.
      });
      assert.equal(result.status, 200);
      assert.equal(getFleetHosts(db).find((row) => row.hostname === hostname).membership_state, 'observed');
    }
    db.close();
  });

  it('treats a successfully loaded empty Grimnir node projection as intentionally authoritative', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-empty-fleet-'));
    const configPath = path.join(dir, 'overlay.json');
    const registryPath = path.join(dir, 'services.json');
    fs.writeFileSync(configPath, JSON.stringify({ fleet: {} }));
    fs.writeFileSync(registryPath, JSON.stringify({ components: [], nodes: [] }));
    const cfg = loadFleetConfig(configPath, { grimnirPath: registryPath });
    assert.equal(cfg.authority.status, 'loaded');
    assert.equal(cfg.authority.intentionallyEmpty, true);

    const db = tmpDb();
    handlePush(db, { body: { hostname: 'retained' }, allowInsecureLoopback: true, now: NOW });
    reconcileFleetHostConfig(db, cfg.hosts, cfg.hostAliases, NOW + 1000);
    assert.equal(getFleetHosts(db).find((row) => row.hostname === 'retained').membership_state, 'retired');
    handlePush(db, {
      body: { hostname: 'new-host' },
      configuredHostnames: [],
      aliases: {},
      allowInsecureLoopback: true,
      now: NOW + 2000,
    });
    assert.equal(getFleetHosts(db).find((row) => row.hostname === 'new-host').membership_state, 'retired');

    const html = fleetGridFragment(db, NOW + 2000, {});
    assert.match(html, /retained/);
    assert.match(html, /new-host/);
    assert.match(html, /Retained historical rows are shown below/);
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
    assert.deepEqual(aggregateMachineCounts(Object.values(byHost)), { ok: 0, warn: 0, crit: 1, stale: 0 },
      'the unmonitored laptop remains visible but is excluded from aggregate health');
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

  it('projects reported aliases onto one canonical card and aggregates only monitored nodes (#61)', () => {
    const db = tmpDb();
    const hosts = [
      { hostname: 'huginmunin', label: 'Huginmunin', role: 'service-host', always_on: true },
      { hostname: 'orin', label: 'Orin', role: 'inference', always_on: false },
      { hostname: 'm5', label: 'M5', role: 'inference', always_on: false },
      { hostname: 'munin-zero', label: 'Munin Zero', role: 'memory-appliance', always_on: true },
    ];
    const aliases = { 'control-node': 'huginmunin', 'orin-nano': 'orin' };
    reconcileFleetHostConfig(db, hosts, aliases, NOW);

    handlePush(db, {
      body: { hostname: 'control-node', cpu_pct: 12, agent_version: 'abc1234' },
      configuredHostnames: hosts.map((host) => host.hostname),
      aliases,
      allowInsecureLoopback: true,
      now: NOW + 1000,
    });
    handlePush(db, {
      body: { hostname: 'orin-nano', cpu_pct: 34, agent_version: 'old0000' },
      configuredHostnames: hosts.map((host) => host.hostname),
      aliases,
      allowInsecureLoopback: true,
      now: NOW + 2000,
    });

    const machines = buildMachines(db, NOW + 3000, {}, { baselineVersion: 'abc1234' });
    const active = machines.filter((machine) => machine.active !== false);
    const byHost = Object.fromEntries(active.map((machine) => [machine.hostname, machine]));

    assert.deepEqual(active.map((machine) => machine.hostname).sort(), ['huginmunin', 'm5', 'munin-zero', 'orin']);
    assert.equal(byHost.huginmunin.cpu_pct, 12);
    assert.equal(byHost.huginmunin.reportedHostname, 'control-node');
    assert.equal(byHost.orin.cpu_pct, 34);
    assert.equal(byHost.orin.reportedHostname, 'orin-nano');
    assert.equal(byHost.orin.monitored, false);
    assert.equal(byHost['munin-zero'].monitored, true);
    assert.equal(byHost['munin-zero'].state, 'never-seen');
    assert.equal(isFleetException(byHost.orin), false, 'unmonitored drift/telemetry state is informational');

    assert.deepEqual(aggregateMachineCounts(machines), { ok: 1, warn: 0, crit: 1, stale: 0 });
    const status = buildOverviewStatus({ machines });
    assert.equal(status.fleetOnline, 1);
    assert.equal(status.fleetTotal, 2, 'overview denominator is the monitored registry projection');
    assert.equal(status.fleetOffline, 1, 'monitored munin-zero remains an explicit evidence gap');
    assert.equal(status.fleetDrift, 0, 'unmonitored Orin version drift does not trigger attention');
    assert.equal(status.allHealthy, false);

    const exceptions = fleetGridFragment(db, NOW + 3000, {}, {
      exceptionsOnly: true,
      baselineVersion: 'abc1234',
    });
    assert.match(exceptions, /Munin Zero/);
    assert.doesNotMatch(exceptions, /Orin/);

    const full = fleetGridFragment(db, NOW + 3000, {}, { baselineVersion: 'abc1234' });
    assert.match(full, /agent reports as <span class="mono">control-node/);
    assert.match(full, /agent reports as <span class="mono">orin-nano/);
    assert.doesNotMatch(full, /machine-name">control-node</);
    assert.doesNotMatch(full, /machine-name">orin-nano</);
    db.close();
  });
});
