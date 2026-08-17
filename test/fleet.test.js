'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { deriveState, shouldAlert, aggregateCounts } = require('../src/fleet/liveness');
const { validatePushPayload } = require('../src/fleet/validate');
const { checkFleetAuth } = require('../src/fleet/auth');
const { handlePush } = require('../src/fleet/ingest');
const { loadFleetConfig } = require('../src/fleet/config');
const {
  buildMachines, fleetGridFragment, fleetPage, agentVersionDriftState,
} = require('../src/fleet/render');
const { machineCard } = require('../src/render/components');
const { buildApp } = require('../src/server');
const {
  openDatabase, getLatestFleetMetric, getFleetHosts, getFleetMetricSeries, getMetricHistory,
  normAlwaysOn, upsertFleetHostConfig, pruneFleetMetrics,
} = require('../src/db');

const NOW = Date.parse('2026-06-23T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-fleet-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('liveness.deriveState', () => {
  it('online when last push is recent', () => {
    assert.equal(deriveState({ last_seen: ago(30), always_on: true }, NOW), 'online');
  });
  it('stale between stale and offline thresholds (always-on)', () => {
    assert.equal(deriveState({ last_seen: ago(120), always_on: true }, NOW), 'stale');
  });
  it('offline past threshold when always-on', () => {
    assert.equal(deriveState({ last_seen: ago(900), always_on: true }, NOW), 'offline');
  });
  it('sleeping (not stale->offline) past threshold when NOT always-on', () => {
    assert.equal(deriveState({ last_seen: ago(3600), always_on: false }, NOW), 'sleeping');
  });
  it('laptop is stale (amber, no alert) between 90s and 30m, never offline', () => {
    const s = deriveState({ last_seen: ago(600), always_on: false }, NOW);
    assert.equal(s, 'stale');
    assert.equal(shouldAlert(s), false);
  });
  it('never-seen always-on host is offline; never-seen laptop is sleeping', () => {
    assert.equal(deriveState({ last_seen: null, always_on: true }, NOW), 'offline');
    assert.equal(deriveState({ last_seen: null, always_on: false }, NOW), 'sleeping');
  });
  it('honors always_on stored as 0/1 integers', () => {
    assert.equal(deriveState({ last_seen: ago(900), always_on: 1 }, NOW), 'offline');
    assert.equal(deriveState({ last_seen: ago(3600), always_on: 0 }, NOW), 'sleeping');
  });
  it('respects custom thresholds', () => {
    assert.equal(deriveState({ last_seen: ago(50), always_on: true }, NOW, { staleAfterS: 30 }), 'stale');
  });
  it('only offline raises an alert', () => {
    assert.equal(shouldAlert('offline'), true);
    assert.equal(shouldAlert('stale'), false);
    assert.equal(shouldAlert('sleeping'), false);
    assert.equal(shouldAlert('online'), false);
  });
  it('aggregateCounts maps states to RAG buckets', () => {
    const c = aggregateCounts(['online', 'online', 'stale', 'offline', 'sleeping']);
    assert.deepEqual(c, { ok: 2, warn: 1, crit: 1, stale: 1 });
  });
});

