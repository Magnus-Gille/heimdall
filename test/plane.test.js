'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot, createPlaneClient, listAll, weekStart } = require('../src/plane');
const { ticketsPage } = require('../src/render/tickets');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

const STATES = [
  { id: 's-b', group: 'backlog' }, { id: 's-t', group: 'unstarted' }, { id: 's-s', group: 'started' },
  { id: 's-d', group: 'completed' }, { id: 's-c', group: 'cancelled' }, { id: 's-x', group: 'triage' },
];

function rawProject(over = {}) {
  return {
    identifier: 'HUGIN', name: 'hugin', states: STATES, truncated: false,
    issues: [
      { state: 's-b' }, { state: 's-t' }, { state: 's-s' }, { state: 's-x' },
      { state: 's-d', completed_at: iso(2) }, { state: 's-d', completed_at: iso(20) },
      { state: 's-d', completed_at: iso(200) }, { state: 's-c' },
      { state: 's-d', completed_at: iso(1), archived_at: iso(0) },
    ],
    cycles: [
      { name: 'Etapp 1', start_date: '2026-11-17', end_date: '2026-11-30', total_issues: 8, completed_issues: 2, cancelled_issues: 1 },
      { name: 'Old', start_date: '2026-10-01', end_date: '2026-10-14', total_issues: 5, completed_issues: 5 },
      { name: 'Draft', start_date: null, end_date: null },
    ],
    modules: [
      { name: 'M1', status: 'in-progress', target_date: '2026-12-01', total_issues: 4, completed_issues: 1 },
      { name: 'M2', status: 'completed', total_issues: 2, completed_issues: 2 },
      { name: 'M3', status: 'planned' },
    ],
    ...over,
  };
}

describe('buildSnapshot', () => {
  const snap = buildSnapshot([rawProject()], NOW);

  it('groups by state group, unknown groups into other, skips archived', () => {
    const p = snap.projects[0];
    assert.deepEqual(p.groups, { backlog: 1, unstarted: 1, started: 1, completed: 3, cancelled: 1, other: 1 });
    assert.equal(p.total, 8);
    assert.equal(p.open, 4);
    assert.equal(p.pct, 38);
  });

  it('computes totals and weekly throughput', () => {
    assert.equal(snap.totals.open, 4);
    assert.equal(snap.totals.closed7d, 1);
    assert.equal(snap.totals.closed30d, 2);
    assert.equal(snap.weekly.length, 12);
    assert.equal(snap.weekly.reduce((a, w) => a + w.closed, 0), 2); // 200 days ago falls outside
    assert.equal(snap.weekly.at(-1).weekStart, weekStart(NOW));
  });

  it('only includes current dated cycles, using cycle counts', () => {
    assert.equal(snap.cycles.length, 1);
    const c = snap.cycles[0];
    assert.equal(c.name, 'Etapp 1');
    assert.equal(c.pct, 25);
    assert.ok(c.daysLeft > 0 && c.elapsedPct > 0);
    assert.equal(snap.totals.inCycle, 5);
  });

  it('lists only open modules and tolerates missing counts', () => {
    assert.deepEqual(snap.modules.map((m) => m.name), ['M1', 'M3']);
    assert.equal(snap.modules[0].pct, 25);
    assert.equal(snap.modules[1].pct, null);
  });
});

describe('listAll', () => {
  it('follows cursors and flags the page ceiling', async () => {
    const pages = [
      { results: [1], next_page_results: true, next_cursor: 'a' },
      { results: [2], next_page_results: true, next_cursor: 'b' },
      { results: [3], next_page_results: false },
    ];
    let i = 0;
    const cfg = { baseUrl: 'http://x', apiKey: 'k', workspace: 'w' };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => pages[i++] });
    assert.deepEqual(await listAll(cfg, 'p', fetchImpl), { items: [1, 2, 3], truncated: false });
    i = 0;
    assert.deepEqual(await listAll(cfg, 'p', fetchImpl, 2), { items: [1, 2], truncated: true });
  });
});

