'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  pollService, pollAll, descriptorUrlFor, deriveBase, kindFromType, normalizeHealthStatus,
  defaultFetchJson, MAX_FETCH_BYTES, deriveTimerState,
} = require('../src/discovery');
const { openDatabase, getServiceSnapshots, getServiceSnapshot } = require('../src/db');
const { refreshTimerSnapshots } = require('../src/timer-snapshots');

const NOW = Date.parse('2026-06-23T12:00:00Z');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-disc-'));
  return openDatabase(path.join(dir, 'test.db'));
}

/** A fetchJson mock that dispatches by URL. */
function mockFetch(routes) {
  return async (url) => {
    if (url in routes) {
      const r = routes[url];
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`ECONNREFUSED ${url}`);
  };
}

describe('discovery helpers', () => {
  it('derives the descriptor URL from a health URL', () => {
    assert.equal(descriptorUrlFor({ health_url: 'http://localhost:3030/health' }), 'http://localhost:3030/heimdall.json');
    assert.equal(descriptorUrlFor({ descriptor_url: 'http://x/d.json', health_url: 'http://x/health' }), 'http://x/d.json');
    assert.equal(descriptorUrlFor({ type: 'timer' }), null);
  });
  it('deriveBase strips the path', () => {
    assert.equal(deriveBase('http://h:3034/health'), 'http://h:3034');
    assert.equal(deriveBase('not a url'), null);
  });
  it('kindFromType maps timer/static, else http-service', () => {
    assert.equal(kindFromType('timer'), 'timer');
    assert.equal(kindFromType('static'), 'static');
    assert.equal(kindFromType(undefined), 'http-service');
  });
  it('normalizeHealthStatus maps common vocabularies', () => {
    assert.equal(normalizeHealthStatus({ status: 'ok' }, true), 'pass');
    assert.equal(normalizeHealthStatus({ status: 'degraded' }, true), 'warn');
    assert.equal(normalizeHealthStatus({ status: 'down' }, true), 'fail');
    assert.equal(normalizeHealthStatus(null, true), 'pass');
    assert.equal(normalizeHealthStatus(null, false), 'fail');
  });
});