describe('validate.validatePushPayload', () => {
  it('accepts a minimal payload (hostname only)', () => {
    const r = validatePushPayload({ hostname: 'control-node' });
    assert.equal(r.ok, true);
    assert.equal(r.value.hostname, 'control-node');
  });
  it('accepts agent_version as an optional string', () => {
    const r = validatePushPayload({ hostname: 'control-node', agent_version: 'abc1234' });
    assert.equal(r.ok, true);
    assert.equal(r.value.agent_version, 'abc1234');
  });
  it('rejects a malformed agent_version', () => {
    assert.equal(validatePushPayload({ hostname: 'a', agent_version: 123 }).ok, false);
    assert.equal(validatePushPayload({ hostname: 'a', agent_version: { sha: 'abc1234' } }).ok, false);
  });
  it('rejects an empty agent_version after trimming whitespace', () => {
    const r = validatePushPayload({ hostname: 'a', agent_version: '   ' });
    assert.equal(r.ok, false);
  });
  it('rejects an overlong agent_version', () => {
    const r = validatePushPayload({ hostname: 'a', agent_version: 'a'.repeat(65) });
    assert.equal(r.ok, false);
  });
  it('trims surrounding whitespace from agent_version before persistence', () => {
    const r = validatePushPayload({ hostname: 'a', agent_version: '  AbC1234  ' });
    assert.equal(r.ok, true);
    assert.equal(r.value.agent_version, 'AbC1234');
  });
  it('rejects missing/invalid hostname', () => {
    assert.equal(validatePushPayload({}).ok, false);
    assert.equal(validatePushPayload({ hostname: 'bad host!' }).ok, false);
    assert.equal(validatePushPayload({ hostname: 123 }).ok, false);
  });
  it('rejects a non-object body', () => {
    assert.equal(validatePushPayload(null).ok, false);
    assert.equal(validatePushPayload([]).ok, false);
    assert.equal(validatePushPayload('x').ok, false);
  });
  it('rejects non-finite numeric fields', () => {
    assert.equal(validatePushPayload({ hostname: 'a', cpu_pct: 'NaN' }).ok, false);
    assert.equal(validatePushPayload({ hostname: 'a', load_1: Infinity }).ok, false);
  });
  it('clamps percentages to 0..100', () => {
    const r = validatePushPayload({ hostname: 'a', cpu_pct: 142, ram_used_pct: -3 });
    assert.equal(r.value.cpu_pct, 100);
    assert.equal(r.value.ram_used_pct, 0);
  });
  it('normalizes ts to ISO and filters disk entries', () => {
    const r = validatePushPayload({
      hostname: 'a', ts: '2026-06-23T10:00:00+02:00',
      disk: [{ mount: '/', total_mb: 100, used_mb: 10, used_pct: 10 }, { bogus: true }],
    });
    assert.equal(r.ok, true);
    assert.match(r.value.ts, /^2026-06-23T08:00:00/);
    assert.equal(r.value.disk.length, 1);
    assert.equal(r.value.disk[0].mount, '/');
  });
  it('hoists extra.temp_gpu_c to a top-level field', () => {
    const r = validatePushPayload({ hostname: 'a', extra: { temp_gpu_c: 51, gpu_pct: 22 } });
    assert.equal(r.value.temp_gpu_c, 51);
    assert.deepEqual(r.value.extra, { temp_gpu_c: 51, gpu_pct: 22 });
  });

  it('bounds disk count, mount length, and disk percentages', () => {
    const disk = Array.from({ length: 40 }, (_, i) => ({
      mount: `/${'x'.repeat(250)}-${i}`,
      used_pct: 150,
    }));
    const r = validatePushPayload({ hostname: 'a', disk });
    assert.equal(r.ok, true);
    assert.equal(r.value.disk.length, 32);
    assert.equal(r.value.disk[0].mount.length, 200);
    assert.equal(r.value.disk[0].used_pct, 100);
  });

  it('keeps only a bounded shallow scalar extra map', () => {
    const extra = { thermal_state: 'x'.repeat(600), nested: { nope: true }, list: [1], nan: Infinity };
    for (let i = 0; i < 40; i++) extra[`key_${i}`] = i;
    const r = validatePushPayload({ hostname: 'a', extra });
    assert.equal(r.ok, true);
    assert.ok(Object.keys(r.value.extra).length <= 32);
    assert.equal(r.value.extra.thermal_state.length, 500);
    assert.equal(r.value.extra.nested, undefined);
    assert.equal(r.value.extra.list, undefined);
    assert.equal(r.value.extra.nan, undefined);
  });
});

describe('auth.checkFleetAuth', () => {
  it('is fail-closed: no token + no insecure flag → denied even on loopback', () => {
    assert.equal(checkFleetAuth('', '', '127.0.0.1').ok, false);
    assert.equal(checkFleetAuth('', '', '127.0.0.1', false).ok, false);
  });
  it('allows tokenless ONLY with explicit insecure-loopback opt-in on a loopback bind', () => {
    assert.equal(checkFleetAuth('', '', '127.0.0.1', true).ok, true);
    assert.equal(checkFleetAuth('', '', '192.0.2.10', true).ok, false); // not loopback
  });
  it('enforces Bearer when a token is configured (insecure flag irrelevant)', () => {
    assert.equal(checkFleetAuth('Bearer s3cret', 's3cret', '192.0.2.10').ok, true);
    assert.equal(checkFleetAuth('Bearer wrong', 's3cret', '127.0.0.1', true).ok, false);
    assert.equal(checkFleetAuth('', 's3cret', '127.0.0.1', true).ok, false);
  });
});

