'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildOverviewStatus, overviewStatusFragment, buildDeployRows, deploysGridFragment,
} = require('../src/render/overview');
const { withPushedStatus, PUSH_STATUS_STALE_MS } = require('../src/render/service-page');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-overview-'));
  return openDatabase(path.join(dir, 'test.db'));
}

// Minimal snapshot shape consumed by serviceView (via buildOverviewStatus).
function snap(name, status, { reachable = true, drift = 0 } = {}) {
  return {
    service: name,
    kind: 'http-service',
    status,
    reachable,
    source: reachable ? 'descriptor' : 'config',
    descriptor: { service: { name }, kind: 'http-service', status, deploy: { drift } },
  };
}

describe('buildOverviewStatus', () => {
  it('reports all-healthy when nothing is broken', () => {
    const s = buildOverviewStatus({
      machines: [{ state: 'online' }, { state: 'online' }],
      snapshots: [snap('a', 'pass'), snap('b', 'pass')],
      alertCount: 0,
    });
    assert.equal(s.fleetOnline, 2);
    assert.equal(s.fleetTotal, 2);
    assert.equal(s.fleetOffline, 0);
    assert.equal(s.svcOk, 2);
    assert.equal(s.svcTotal, 2);
    assert.equal(s.svcDown, 0);
    assert.equal(s.alertCount, 0);
    assert.equal(s.svcDrift, 0);
    assert.equal(s.allHealthy, true);
  });

  it('flags attention when a machine is offline', () => {
    const s = buildOverviewStatus({
      machines: [{ state: 'online' }, { state: 'offline' }],
      snapshots: [snap('a', 'pass')],
      alertCount: 0,
    });
    assert.equal(s.fleetOnline, 1);
    assert.equal(s.fleetOffline, 1);
    assert.equal(s.allHealthy, false);
  });

  it('counts down services and active alerts', () => {
    const s = buildOverviewStatus({
      machines: [{ state: 'online' }],
      snapshots: [snap('a', 'fail'), snap('b', 'pass')],
      alertCount: 3,
    });
    assert.equal(s.svcDown, 1);
    assert.equal(s.svcOk, 1);
    assert.equal(s.alertCount, 3);
    assert.equal(s.allHealthy, false);
  });

  it('counts services behind on deploy (drift)', () => {
    const s = buildOverviewStatus({
      machines: [],
      snapshots: [snap('a', 'pass', { drift: 2 }), snap('b', 'pass', { drift: 0 })],
      alertCount: 0,
    });
    assert.equal(s.svcDrift, 1);
    // drift alone is a warning signal, not "broken" → still nominal banner
    assert.equal(s.allHealthy, true);
  });

  it('counts drift from service_versions too, unioned by service with snapshot drift', () => {
    const s = buildOverviewStatus({
      machines: [],
      snapshots: [snap('a', 'pass', { drift: 0 })],   // snapshot says clean (drift rarely self-reported)
      versions: [
        { service: 'a', host: 'h', deployed_commit: 'aaaaaaa', latest_commit: 'bbbbbbb', commits_behind: 2 },  // same service
        { service: 'b', host: 'h', deployed_commit: 'ccccccc', latest_commit: 'ddddddd', commits_behind: -1 }, // legacy sentinel
        { service: 'c', host: 'h', deployed_commit: 'eeeeeee', latest_commit: 'eeeeeee', commits_behind: 0 },  // up to date
      ],
      alertCount: 0,
    });
    // `a` is genuinely 2 behind. `b` carries the legacy `-1` sentinel, which was
    // never a measurement — it is counted as unmeasurable, not as drift.
    assert.equal(s.svcDrift, 1);
    assert.equal(s.svcUnmeasurable, 1);
    assert.equal(s.allHealthy, true);   // drift is a warning, not "broken"
  });

  it('treats unreachable services as not-down (degraded, not crit)', () => {
    const s = buildOverviewStatus({
      machines: [],
      snapshots: [snap('a', 'pass', { reachable: false })],
      alertCount: 0,
    });
    assert.equal(s.svcDown, 0);
    assert.equal(s.svcWarn, 0);
    assert.equal(s.allHealthy, true);
  });

  it('counts a reachable warn service as degraded (not healthy)', () => {
    const s = buildOverviewStatus({
      machines: [{ state: 'online' }],
      snapshots: [snap('a', 'warn'), snap('b', 'pass')],
      alertCount: 0,
    });
    assert.equal(s.svcWarn, 1);
    assert.equal(s.svcDown, 0);
    assert.equal(s.svcOk, 1);
    assert.equal(s.allHealthy, false);
  });

  it('counts a failed timer with a real last run as down', () => {
    const timer = {
      service: 'maintain', kind: 'timer', status: 'fail', reachable: false, source: 'config',
      descriptor: {
        service: { name: 'maintain' }, kind: 'timer', status: 'fail',
        timer: { lastRun: '2026-07-13T08:00:00Z', lastResult: 'exit 1' },
      },
    };
    const s = buildOverviewStatus({ machines: [], snapshots: [timer], alertCount: 0 });
    assert.equal(s.svcDown, 1);
    assert.equal(s.allHealthy, false);
  });

  it('does not count a never-run config-only timer as broken', () => {
    const timer = {
      service: 'never-run', kind: 'timer', status: null, reachable: false, source: 'config',
      descriptor: { service: { name: 'never-run' }, kind: 'timer', status: null, timer: null },
    };
    const s = buildOverviewStatus({ machines: [], snapshots: [timer], alertCount: 0 });
    assert.equal(s.svcDown, 0);
    assert.equal(s.svcWarn, 0);
    assert.equal(s.allHealthy, true);
  });

  it('counts stale pushed status and an unreachable live service as warnings, but not config-only unknown', () => {
    const old = Date.now() - PUSH_STATUS_STALE_MS - 1000;
    const stalePushed = withPushedStatus(
      {
        service: 'stale-pushed', kind: 'static', status: null,
        reachable: false, source: 'config', error: null,
        descriptor: { service: { name: 'stale-pushed' }, kind: 'static', status: null },
      },
      [{
        service: 'stale-pushed', panel: 'status', kind: 'status', label: 'Status',
        data: { state: 'pass' }, updated_at: old,
      }],
    );
    const unreachableLive = {
      service: 'unreachable-live', kind: 'http-service', status: null,
      reachable: false, source: 'config', error: 'unreachable',
      descriptor: { service: { name: 'unreachable-live' }, kind: 'http-service', status: null },
    };
    const configOnly = snap('config-only', null, { reachable: false });

    const s = buildOverviewStatus({
      machines: [], snapshots: [stalePushed, unreachableLive, configOnly], alertCount: 0,
    });
    assert.equal(s.svcOk, 0);
    assert.equal(s.svcWarn, 2);
    assert.equal(s.svcDown, 0);
    assert.equal(s.allHealthy, false);
  });

  it('a stale machine (late telemetry) trips attention; a sleeping one does not', () => {
    const stale = buildOverviewStatus({ machines: [{ state: 'stale' }], snapshots: [], alertCount: 0 });
    assert.equal(stale.fleetStale, 1);
    assert.equal(stale.allHealthy, false);

    const sleeping = buildOverviewStatus({ machines: [{ state: 'sleeping' }], snapshots: [], alertCount: 0 });
    assert.equal(sleeping.fleetStale, 0);
    assert.equal(sleeping.fleetOffline, 0);
    assert.equal(sleeping.allHealthy, true);
  });

  it('counts agent version drift as a fleet exception even while the machine is online', () => {
    const s = buildOverviewStatus({
      machines: [{ state: 'online', agentVersionState: 'drift' }],
      snapshots: [],
      alertCount: 0,
    });
    assert.equal(s.fleetOnline, 1);
    assert.equal(s.fleetDrift, 1);
    assert.equal(s.allHealthy, false);
  });
});