function fakePlane(fail = false) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, key: opts.headers['X-API-Key'] });
    if (fail) throw new Error('ECONNREFUSED');
    const u = new URL(url);
    const body = u.pathname.endsWith('/projects/') ? { results: [{ id: 'p1', identifier: 'HUGIN', name: 'hugin' }, { id: 'p2', identifier: 'SAGA', name: 'saga' }] }
      : u.pathname.endsWith('/states/') ? { results: STATES }
      : u.pathname.endsWith('/issues/') ? { results: [{ state: 's-d', completed_at: new Date().toISOString() }, { state: 's-s' }] }
      : { results: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

describe('createPlaneClient', () => {
  const env = { PLANE_BASE_URL: 'http://plane.test/', PLANE_API_KEY: 'secret', PLANE_PROJECTS: 'HUGIN' };

  it('is disabled without config', async () => {
    const c = createPlaneClient({ env: {}, fetchImpl: fakePlane().fetchImpl });
    assert.equal((await c.get()).configured, false);
  });

  it('fetches only wanted projects, caches, and sends the key as a header', async () => {
    const { fetchImpl, calls } = fakePlane();
    const c = createPlaneClient({ env, fetchImpl });
    const r = await c.get();
    assert.equal(r.snapshot.projects.length, 1);
    assert.equal(r.snapshot.totals.closed7d, 1);
    assert.ok(calls.every((x) => x.key === 'secret' && !x.url.includes('secret')));
    const n = calls.length;
    await c.get();
    assert.equal(calls.length, n); // warm cache: no refetch
  });

  it('reports unreachable without throwing', async () => {
    const r = await createPlaneClient({ env, fetchImpl: fakePlane(true).fetchImpl }).get();
    assert.equal(r.snapshot, null);
    assert.equal(r.error, 'Plane unreachable');
  });
});

describe('ticketsPage', () => {
  it('renders not-configured and unreachable states', () => {
    assert.match(ticketsPage('t', { configured: false }), /not configured/);
    assert.match(ticketsPage('t', { configured: true, snapshot: null, error: 'boom' }), /unreachable/);
  });

  it('renders the snapshot and escapes names', () => {
    const snap = buildSnapshot([rawProject({ name: '<b>x</b>', cycles: [{ name: '<script>', start_date: '2026-11-17', end_date: '2026-11-30', total_issues: 1 }] })], Date.now());
    const html = ticketsPage('t', { configured: true, snapshot: snap, errors: [{ project: 'MUNIN' }], fetchedAt: Date.now() - 600000, stale: true });
    assert.match(html, /Progress per project/);
    assert.match(html, /<svg class="tk-weekly"/);
    assert.match(html, /cached data/);
    assert.match(html, /MUNIN/);
    assert.doesNotMatch(html, /<script>/);
  });
});

describe('resilience', () => {
  const env = { PLANE_BASE_URL: 'http://plane.test', PLANE_API_KEY: 'secret', PLANE_PROJECTS: 'HUGIN' };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const route = (u, issues = [{ state: 's-s' }]) => {
    const p = new URL(u).pathname;
    return ok(p.endsWith('/projects/') ? { results: [{ id: 'p1', identifier: 'HUGIN', name: 'h' }] }
      : p.endsWith('/states/') ? { results: STATES } : p.endsWith('/issues/') ? { results: issues } : { results: [] });
  };

  it('honours Retry-After on 429 and then succeeds', async () => {
    const waits = [];
    let first = true;
    const fetchImpl = async (u) => {
      if (first) { first = false; return { ok: false, status: 429, headers: { get: () => '7' } }; }
      return route(u);
    };
    const r = await createPlaneClient({ env, fetchImpl, sleepImpl: async (ms) => waits.push(ms) }).get();
    assert.deepEqual(waits, [7000]);
    assert.equal(r.snapshot.totals.total, 1);
  });

  it('gives up after repeated 429s with a fixed error code', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: () => null } });
    const r = await createPlaneClient({ env, fetchImpl, sleepImpl: async () => {} }).get();
    assert.equal(r.snapshot, null);
    assert.equal(r.error, 'Plane rate limited');
  });

  it('keeps last good data when the refresh fails outright', async () => {
    let t = 1000, broken = false;
    const fetchImpl = async (u) => {
      if (broken) return { ok: false, status: 500 };
      return route(u);
    };
    const c = createPlaneClient({ env, fetchImpl, now: () => t, ttlMs: 10 });
    assert.equal((await c.get()).snapshot.totals.total, 1);
    broken = true; t += 100;
    await c.get(); await c.refresh();
    const r = await c.get();
    assert.equal(r.snapshot.totals.total, 1);
    assert.equal(r.stale, true);
    assert.match(r.error, /HTTP 500/);
  });

  it('carries a failing project forward and flags it', async () => {
    let t = 1000, failIssues = false;
    const fetchImpl = async (u) => (failIssues && new URL(u).pathname.endsWith('/issues/') ? { ok: false, status: 500 } : route(u));
    const c = createPlaneClient({ env, fetchImpl, now: () => t, ttlMs: 10 });
    await c.get();
    failIssues = true; t += 100;
    await c.refresh();
    const r = await c.get();
    assert.equal(r.snapshot.totals.total, 1);
    assert.deepEqual(r.errors.map((e) => e.project), ['HUGIN']);
  });

  it('does not relay upstream body fragments and backs off after a cold failure', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <, "<!DOCTYPE"'); } }; };
    const c = createPlaneClient({ env, fetchImpl });
    const r = await c.get();
    assert.equal(r.error, 'Plane bad response');
    const n = calls;
    await c.get();
    assert.equal(calls, n); // inside back-off window: no refetch
  });

  it('refuses redirects so the key is never forwarded', async () => {
    let init;
    await createPlaneClient({ env, fetchImpl: async (u, o) => { init = o; return route(u); } }).get();
    assert.equal(init.redirect, 'error');
  });

  it('buckets weeks correctly across Sunday/Monday and year rollover', () => {
    assert.equal(new Date(weekStart(Date.parse('2026-11-22T23:59:59Z'))).toISOString(), '2026-11-16T00:00:00.000Z'); // Sunday
    assert.equal(new Date(weekStart(Date.parse('2026-11-23T00:00:00Z'))).toISOString(), '2026-11-23T00:00:00.000Z'); // Monday
    assert.equal(new Date(weekStart(Date.parse('2027-01-01T12:00:00Z'))).toISOString(), '2026-12-28T00:00:00.000Z');
  });
});