describe('ingest.handlePush (integration)', () => {
  it('401s on auth failure before touching the DB', () => {
    const db = tmpDb();
    const r = handlePush(db, { authHeader: '', token: 'k', bindHost: '192.0.2.1', body: { hostname: 'a' }, now: NOW });
    assert.equal(r.status, 401);
    assert.equal(getFleetHosts(db).length, 0);
    db.close();
  });
  it('400s on invalid payload (after passing auth)', () => {
    const db = tmpDb();
    const r = handlePush(db, { body: { nope: 1 }, allowInsecureLoopback: true, now: NOW });
    assert.equal(r.status, 400);
    db.close();
  });
  it('persists a valid push: fleet_metrics row, host upsert, metric fan-out, source ip', () => {
    const db = tmpDb();
    const body = {
      hostname: 'control-node', os: 'linux', platform: 'pi5', ts: ago(0),
      agent_version: 'abc1234',
      cpu_pct: 6, ram_used_pct: 28, ram_used_mb: 2300, ram_total_mb: 8096,
      uptime_s: 876300, load_1: 0.08, temp_cpu_c: 44,
      disk: [{ mount: '/', total_mb: 59000, used_mb: 6000, used_pct: 10 }],
      extra: { thermal_state: 'nominal' },
    };
    const r = handlePush(db, { body, sourceIp: '192.0.2.10', allowInsecureLoopback: true, now: NOW });
    assert.equal(r.status, 200);
    assert.equal(r.body.hostname, 'control-node');

    const latest = getLatestFleetMetric(db, 'control-node');
    assert.equal(latest.cpu_pct, 6);
    assert.equal(latest.temp_cpu_c, 44);
    assert.equal(latest.agent_version, 'abc1234');

    const hosts = getFleetHosts(db);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].ip, '192.0.2.10');
    assert.equal(hosts[0].platform, 'pi5');
    assert.equal(hosts[0].agent_version, 'abc1234');
    assert.ok(hosts[0].last_seen);

    // fan-out into the generic metrics table for charting
    const cpuHist = getMetricHistory(db, 'control-node', 'cpu_pct', '2000-01-01', '2100-01-01');
    assert.equal(cpuHist.length, 1);
    assert.equal(cpuHist[0].value, 6);

    // derived liveness from the upserted host
    assert.equal(deriveState(hosts[0], NOW), 'online');

    // sparkline series
    assert.deepEqual(getFleetMetricSeries(db, 'control-node', 'cpu_pct', 10), [6]);
    db.close();
  });

  it('drops a future-dated ts so latest/charts use server time', () => {
    const db = tmpDb();
    const future = new Date(NOW + 3600 * 1000).toISOString();
    const r = handlePush(db, { body: { hostname: 'h', cpu_pct: 5, ts: future }, allowInsecureLoopback: true, now: NOW });
    assert.equal(r.status, 200);
    const latest = getLatestFleetMetric(db, 'h');
    assert.ok(Date.parse(latest.timestamp) <= NOW + 1000, 'future ts should be dropped in favor of received_at');
    db.close();
  });

  it('getLatestFleetMetric uses received_at/id, not the agent ts', () => {
    const db = tmpDb();
    // 2nd push has an OLDER ts but arrives LATER → it must win.
    handlePush(db, { body: { hostname: 'h', cpu_pct: 10, ts: ago(0) }, allowInsecureLoopback: true, now: NOW });
    handlePush(db, { body: { hostname: 'h', cpu_pct: 20, ts: ago(3600) }, allowInsecureLoopback: true, now: NOW + 1000 });
    assert.equal(getLatestFleetMetric(db, 'h').cpu_pct, 20);
    db.close();
  });

  it('a later versionless push clears the latest snapshot and rendered card to unknown', () => {
    const db = tmpDb();
    handlePush(db, {
      body: { hostname: 'h', cpu_pct: 10, agent_version: 'abc1234' },
      allowInsecureLoopback: true,
      now: NOW,
    });
    handlePush(db, {
      body: { hostname: 'h', cpu_pct: 20 },
      allowInsecureLoopback: true,
      now: NOW,
    });

    const latest = getLatestFleetMetric(db, 'h');
    assert.equal(latest.cpu_pct, 20, 'equal received_at rows must still pick the later id');
    assert.equal(latest.agent_version, null);

    const host = getFleetHosts(db).find((row) => row.hostname === 'h');
    assert.equal(host.agent_version, null, 'host snapshot must not retain a stale version');

    const machine = buildMachines(db, NOW + 1000, {}, { baselineVersion: 'abc1234' })
      .find((row) => row.hostname === 'h');
    assert.equal(machine.agentVersion, null);
    assert.equal(machine.agentVersionState, 'unknown');
    assert.match(
      machineCard(machine),
      /machine-agent"><span class="mono">agent unknown<\/span><span class="status-badge is-stale">[\s\S]*?unknown<\/span><\/div>/,
    );
    db.close();
  });
});

