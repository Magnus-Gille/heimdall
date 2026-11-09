'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRejectionLogger, logRegistryStatus } = require('../src/fleet/producer-auth');
const { handlePush } = require('../src/fleet/ingest');
const { handlePanelIngest } = require('../src/panel-ingest');
const { openDatabase } = require('../src/db');

const ORIN_TOKEN = 'orin-secret-token-AbCd1234';
const M5_TOKEN = 'm5-secret-token-ZyXw9876';
const LEGACY = 'legacy-secret-token-Qq55';
const BAD_TOKEN = 'wrong-secret-token-Hh77Jj';
const REGISTRY = JSON.stringify([
  { id: 'orin-agent', token: ORIN_TOKEN, hosts: ['orin'], services: ['orin-metrics'] },
  { id: 'm5-panels', token: M5_TOKEN, services: ['m5-inference'] },
]);
const SECRETS = [ORIN_TOKEN, M5_TOKEN, LEGACY, BAD_TOKEN];

function derivatives(token) {
  const out = [token, token.slice(0, 8), token.slice(-8), Buffer.from(token).toString('base64'),
    Buffer.from(token).toString('hex')];
  for (const algo of ['sha1', 'sha256', 'md5']) {
    const d = crypto.createHash(algo).update(token);
    out.push(d.copy().digest('hex').slice(0, 8), d.copy().digest('base64').slice(0, 8));
  }
  return out;
}

function tmpDb() {
  return openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-rejlog-')), 'test.db'));
}

function harness() {
  const lines = [];
  let t = 1_000_000;
  const rejectionLog = createRejectionLogger({ log: (l) => lines.push(l), now: () => t });
  return { lines, rejectionLog, advance: (ms) => { t += ms; } };
}

function push(h, db, auth, hostname = 'orin', registry = REGISTRY) {
  return handlePush(db, {
    authHeader: auth, producerRegistryJson: registry, legacyFleetToken: LEGACY,
    body: { hostname, cpu_pct: 1 }, rejectionLog: h.rejectionLog,
  });
}
function panel(h, auth, service, registry = REGISTRY) {
  return handlePanelIngest(tmpDb(), {
    authHeader: auth, producerRegistryJson: registry, legacyFleetToken: LEGACY,
    body: { service, panel: 'p', kind: 'stat', value: 1 },
    rejectionLog: h.rejectionLog,
  });
}