describe('overviewStatusFragment', () => {
  it('renders the nominal banner and KPI counts', () => {
    const html = overviewStatusFragment(buildOverviewStatus({
      machines: [{ state: 'online' }],
      snapshots: [snap('a', 'pass')],
      alertCount: 0,
    }));
    assert.match(html, /System status/);
    assert.match(html, /nominal/i);
    assert.match(html, /1\/1/);            // machines online
    assert.match(html, /Machines online/);
    assert.match(html, /Active alert/);
  });

  it('renders the attention banner when something is broken', () => {
    const html = overviewStatusFragment(buildOverviewStatus({
      machines: [{ state: 'offline' }],
      snapshots: [],
      alertCount: 1,
    }));
    assert.match(html, /Attention/i);
    assert.match(html, /is-crit/);
  });

  it('warns on the Machines online KPI when the only fleet exception is agent drift', () => {
    const html = overviewStatusFragment(buildOverviewStatus({
      machines: [{ state: 'online', agentVersionState: 'drift' }],
      snapshots: [],
      alertCount: 0,
    }));
    assert.match(html, /Attention needed/);
    assert.match(html, /class="kpi-val is-warn">1\/1<\/span><span class="kpi-label">Machines online<\/span>/);
  });
});

function ver(service, { deployed = 'abc1234', latest = 'abc1234', behind = 0, host = 'control-node' } = {}) {
  return { service, host, deployed_commit: deployed, latest_commit: latest, commits_behind: behind };
}