describe('POST /api/fleet/push request bounds', () => {
  it('rejects bodies larger than 64 KiB before validation or persistence', async () => {
    const db = tmpDb();
    const { app } = buildApp(db);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/fleet/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'oversized', extra: { note: 'x'.repeat(70 * 1024) } }),
      });
      assert.equal(res.statusCode, 413);
      assert.equal(getFleetHosts(db).some((h) => h.hostname === 'oversized'), false);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('always_on normalization', () => {
  it('normAlwaysOn maps 0/false/"0"/"false" → 0; default → 1', () => {
    for (const v of [0, false, '0', 'false']) assert.equal(normAlwaysOn(v), 0, `${v}`);
    for (const v of [1, true, 'true', undefined, null]) assert.equal(normAlwaysOn(v), 1, `${v}`);
  });
  it('upsertFleetHostConfig stores always_on:0 → host derives sleeping (not offline)', () => {
    const db = tmpDb();
    upsertFleetHostConfig(db, { hostname: 'lap', label: 'Laptop', always_on: 0 });
    const h = getFleetHosts(db).find((x) => x.hostname === 'lap');
    assert.equal(h.always_on, 0);
    assert.equal(deriveState(h, NOW), 'sleeping');
    db.close();
  });
  it('loadFleetConfig normalizes always_on:0 → false (default → true)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-cfg-'));
    const p = path.join(dir, 'cfg.json');
    fs.writeFileSync(p, JSON.stringify({ fleet: { hosts: [{ hostname: 'lap', always_on: 0 }, { hostname: 'pi' }] } }));
    const cfg = loadFleetConfig(p);
    assert.equal(cfg.hosts.find((h) => h.hostname === 'lap').always_on, false);
    assert.equal(cfg.hosts.find((h) => h.hostname === 'pi').always_on, true);
  });

  it('loadFleetConfig uses the HEIMDALL_CONFIG_PATH overlay by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-private-cfg-'));
    const configPath = path.join(dir, 'private.json');
    fs.writeFileSync(configPath, JSON.stringify({
      fleet: { hosts: [{ hostname: 'private-node' }] },
    }));
    const modulePath = path.resolve(__dirname, '../src/fleet/config.js');
    const output = execFileSync(process.execPath, ['-e', [
      `const { loadFleetConfig } = require(${JSON.stringify(modulePath)});`,
      'process.stdout.write(JSON.stringify(loadFleetConfig()));',
    ].join('\n')], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HEIMDALL_CONFIG_PATH: configPath },
      encoding: 'utf8',
    });
    const cfg = JSON.parse(output);
    assert.deepEqual(cfg.hosts.map((h) => h.hostname), ['private-node']);
    assert.equal(cfg.authority.status, 'loaded');
  });
});