describe('discovery.pollService tiers', () => {
  it('tier 1: uses a valid /heimdall.json descriptor', async () => {
    const svc = { name: 'm5', health_url: 'http://m5/healthz' };
    const fetchJson = mockFetch({
      'http://m5/heimdall.json': { ok: true, status: 200, json: { service: { name: 'm5' }, kind: 'inference', status: 'pass', version: '1.0' } },
    });
    const snap = await pollService(svc, { fetchJson, now: NOW });
    assert.equal(snap.source, 'descriptor');
    assert.equal(snap.reachable, true);
    assert.equal(snap.kind, 'inference');
    assert.equal(snap.status, 'pass');
  });

  it('tier 1: persists a content-blind warning when descriptor table rows are discarded (#40)', async () => {
    const secret = 'discarded-row-payload-must-not-surface';
    const svc = { name: 'producer', health_url: 'http://producer/health' };
    const snap = await pollService(svc, { fetchJson: mockFetch({
      'http://producer/heimdall.json': {
        ok: true, status: 200,
        json: { service: { name: 'producer' }, panels: [{ id: 'queue', kind: 'table', rows: [[secret]] }] },
      },
    }), now: NOW });
    assert.equal(snap.source, 'descriptor');
    assert.deepEqual(snap.descriptor.panel_warnings, [
      { panel: 'queue', reason: 'non_object_table_rows_discarded', count: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(snap.descriptor.panel_warnings), new RegExp(secret));
  });

  it('tier 1: persists a distinct content-blind warning for discarded detail rows (#40)', async () => {
    const secret = 'discarded-detail-payload-must-not-surface';
    const svc = { name: 'producer', health_url: 'http://producer/health' };
    const snap = await pollService(svc, { fetchJson: mockFetch({
      'http://producer/heimdall.json': {
        ok: true, status: 200,
        json: {
          service: { name: 'producer' },
          panels: [{ id: 'trend', kind: 'timeseries', points: [{ t: 'now', y: 1 }], detail: { rows: [[secret]] } }],
        },
      },
    }), now: NOW });
    assert.deepEqual(snap.descriptor.panel_warnings, [
      { panel: 'trend', reason: 'non_object_detail_table_rows_discarded', count: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(snap.descriptor.panel_warnings), new RegExp(secret));
  });

  it('tier 2: falls back to /health when no descriptor', async () => {
    const svc = { name: 'munin', health_url: 'http://munin/health', repo: 'Magnus-Gille/munin-memory' };
    const fetchJson = mockFetch({
      'http://munin/heimdall.json': { ok: false, status: 404, json: null },
      'http://munin/health': { ok: true, status: 200, json: { status: 'ok', version: 'abc1234' } },
    });
    const snap = await pollService(svc, { fetchJson, now: NOW });
    assert.equal(snap.source, 'health');
    assert.equal(snap.reachable, true);
    assert.equal(snap.status, 'pass');
    assert.equal(snap.descriptor.version, 'abc1234');
    assert.equal(snap.descriptor.links.repo, 'https://github.com/Magnus-Gille/munin-memory');
  });

  it('tier 3: config-only when unreachable (http) → not reachable + error', async () => {
    const svc = { name: 'hugin', health_url: 'http://hugin/health' };
    const snap = await pollService(svc, { fetchJson: mockFetch({}), now: NOW });
    assert.equal(snap.source, 'config');
    assert.equal(snap.reachable, false);
    assert.equal(snap.error, 'unreachable');
    assert.equal(snap.kind, 'http-service');
  });

  it('tier 3: a timer with no endpoint is config-only with no error', async () => {
    const snap = await pollService({ name: 'skuld', type: 'timer' }, { fetchJson: mockFetch({}), now: NOW });
    assert.equal(snap.source, 'config');
    assert.equal(snap.kind, 'timer');
    assert.equal(snap.error, null);
    assert.equal(snap.status, null); // no run data → unknown, not a false pass
  });

  it('tier 3: a timer surfaces its last-run pass state and detail (#97)', async () => {
    const timerState = () => ({ exitOk: true, lastResult: 'ok', lastRun: '2026-06-23T03:00:00Z', nextRun: '2026-06-24T03:00:00Z' });
    const snap = await pollService({ name: 'skuld', type: 'timer' }, { fetchJson: mockFetch({}), now: NOW, timerState });
    assert.equal(snap.status, 'pass');
    assert.equal(snap.reachable, false); // still no live endpoint — honest
    assert.equal(snap.source, 'config');
    assert.equal(snap.descriptor.timer.lastRun, '2026-06-23T03:00:00Z');
    assert.equal(snap.descriptor.timer.nextRun, '2026-06-24T03:00:00Z');
  });

  it('tier 3: a failed timer surfaces fail state (#97)', async () => {
    const timerState = () => ({ exitOk: false, lastResult: 'exit 1', lastRun: '2026-06-23T03:00:00Z', nextRun: '2026-06-24T03:00:00Z' });
    const snap = await pollService({ name: 'grimnir-validate', type: 'timer' }, { fetchJson: mockFetch({}), now: NOW, timerState });
    assert.equal(snap.status, 'fail');
  });

  it('tier 3: a never-run timer stays unknown even though systemd exit defaults to 0 (#97)', async () => {
    const timerState = () => ({ exitOk: true, lastResult: 'ok', lastRun: null, nextRun: '2026-06-24T03:00:00Z' });
    const snap = await pollService({ name: 'freshly-installed', type: 'timer' }, { fetchJson: mockFetch({}), now: NOW, timerState });
    assert.equal(snap.status, null);
  });
});

describe('discovery.deriveTimerState (#97)', () => {
  const NOW = Date.parse('2026-06-23T12:00:00Z');
  it('null when never run (lastRun absent), despite exit 0 default', () => {
    assert.equal(deriveTimerState({ exitOk: true, lastRun: null, nextRun: '2026-06-24T00:00:00Z' }, NOW), null);
  });
  it('fail on non-zero exit', () => {
    assert.equal(deriveTimerState({ exitOk: false, lastRun: '2026-06-23T03:00:00Z' }, NOW), 'fail');
  });
  it('pass when last run ok and next run is still in the future', () => {
    assert.equal(deriveTimerState({ exitOk: true, lastRun: '2026-06-23T03:00:00Z', nextRun: '2026-06-24T03:00:00Z' }, NOW), 'pass');
  });
  it('warn (stale) when next run is well past due', () => {
    // nextRun 6h in the past → overdue beyond the grace window
    assert.equal(deriveTimerState({ exitOk: true, lastRun: '2026-06-22T03:00:00Z', nextRun: '2026-06-23T06:00:00Z' }, NOW), 'warn');
  });
  it('null when given no run data at all', () => {
    assert.equal(deriveTimerState(null, NOW), null);
  });
  it('unknown exit (exitOk null) with a current schedule is not a false warn', () => {
    // ran, next run still in the future, but no result metric → unknown, not warn/fail.
    assert.equal(deriveTimerState({ exitOk: null, lastRun: '2026-06-23T03:00:00Z', nextRun: '2026-06-24T03:00:00Z' }, NOW), null);
  });
  it('unknown exit still reports overdue when the schedule is past due', () => {
    assert.equal(deriveTimerState({ exitOk: null, lastRun: '2026-06-22T03:00:00Z', nextRun: '2026-06-23T06:00:00Z' }, NOW), 'warn');
  });
});

describe('discovery.pollAll persists snapshots', () => {
  it('writes one snapshot row per service', async () => {
    const db = tmpDb();
    const services = [
      { name: 'm5', health_url: 'http://m5/healthz' },
      { name: 'skuld', type: 'timer' },
    ];
    const fetchJson = mockFetch({
      'http://m5/heimdall.json': { ok: true, status: 200, json: { service: { name: 'm5' }, kind: 'inference', status: 'pass' } },
    });
    await pollAll(db, services, { fetchJson, now: NOW });
    const all = getServiceSnapshots(db);
    assert.equal(all.length, 2);
    assert.equal(getServiceSnapshot(db, 'm5').kind, 'inference');
    assert.equal(getServiceSnapshot(db, 'm5').descriptor.service.name, 'm5'); // hydrated JSON
    assert.equal(getServiceSnapshot(db, 'skuld').reachable, 0);
    db.close();
  });
});

// #26 — drift.js writes timer_* metrics during the collector cycle. The timer
// snapshot must consume those new rows in that same cycle, rather than waiting
// for the dashboard's next independent discovery tick.
describe('timer snapshot refresh (#26)', () => {
  it('reflects a successful timer metric written in the current collector cycle', async () => {
    const db = tmpDb();
    const timestamp = '2026-07-26T19:15:49.000Z';
    const service = { name: 'grimnir-validate', type: 'timer' };
    const { insertMetrics } = require('../src/db');
    insertMetrics(db, [
      { timestamp, host: 'control-node', metric: 'timer_last_result_grimnir-validate', value: 1, unit: 'status', metadata: 'ok' },
      { timestamp, host: 'control-node', metric: 'timer_last_run_grimnir-validate', value: 0, unit: 'timestamp', metadata: timestamp },
      { timestamp, host: 'control-node', metric: 'timer_next_run_grimnir-validate', value: 0, unit: 'timestamp', metadata: '2026-07-27T19:15:49.000Z' },
    ]);

    await refreshTimerSnapshots(db, [service], { now: Date.parse(timestamp) });

    const snapshot = getServiceSnapshot(db, service.name);
    assert.equal(snapshot.status, 'pass');
    assert.equal(snapshot.descriptor.timer.lastResult, 'ok');
    db.close();
  });
});

// ─── defaultFetchJson byte cap (Fix 1 — descriptor fetch size) ────────────────

describe('defaultFetchJson — byte cap', () => {
  it('returns ok:false when the response body exceeds MAX_FETCH_BYTES', async () => {
    const bigText = 'x'.repeat(MAX_FETCH_BYTES + 1);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => bigText,
    });
    try {
      const r = await defaultFetchJson('http://test/endpoint', 4000);
      assert.equal(r.ok, false, 'expected ok:false for oversized body');
      assert.equal(r.json, null, 'expected json:null for oversized body');
      assert.equal(r.status, 200);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('returns ok:true + parsed json for a normal-sized response', async () => {
    const body = JSON.stringify({ service: { name: 'test' } });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    });
    try {
      const r = await defaultFetchJson('http://test/endpoint', 4000);
      assert.equal(r.ok, true);
      assert.ok(r.json != null);
      assert.equal(r.json.service.name, 'test');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('rejects a chunked / no-Content-Length oversized body WITHOUT buffering it all', async () => {
    // 64 KiB chunks; 16 of them = 1 MiB total if fully read. The cap is 256 KiB,
    // so the reader must be cancelled after ~5 chunks (320 KiB > 256 KiB).
    const CHUNK = 64 * 1024;
    const NUM_CHUNKS = 16;
    let reads = 0;
    let cancelled = false;
    const reader = {
      read: async () => {
        if (cancelled || reads >= NUM_CHUNKS) return { done: true, value: undefined };
        reads++;
        return { done: false, value: new Uint8Array(CHUNK) };
      },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null }, // no Content-Length → must stream
      body: { getReader: () => reader },
      text: async () => { throw new Error('text() must not be called for a streamed body'); },
    });
    try {
      const r = await defaultFetchJson('http://test/endpoint', 4000);
      assert.equal(r.ok, false, 'expected ok:false for oversized streamed body');
      assert.equal(r.json, null);
      assert.equal(cancelled, true, 'stream must be cancelled once over cap');
      assert.ok(reads < NUM_CHUNKS, `expected early stop, but read all ${reads}/${NUM_CHUNKS} chunks`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('rejects early via Content-Length without reading the body', async () => {
    let readerRequested = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(MAX_FETCH_BYTES + 1) : null) },
      body: { getReader: () => { readerRequested = true; return { read: async () => ({ done: true }), cancel: async () => {}, releaseLock: () => {} }; } },
      text: async () => { throw new Error('text() must not be called'); },
    });
    try {
      const r = await defaultFetchJson('http://test/endpoint', 4000);
      assert.equal(r.ok, false, 'expected ok:false from Content-Length rejection');
      assert.equal(readerRequested, false, 'body must not be read when Content-Length already exceeds cap');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('streams and parses a normal-sized chunked body (Content-Length absent)', async () => {
    const json = JSON.stringify({ service: { name: 'streamed' } });
    const bytes = new TextEncoder().encode(json);
    let done = false;
    const reader = {
      read: async () => {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: bytes };
      },
      cancel: async () => {},
      releaseLock: () => {},
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => reader },
    });
    try {
      const r = await defaultFetchJson('http://test/endpoint', 4000);
      assert.equal(r.ok, true);
      assert.equal(r.json.service.name, 'streamed');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('pollService falls through to tier 2 when descriptor body is oversized', async () => {
    const svc = { name: 'svc', health_url: 'http://svc/health' };
    // Simulate what defaultFetchJson returns when response > MAX_FETCH_BYTES.
    const fetchJson = async (url) => {
      if (url.endsWith('/heimdall.json')) return { ok: false, status: 200, json: null };
      if (url.endsWith('/health')) return { ok: true, status: 200, json: { status: 'pass' } };
      throw new Error('ECONNREFUSED');
    };
    const snap = await pollService(svc, { fetchJson, now: NOW });
    assert.equal(snap.source, 'health', 'expected fall-through to health tier');
    assert.equal(snap.status, 'pass');
  });
});
