'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyHealth, probeTicketSystem, collectTicketSystemHealth,
  buildTicketSystemDescriptor, ticketSystemSnapshot,
} = require('../src/ticket-system');
const { openDatabase } = require('../src/db');
const { runAlertEngine } = require('../src/alert-engine');
const DB = require('../src/db');

const respond = (status, body) => async () => ({
  status,
  json: async () => { if (body === undefined) throw new Error('not json'); return body; },
});

test('classifyHealth distinguishes gateway and plane', () => {
  assert.deepStrictEqual(classifyHealth({ status: 'ok', plane: { reachable: true } }), { gateway: true, plane: true });
  assert.deepStrictEqual(classifyHealth({ status: 'ok', plane: { reachable: false } }), { gateway: true, plane: false });
  assert.deepStrictEqual(classifyHealth({ status: 'ok' }), { gateway: true, plane: false });
  assert.deepStrictEqual(classifyHealth({ status: 'down', plane: { reachable: true } }), { gateway: false, plane: false });
  assert.deepStrictEqual(classifyHealth(null), { gateway: false, plane: false });
});

test('probe: unconfigured is skipped, not failed', async () => {
  const r = await probeTicketSystem('', respond(200, {}));
  assert.strictEqual(r.configured, false);
});

test('probe: healthy, plane unreachable, http error, non-json, network error', async () => {
  const u = 'http://gw.test/health';
  let r = await probeTicketSystem(u, respond(200, { status: 'ok', plane: { reachable: true } }));
  assert.ok(r.gateway_healthy && r.plane_healthy && r.error === null);
  r = await probeTicketSystem(u, respond(200, { status: 'ok', plane: { reachable: false } }));
  assert.ok(r.gateway_healthy && !r.plane_healthy);
  assert.match(r.error, /plane unreachable/);
  r = await probeTicketSystem(u, respond(502, {}));
  assert.ok(!r.gateway_healthy && !r.plane_healthy);
  assert.match(r.error, /HTTP 502/);
  r = await probeTicketSystem(u, respond(302, {})); // e.g. an Access login redirect
  assert.ok(!r.gateway_healthy);
  r = await probeTicketSystem(u, respond(200));
  assert.ok(!r.gateway_healthy);
  assert.match(r.error, /not JSON/);
  r = await probeTicketSystem(u, async () => { throw new Error('ECONNREFUSED'); });
  assert.ok(!r.gateway_healthy);
  assert.match(r.error, /ECONNREFUSED/);
});

function cycle(db, n, body) {
  const ts = new Date(Date.UTC(2026, 10, 16, 12, n)).toISOString();
  return collectTicketSystemHealth(db, ts, 'http://gw.test/health', respond(200, body));
}

test('two failed polls fire the alert, recovery resolves it; sub-streak does not fire', async () => {
  const db = openDatabase(':memory:');
  DB.upsertServiceSnapshot(db, ticketSystemSnapshot(db));
  const down = { status: 'ok', plane: { reachable: false } };
  const up = { status: 'ok', plane: { reachable: true } };
  const active = () => DB.getActiveAlerts ? DB.getActiveAlerts(db).map((a) => a.title) : [];

  await cycle(db, 1, up); runAlertEngine(db);
  await cycle(db, 2, down); runAlertEngine(db);
  assert.deepStrictEqual(active(), []);
  await cycle(db, 3, down); runAlertEngine(db);
  assert.deepStrictEqual(active(), ['Plane unreachable from ticket gateway']);
  await cycle(db, 4, up); runAlertEngine(db);
  assert.deepStrictEqual(active(), []);
  await cycle(db, 5, { status: 'bad' }); await cycle(db, 6, { status: 'bad' }); runAlertEngine(db);
  assert.ok(active().includes('Ticket gateway unhealthy'));
});

test('snapshot is null-status until polled, then pass/fail', async () => {
  const db = openDatabase(':memory:');
  assert.strictEqual(ticketSystemSnapshot(db).status, null);
  await cycle(db, 1, { status: 'ok', plane: { reachable: true } });
  assert.strictEqual(ticketSystemSnapshot(db).status, 'pass');
  await cycle(db, 2, { status: 'ok', plane: { reachable: false } });
  assert.strictEqual(ticketSystemSnapshot(db).status, 'fail');
  assert.strictEqual(buildTicketSystemDescriptor().alerts.rules.length, 2);
});

test('gateway outage raises only the gateway alert, not a false Plane alert', async () => {
  const db = openDatabase(':memory:');
  DB.upsertServiceSnapshot(db, ticketSystemSnapshot(db));
  await cycle(db, 1, { status: 'bad' }); await cycle(db, 2, { status: 'bad' }); runAlertEngine(db);
  const titles = DB.getActiveAlerts(db).map((a) => a.title);
  assert.deepStrictEqual(titles, ['Ticket gateway unhealthy']);
  assert.strictEqual(ticketSystemSnapshot(db).status, 'fail');
});
