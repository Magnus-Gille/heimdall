'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadProducerRegistry,
  authenticateProducer,
  authorizeProducerHost,
  authorizeProducerService,
} = require('../src/fleet/producer-auth');
const { handlePush } = require('../src/fleet/ingest');
const { handlePanelIngest } = require('../src/panel-ingest');
const { openDatabase, getFleetHosts, getPanelsForService } = require('../src/db');
const { buildApp } = require('../src/server');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-producer-auth-'));
  return openDatabase(path.join(dir, 'test.db'));
}

const REGISTRY = JSON.stringify([
  { id: 'orin-agent', token: 'orin-only-token', hosts: ['orin'], services: ['orin-metrics'] },
  { id: 'm5-panels', token: 'm5-panel-token', services: ['m5-inference'] },
]);

describe('scoped ingest producer registry', () => {
  it('loads explicit host and service scopes without exposing secret values', () => {
    const result = loadProducerRegistry(REGISTRY, 'legacy-operator-token');
    assert.equal(result.ok, true);
    assert.deepEqual(result.producers.map(({ id, hosts, services }) => ({ id, hosts, services })), [
      { id: 'orin-agent', hosts: ['orin'], services: ['orin-metrics'] },
      { id: 'm5-panels', hosts: [], services: ['m5-inference'] },
    ]);
    assert.equal(JSON.stringify(result).includes('orin-only-token'), false);
  });

  it('rejects a missing, malformed, empty, or unsafe registry as a whole', () => {
    for (const value of [undefined, '', '{bad', '{}', '[]']) {
      const result = loadProducerRegistry(value, 'legacy-operator-token');
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /legacy-operator-token|orin-only-token/);
    }
    for (const record of [
      { id: 'bad ID', token: 'secret', hosts: ['orin'] },
      { id: 'bad-host', token: 'secret', hosts: ['bad host'] },
      { id: 'bad-service', token: 'secret', services: ['Bad-service'] },
      { id: 'empty-scopes', token: 'secret', hosts: [], services: [] },
      { id: 'empty-token', token: '  ', hosts: ['orin'] },
      { id: 'newline-token', token: 'bad\ntoken', hosts: ['orin'] },
      { id: 'unknown-key', token: 'secret', hosts: ['orin'], extra: true },
    ]) {
      assert.equal(loadProducerRegistry(JSON.stringify([record]), 'legacy-operator-token').ok, false);
    }
  });

  it('rejects duplicate ids, duplicate tokens, and legacy shared-token reuse', () => {
    const one = { id: 'first', token: 'same-token', hosts: ['orin'] };
    const sameId = { id: 'first', token: 'other-token', services: ['svc'] };
    const sameToken = { id: 'second', token: 'same-token', services: ['svc'] };
    assert.equal(loadProducerRegistry(JSON.stringify([one, sameId]), 'legacy').ok, false);
    assert.equal(loadProducerRegistry(JSON.stringify([one, sameToken]), 'legacy').ok, false);
    assert.equal(loadProducerRegistry(JSON.stringify([one]), 'same-token').ok, false);
  });

  it('authenticates a producer before matching canonical host aliases', () => {
    const auth = authenticateProducer('Bearer orin-only-token', REGISTRY, 'legacy-operator-token');
    assert.equal(auth.ok, true);
    assert.equal(authorizeProducerHost(auth.producer, 'ORIN-NANO.local', { 'orin-nano': 'orin' }).ok, true);
    assert.equal(authorizeProducerHost(auth.producer, 'm5', { 'orin-nano': 'orin' }).ok, false);
    assert.equal(authorizeProducerService(auth.producer, 'orin-metrics').ok, true);
    assert.equal(authorizeProducerService(auth.producer, 'm5-inference').ok, false);
  });
});