describe('fleet render — temp sparkline', () => {
  it('canonical metric history includes samples written under a pre-rename alias', () => {
    const db = tmpDb();
    handlePush(db, {
      body: { hostname: 'old-control', temp_cpu_c: 41 },
      allowInsecureLoopback: true,
      now: NOW,
    });
    const history = getMetricHistory(
      db,
      'control-node',
      'temp_cpu_c',
      '2000-01-01',
      '2100-01-01',
      { 'old-control': 'control-node' },
    );
    assert.deepEqual(history.map((row) => row.value), [41]);
    db.close();
  });

  it('buildMachines includes a tempSpark series oldest→newest from temp_cpu_c pushes', () => {
    const db = tmpDb();
    handlePush(db, { body: { hostname: 'm5', temp_cpu_c: 40 }, allowInsecureLoopback: true, now: NOW });
    handlePush(db, { body: { hostname: 'm5', temp_cpu_c: 46 }, allowInsecureLoopback: true, now: NOW + 1000 });
    const machines = buildMachines(db, NOW + 2000, {});
    const m = machines.find((x) => x.hostname === 'm5');
    assert.ok(m, 'expected m5 in machines');
    assert.ok(Array.isArray(m.tempSpark));
    assert.ok(m.tempSpark.length >= 2, `expected >=2 points, got ${m.tempSpark.length}`);
    assert.deepEqual(m.tempSpark, [40, 46]);
    db.close();
  });

  it('machineCard renders a labeled temp sparkline distinct from the cpu one', () => {
    const html = machineCard({ hostname: 'm5', label: 'M5', state: 'online', tempSpark: [40, 46], spark: [5, 6] });
    // Both rows present and captioned.
    assert.match(html, /class="machine-spark"><span class="spark-cap">CPU</);
    assert.match(html, /class="machine-spark is-temp"><span class="spark-cap">Temp</);
    // Exactly two sparkline blocks and two SVGs (CPU + temp), not one merged/duplicated.
    assert.equal((html.match(/machine-spark/g) || []).length, 2);
    assert.equal((html.match(/<svg/g) || []).length, 2);
  });

  it('machineCard omits the temp sparkline block when tempSpark is empty or has <2 points', () => {
    const empty = machineCard({ hostname: 'm5', label: 'M5', state: 'online', tempSpark: [], spark: [5, 6] });
    assert.doesNotMatch(empty, /is-temp/);
    const single = machineCard({ hostname: 'm5', label: 'M5', state: 'online', tempSpark: [42], spark: [5, 6] });
    assert.doesNotMatch(single, /is-temp/);
  });

  it('machineCard applies the >=2-point guard to the CPU spark too (single point → no CPU sparkline)', () => {
    const single = machineCard({ hostname: 'm5', label: 'M5', state: 'online', tempSpark: [40, 46], spark: [5] });
    // CPU row suppressed (1 point), temp row still rendered → exactly one sparkline block.
    assert.doesNotMatch(single, /class="machine-spark"><span class="spark-cap">CPU</);
    assert.match(single, /is-temp/);
    assert.equal((single.match(/machine-spark/g) || []).length, 1);
  });
});