describe('buildDeployRows', () => {
  it('classifies up-to-date, drifted, and no-data services', () => {
    const rows = buildDeployRows([
      ver('a', { behind: 0 }),
      ver('b', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: 2 }),
      ver('c', { deployed: null, latest: null, behind: 0 }),
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.service, r]));
    assert.equal(byName.a.state, 'ok');
    assert.equal(byName.b.state, 'warn');
    assert.equal(byName.b.behind, 2);
    assert.equal(byName.c.state, 'stale');   // no deployed commit → unknown, not crit
  });

  it('orders drifted first, then unknown, then up-to-date (each alphabetical)', () => {
    const rows = buildDeployRows([
      ver('zeta', { behind: 0 }),
      ver('alpha', { behind: 0 }),
      ver('drift-b', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: 1 }),
      ver('drift-a', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: 3 }),
      ver('nodata', { deployed: null, latest: null }),
    ]);
    assert.deepEqual(rows.map((r) => r.service), ['drift-a', 'drift-b', 'nodata', 'alpha', 'zeta']);
  });

  it('derives up-to-date from commit equality when both are known but no count is recorded', () => {
    const rows = buildDeployRows([{ service: 'a', host: 'h', deployed_commit: 'abc1234', latest_commit: 'abc1234' }]);
    assert.equal(rows[0].state, 'ok');
    // `behind` is null, not 0: nothing was counted. The STATE carries the verdict,
    // so an absent count can no longer masquerade as a measured "0 behind".
    assert.equal(rows[0].behind, null);
  });

  it('marks a deployed service with unknown latest (no count) as unknown, not up-to-date', () => {
    // drift.js leaves commits_behind null when origin/main fetch fails (latest null);
    // coercing that to 0 would falsely show "up to date".
    const rows = buildDeployRows([{ service: 'a', host: 'h', deployed_commit: 'abc1234', latest_commit: null, commits_behind: null }]);
    assert.equal(rows[0].state, 'stale');
    assert.notEqual(rows[0].state, 'ok');
  });

  it('with both commits known but an explicit null count, derives drift from inequality (no false 0-behind)', () => {
    const rows = buildDeployRows([{ service: 'a', host: 'h', deployed_commit: 'aaaaaaa', latest_commit: 'bbbbbbb', commits_behind: null }]);
    assert.equal(rows[0].state, 'warn');   // differing commits → drift, even though Number(null)===0
  });

  it('treats the legacy commits_behind === -1 sentinel as NOT MEASURABLE, not as drift', () => {
    // CONTRACT CHANGE. drift.js used to write -1 for "these two values differ,
    // count unknown" — including when one of them was never a commit. It drove
    // six false "Deploy drift" warnings on the live instance. A negative count is
    // an instrumentation failure, so it now reads as unknown and never alerts.
    const rows = buildDeployRows([ver('a', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: -1 })]);
    assert.equal(rows[0].state, 'stale');
    assert.equal(rows[0].drift, 'unknown');
    assert.ok(rows[0].behind === null || rows[0].behind >= 0, 'a negative count never reaches the renderer');
  });

  it('returns [] for no versions', () => {
    assert.deepEqual(buildDeployRows([]), []);
    assert.deepEqual(buildDeployRows(), []);
  });
});