describe('scoped fleet and panel ingest', () => {
  it('allows only the authenticated host after canonical alias comparison and keeps raw host history', () => {
    const db = tmpDb();
    try {
      const options = {
        authHeader: 'Bearer orin-only-token', producerRegistryJson: REGISTRY,
        legacyFleetToken: 'legacy-operator-token', aliases: { 'orin-nano': 'orin' },
      };
      const allowed = handlePush(db, { ...options, body: { hostname: 'ORIN-NANO.local', cpu_pct: 31 } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.hostname, 'ORIN-NANO.local');
      assert.equal(getFleetHosts(db).some((host) => host.hostname === 'ORIN-NANO.local'), true);

      const denied = handlePush(db, { ...options, body: { hostname: 'm5', cpu_pct: 99 } });
      assert.equal(denied.status, 403);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_metrics').get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE host = 'm5'").get().n, 0);
    } finally { db.close(); }
  });

  it('fails closed for missing/invalid config, wrong credentials, legacy-token writers, and loopback bypass attempts', () => {
    const db = tmpDb();
    try {
      const body = { hostname: 'orin', cpu_pct: 12 };
      for (const options of [
        { authHeader: 'Bearer orin-only-token' },
        { authHeader: 'Bearer orin-only-token', producerRegistryJson: '{bad' },
        { authHeader: 'Bearer wrong', producerRegistryJson: REGISTRY },
        { authHeader: 'Bearer legacy-operator-token', producerRegistryJson: REGISTRY },
        { authHeader: '', producerRegistryJson: REGISTRY, allowInsecureLoopback: true },
      ]) {
        const result = handlePush(db, { ...options, legacyFleetToken: 'legacy-operator-token', body });
        assert.notEqual(result.status, 200);
      }
      assert.equal(getFleetHosts(db).length, 0);
    } finally { db.close(); }
  });

  it('authorizes panels by exact stored service before touching retirement, counts, or writes', () => {
    const db = tmpDb();
    let countCalls = 0;
    try {
      const result = handlePanelIngest(db, {
        authHeader: 'Bearer m5-panel-token', producerRegistryJson: REGISTRY,
        legacyFleetToken: 'legacy-operator-token',
        body: { service: 'orin-metrics', panel: 'health', kind: 'stat', value: 1 },
        countPanelsFn: () => { countCalls += 1; return 0; },
        countTotalFn: () => { countCalls += 1; return 0; },
        countServicesFn: () => { countCalls += 1; return 0; },
      });
      assert.equal(result.status, 403);
      assert.equal(countCalls, 0);
      assert.deepEqual(getPanelsForService(db, 'orin-metrics'), []);
    } finally { db.close(); }
  });
});

describe('scoped producer HTTP routes', () => {
  let app;
  let db;
  const operatorToken = 'http-operator-read-token';
  const producerA = 'http-producer-a-token';
  const producerB = 'http-producer-b-token';
  const validRegistry = JSON.stringify([
    { id: 'producer-a', token: producerA, hosts: ['host-a'], services: ['service-a'] },
    { id: 'producer-b', token: producerB, hosts: ['host-b'], services: ['service-b'] },
  ]);
  const savedEnv = {};

  before(async () => {
    for (const key of [
      'HEIMDALL_FLEET_TOKEN', 'HEIMDALL_INGEST_PRODUCERS_JSON', 'HEIMDALL_BIND',
      'HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK',
    ]) savedEnv[key] = process.env[key];
    process.env.HEIMDALL_FLEET_TOKEN = operatorToken;
    process.env.HEIMDALL_INGEST_PRODUCERS_JSON = validRegistry;
    process.env.HEIMDALL_BIND = '127.0.0.1';
    process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK = '1';
    db = tmpDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const postFleet = (hostname, token) => app.inject({
    method: 'POST', url: '/api/fleet/push',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ hostname, cpu_pct: 12 }),
  });
  const postPanel = (service, token) => app.inject({
    method: 'POST', url: '/api/panels',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ service, panel: 'health', kind: 'stat', value: 1 }),
  });

  it('scopes fleet writes by canonical host', async () => {
    const allowed = await postFleet('HOST-A.local', producerA);
    assert.equal(allowed.statusCode, 200);

    const denied = await postFleet('host-b', producerA);
    assert.equal(denied.statusCode, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_metrics').get().n, 1);

    process.env.HEIMDALL_INGEST_PRODUCERS_JSON = validRegistry;
  });

  it('scopes panel writes and full reads by exact service while preserving operator read-only access', async () => {
    assert.equal((await postPanel('service-a', producerA)).statusCode, 200);
    assert.equal((await postPanel('service-b', producerA)).statusCode, 403);
    assert.equal((await postPanel('service-b', producerB)).statusCode, 200);

    const readOwn = await app.inject({
      method: 'GET', url: '/api/panels?service=service-a',
      headers: { authorization: `Bearer ${producerA}` },
    });
    assert.equal(readOwn.statusCode, 200);
    assert.ok(JSON.parse(readOwn.body)[0].data);

    const readSibling = await app.inject({
      method: 'GET', url: '/api/panels?service=service-b',
      headers: { authorization: `Bearer ${producerA}` },
    });
    assert.equal(readSibling.statusCode, 403);

    const wrongCredential = await app.inject({
      method: 'GET', url: '/api/panels?service=service-a',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongCredential.statusCode, 401);

    const operatorRead = await app.inject({
      method: 'GET', url: '/api/panels?service=service-b',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(operatorRead.statusCode, 200);
    assert.ok(JSON.parse(operatorRead.body)[0].data);
    assert.equal((await postPanel('service-a', operatorToken)).statusCode, 401);

    const summary = await app.inject({ method: 'GET', url: '/api/panels?service=service-a' });
    assert.equal(summary.statusCode, 200);
    assert.equal(JSON.parse(summary.body)[0].data, undefined);
  });

  it('fails closed on invalid producer config and tokenless loopback writes without touching the DB', async () => {
    const beforeFleet = db.prepare('SELECT COUNT(*) AS n FROM fleet_metrics').get().n;
    const beforePanels = db.prepare('SELECT COUNT(*) AS n FROM panels').get().n;
    assert.equal((await postFleet('host-a', null)).statusCode, 401);
    assert.equal((await postPanel('service-a', null)).statusCode, 401);
    process.env.HEIMDALL_INGEST_PRODUCERS_JSON = '{bad';

    const badFleet = await postFleet('host-a', producerA);
    assert.equal(badFleet.statusCode, 503);
    const badPanel = await postPanel('service-a', producerA);
    assert.equal(badPanel.statusCode, 503);
    assert.equal((await postFleet('host-a', null)).statusCode, 503);
    assert.equal((await postPanel('service-a', null)).statusCode, 503);
    const badFullRead = await app.inject({
      method: 'GET', url: '/api/panels?service=service-a',
      headers: { authorization: `Bearer ${producerA}` },
    });
    assert.equal(badFullRead.statusCode, 503);
    const operatorRead = await app.inject({
      method: 'GET', url: '/api/panels?service=service-a',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(operatorRead.statusCode, 200, 'operator read access does not depend on producer configuration');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_metrics').get().n, beforeFleet);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM panels').get().n, beforePanels);
  });
});