describe('ingest rejection logging', () => {
  it('logs 401 for an unknown token on both endpoints, bodies unchanged', () => {
    const h = harness(); const db = tmpDb();
    const a = push(h, db, `Bearer ${BAD_TOKEN}`);
    const b = panel(h, `Bearer ${BAD_TOKEN}`, 'm5-inference');
    assert.deepEqual([a.status, a.body], [401, { error: 'Unauthorized' }]);
    assert.deepEqual([b.status, b.body], [401, { error: 'Unauthorized' }]);
    const logs = h.lines.map((l) => JSON.parse(l));
    assert.deepEqual(logs.map((l) => [l.status, l.reason, l.producer, l.endpoint]), [
      [401, 'unknown-token', '-', '/api/fleet/push'],
      [401, 'unknown-token', '-', '/api/panels'],
    ]);
  });

  it('logs 403 for a host outside the producer scope', () => {
    const h = harness();
    const r = push(h, tmpDb(), `Bearer ${ORIN_TOKEN}`, 'm5');
    assert.deepEqual([r.status, r.body], [403, { error: 'producer is not authorized for this host' }]);
    assert.deepEqual(JSON.parse(h.lines[0]), {
      event: 'ingest_rejected', status: 403, reason: 'host-not-authorized',
      producer: 'orin-agent', target: 'm5', endpoint: '/api/fleet/push',
    });
  });

  it('logs 403 for a service outside the producer scope', () => {
    const h = harness();
    const r = panel(h, `Bearer ${ORIN_TOKEN}`, 'm5-inference');
    assert.deepEqual([r.status, r.body], [403, { error: 'producer is not authorized for this service' }]);
    assert.deepEqual(JSON.parse(h.lines[0]), {
      event: 'ingest_rejected', status: 403, reason: 'service-not-authorized',
      producer: 'orin-agent', target: 'm5-inference', endpoint: '/api/panels',
    });
  });

  it('logs 503 when the registry is invalid or missing', () => {
    const h = harness(); const db = tmpDb();
    const a = push(h, db, `Bearer ${ORIN_TOKEN}`, 'orin', '{not json');
    const b = panel(h, `Bearer ${ORIN_TOKEN}`, 'm5-inference', '');
    for (const r of [a, b]) assert.deepEqual([r.status, r.body], [503, { error: 'producer ingest is not configured' }]);
    assert.deepEqual(h.lines.map((l) => JSON.parse(l).reason), ['registry-unavailable', 'registry-unavailable']);
    assert.deepEqual(h.lines.map((l) => JSON.parse(l).status), [503, 503]);
  });

  it('never logs a token, derivative or Authorization header on any path', () => {
    const h = harness(); const db = tmpDb();
    const captured = [];
    const origLog = console.log; const origWarn = console.warn; const origErr = console.error; const origInfo = console.info;
    for (const k of ['log', 'warn', 'error', 'info']) console[k] = (...a) => captured.push(a.join(' '));
    try {
      const headers = [`Bearer ${BAD_TOKEN}`, `Bearer ${ORIN_TOKEN}`, `Bearer ${LEGACY}`, `Basic ${BAD_TOKEN}`, BAD_TOKEN, ''];
      for (const hd of headers) {
        push(h, db, hd); push(h, db, hd, 'm5'); push(h, db, hd, 'orin', '{bad');
        panel(h, hd, 'm5-inference'); panel(h, hd, 'orin-metrics', 'nope');
      }
      logRegistryStatus('{bad', LEGACY);
      logRegistryStatus(JSON.stringify([{ id: 'x', token: ORIN_TOKEN }]), LEGACY);
      logRegistryStatus(REGISTRY, LEGACY);
    } finally { Object.assign(console, { log: origLog, warn: origWarn, error: origErr, info: origInfo }); }

    const all = [...h.lines, ...captured].join('\n');
    assert.ok(all.length > 0 && h.lines.length > 0 && captured.length === 3);
    for (const secret of SECRETS) {
      for (const d of derivatives(secret)) assert.ok(!all.includes(d), `log leaked derivative of a token: ${d.length} chars`);
    }
    assert.ok(!/authorization|bearer|basic /i.test(all), 'Authorization header material in logs');
  });

  it('rate limits: first per key logged, then a suppressed count per window', () => {
    const h = harness(); const db = tmpDb();
    for (let i = 0; i < 5; i += 1) push(h, db, `Bearer ${BAD_TOKEN}`);
    assert.equal(h.lines.length, 1);
    push(h, db, `Bearer ${ORIN_TOKEN}`, 'm5'); // different key, logged
    assert.equal(h.lines.length, 2);
    h.advance(60_001);
    push(h, db, `Bearer ${BAD_TOKEN}`);
    assert.equal(h.lines.length, 3);
    const summary = JSON.parse(h.lines[2]);
    assert.equal(summary.suppressed_since_last, 4);
    assert.equal(summary.window_s, 60);
    h.advance(60_001);
    push(h, db, `Bearer ${BAD_TOKEN}`);
    assert.equal(JSON.parse(h.lines[3]).suppressed_since_last, undefined);
  });

  it('bounds its key table under many distinct targets', () => {
    const h = harness(); const db = tmpDb();
    for (let i = 0; i < 1000; i += 1) {
      push(h, db, `Bearer ${ORIN_TOKEN}`, `host-${i}`);
    }
    assert.ok(h.lines.length <= 257);
  });
});

describe('registry startup line', () => {
  const capture = () => {
    const out = [];
    return { out, log: { info: (l) => out.push(['info', l]), warn: (l) => out.push(['warn', l]) } };
  };
  it('reports ok with producer count', () => {
    const c = capture();
    assert.equal(logRegistryStatus(REGISTRY, LEGACY, c.log), true);
    assert.deepEqual(c.out, [['info', 'producer ingest registry ok: 2 producer(s)']]);
  });
  it('warns loudly when invalid, without a reason', () => {
    for (const raw of ['', '{bad', JSON.stringify([{ id: 'x', token: ORIN_TOKEN }])]) {
      const c = capture();
      assert.equal(logRegistryStatus(raw, LEGACY, c.log), false);
      assert.equal(c.out[0][0], 'warn');
      assert.match(c.out[0][1], /INVALID or missing.*503/);
      assert.ok(!c.out[0][1].includes(ORIN_TOKEN));
    }
  });
});