describe('deploysGridFragment', () => {
  it('renders an empty-state card when there is no deploy data', () => {
    const html = deploysGridFragment([]);
    assert.match(html, /class="grid"/);
    assert.match(html, /No deployment data yet/);
  });

  it('renders a drift badge and the running→latest commits for a behind service', () => {
    const html = deploysGridFragment([ver('munin', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: 4 })]);
    assert.match(html, /munin/);
    assert.match(html, /4 behind/);
    assert.match(html, /aaaaaaa/);
    assert.match(html, /bbbbbbb/);
    assert.match(html, /class="arrow"/);
  });

  it('labels a deployed-but-uncomparable service "not measurable" (latest fetch failed) and shows its commit', () => {
    const html = deploysGridFragment([{ service: 'm', host: 'h', deployed_commit: 'abc1234', latest_commit: null, commits_behind: null }]);
    assert.match(html, /not measurable/);
    assert.match(html, /abc1234/);
    assert.doesNotMatch(html, /up to date/);
  });

  it('labels a real drift with no count as "behind" (never "-1 behind")', () => {
    const html = deploysGridFragment([{ service: 'munin', host: 'h', deployed_commit: 'aaaaaaa', latest_commit: 'bbbbbbb', commits_behind: null, drift_state: 'drift' }]);
    assert.match(html, />behind</);
    assert.doesNotMatch(html, /-1 behind/);
  });

  it('shows "up to date" and no arrow when running == latest', () => {
    const html = deploysGridFragment([ver('heimdall', { deployed: 'ccccccc', latest: 'ccccccc', behind: 0 })]);
    assert.match(html, /up to date/);
    assert.doesNotMatch(html, /class="arrow"/);
  });

  it('exception mode shows only drift and a clear all-clear when none exists', () => {
    const html = deploysGridFragment([
      ver('clean', { behind: 0 }),
      ver('drifted', { deployed: 'aaaaaaa', latest: 'bbbbbbb', behind: 2 }),
    ], { exceptionsOnly: true });
    assert.match(html, /drifted/);
    assert.doesNotMatch(html, />clean</);
    assert.match(deploysGridFragment([ver('clean')], { exceptionsOnly: true }), /No deployment drift/);
  });

  it('escapes service/host/commit values', () => {
    const html = deploysGridFragment([ver('<x>', { deployed: '<d>', latest: '<l>', behind: 1, host: '<h>' })]);
    assert.doesNotMatch(html, /<x>/);
    assert.match(html, /&lt;x&gt;/);
  });
});

describe('GET / (v2 Overview)', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('renders the v2 shell with the Overview as active nav', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /class="nav"/);                 // v2 shell, not v1
    assert.match(res.body, /href="\/fleet"/);              // v2 nav present
    assert.match(res.body, /href="\/services"/);
    assert.match(res.body, /System status/);               // overview hero
    assert.match(res.body, /aria-current="page"/);         // Overview is active
  });

  it('embeds the live-refresh wrappers for status, fleet, services and deployments', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.match(res.body, /hx-get="\/api\/overview\/status"/);
    assert.match(res.body, /hx-get="\/api\/fleet\/grid\?mode=exceptions"/);
    assert.match(res.body, /hx-get="\/api\/services\/grid\?mode=exceptions"/);
    assert.match(res.body, /hx-get="\/api\/overview\/deploys\?mode=exceptions"/);
  });

  it('renders the Deployments section inline (no standalone detail page)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.match(res.body, /Deployment attention/);
    // v1 /deployments page was retired; the section is self-contained now.
    assert.doesNotMatch(res.body, /href="\/deployments"/);
  });
});

describe('GET /api/overview/deploys', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('returns the deployments grid fragment (empty-state on a fresh db)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview/deploys' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /class="grid"/);
    assert.match(res.body, /No deployment data yet/);
  });
});

describe('GET /api/overview/status', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('returns the status hero fragment', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview/status' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /System status/);
  });

  it('wraps the hero in a grid so the refresh swap keeps the DOM shape stable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview/status' });
    // The initial page embeds grid([hero]); the refresh must do the same so the
    // .col-full card always has a .grid parent (no layout shift on swap).
    assert.match(res.body, /class="grid"/);
    assert.match(res.body, /col-full/);
  });
});

describe('retired v1 standalone routes', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  // The v1 standalone page surface was retired after the v2 shell became the
  // front door and M5/Services parity went live (heimdall#5).
  for (const url of ['/legacy', '/tasks', '/briefing', '/m5', '/architecture', '/deployments', '/status']) {
    it(`returns 404 for retired ${url}`, async () => {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404);
    });
  }
});