describe('fleet render — agent version drift', () => {
  it('agentVersionDriftState handles null, unknown, dev, short/full SHAs, and mixed case directly', () => {
    assert.equal(agentVersionDriftState(null, 'abc1234'), 'unknown');
    assert.equal(agentVersionDriftState('abc1234', null), 'unknown');
    assert.equal(agentVersionDriftState('unknown', 'abc1234'), 'unknown');
    assert.equal(agentVersionDriftState('abc1234', 'unknown'), 'unknown');
    assert.equal(agentVersionDriftState('dev', 'abc1234'), 'unknown');
    assert.equal(agentVersionDriftState('abc1234', 'dev'), 'unknown');
    assert.equal(agentVersionDriftState('AbC1234', 'aBc1234'), 'current');
    assert.equal(
      agentVersionDriftState('ABCDEF0123456789ABCDEF0123456789ABCDEF01', 'abcdef0'),
      'current',
    );
    assert.equal(agentVersionDriftState('deadbee', 'ABC1234'), 'drift');
  });

  it('buildMachines exposes current, drift, and unknown against the explicit runtime baseline', () => {
    const db = tmpDb();
    handlePush(db, { body: { hostname: 'current-node', agent_version: 'abc1234' }, allowInsecureLoopback: true, now: NOW });
    handlePush(db, { body: { hostname: 'drift-node', agent_version: 'deadbee' }, allowInsecureLoopback: true, now: NOW + 1000 });
    handlePush(db, { body: { hostname: 'legacy-node' }, allowInsecureLoopback: true, now: NOW + 2000 });

    const machines = buildMachines(db, NOW + 3000, {}, { baselineVersion: 'abc1234' });
    const byHost = Object.fromEntries(machines.map((m) => [m.hostname, m]));

    assert.equal(byHost['current-node'].agentVersion, 'abc1234');
    assert.equal(byHost['current-node'].agentVersionState, 'current');
    assert.equal(byHost['drift-node'].agentVersion, 'deadbee');
    assert.equal(byHost['drift-node'].agentVersionState, 'drift');
    assert.equal(byHost['legacy-node'].agentVersion, null);
    assert.equal(byHost['legacy-node'].agentVersionState, 'unknown');
    db.close();
  });

  it('exceptionsOnly still surfaces an online host with agent drift', () => {
    const db = tmpDb();
    handlePush(db, { body: { hostname: 'current-node', agent_version: 'abc1234' }, allowInsecureLoopback: true, now: NOW });
    handlePush(db, { body: { hostname: 'drift-node', agent_version: 'deadbee' }, allowInsecureLoopback: true, now: NOW + 1000 });

    const html = fleetGridFragment(db, NOW + 2000, {}, { exceptionsOnly: true, baselineVersion: 'abc1234' });
    assert.match(html, /drift-node/);
    assert.match(
      html,
      /machine-agent"><span class="mono">agent deadbee<\/span><span class="status-badge is-warn">[\s\S]*?drift<\/span><\/div>/,
    );
    assert.doesNotMatch(html, /No fleet exceptions\./);
    db.close();
  });

  it('can omit the M5 agent only from the Overview fleet fragment', () => {
    const db = tmpDb();
    handlePush(db, { body: { hostname: 'm5' }, allowInsecureLoopback: true, now: NOW });
    handlePush(db, { body: { hostname: 'nas' }, allowInsecureLoopback: true, now: NOW });

    const overview = fleetGridFragment(db, NOW + 1000, {}, { excludeHostnames: ['m5'] });
    const fullFleet = fleetGridFragment(db, NOW + 1000, {});

    assert.doesNotMatch(overview, />m5</);
    assert.match(overview, />nas</);
    assert.match(fullFleet, />m5</);
    db.close();
  });

  it('machineCard renders the agent version with current, drift, and unknown badges', () => {
    const current = machineCard({
      hostname: 'a', label: 'A', state: 'online',
      agentVersion: 'abc1234', agentVersionState: 'current',
    });
    assert.match(
      current,
      /machine-agent"><span class="mono">agent abc1234<\/span><span class="status-badge is-ok">[\s\S]*?current<\/span><\/div>/,
    );

    const drift = machineCard({
      hostname: 'b', label: 'B', state: 'online',
      agentVersion: 'deadbee', agentVersionState: 'drift',
    });
    assert.match(
      drift,
      /machine-agent"><span class="mono">agent deadbee<\/span><span class="status-badge is-warn">[\s\S]*?drift<\/span><\/div>/,
    );

    const legacy = machineCard({
      hostname: 'c', label: 'C', state: 'online',
      agentVersion: null, agentVersionState: 'unknown',
    });
    assert.match(
      legacy,
      /machine-agent"><span class="mono">agent unknown<\/span><span class="status-badge is-stale">[\s\S]*?unknown<\/span><\/div>/,
    );
  });
});

describe('fleetPage — data-hosts is HTML-escaped (XSS guard)', () => {
  it('escapes quote/markup-bearing hostnames so the data-hosts attribute cannot break out', () => {
    const db = tmpDb();
    // A hostname seeded via config bypasses the push-time regex, so the renderer
    // must not trust it. This one would break a naive single-quoted attribute and
    // inject markup.
    upsertFleetHostConfig(db, { hostname: `evil'"><b>x`, label: 'Evil' });
    const html = fleetPage('v1', db, NOW, {});
    // Raw dangerous sequences must NOT appear unescaped.
    assert.doesNotMatch(html, /data-hosts="[^"]*<b>/);
    assert.ok(!html.includes('"><b>'), 'attribute breakout must not occur');
    // Escaped entities present (proof the value was run through esc()).
    assert.match(html, /&lt;b&gt;/);
    assert.match(html, /&#39;|&quot;/);
    db.close();
  });
});

describe('pruneFleetMetrics', () => {
  it('deletes rows older than the cutoff, keeps newer', () => {
    const db = tmpDb();
    handlePush(db, { body: { hostname: 'h', cpu_pct: 5 }, allowInsecureLoopback: true, now: Date.parse('2026-06-01T00:00:00Z') });
    handlePush(db, { body: { hostname: 'h', cpu_pct: 6 }, allowInsecureLoopback: true, now: NOW });
    const cutoff = new Date(NOW - 7 * 24 * 3600 * 1000).toISOString();
    assert.equal(pruneFleetMetrics(db, cutoff), 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM fleet_metrics').get().c, 1);
    db.close();
  });
});
