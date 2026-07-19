'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('../src/server');
const {
  openDatabase,
  upsertPanel,
  getPanelsForService,
  countPanelsForService,
  countPanels,
  countPanelServices,
  listPanelServices,
  listPanels,
} = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-retired-panel-'));
  return openDatabase(path.join(dir, 'test.db'));
}

function panel(panel, label, updatedAt) {
  return {
    service: 'brokkr', panel, kind: 'stat', label, unit: null,
    data: { value: 1 }, updated_at: updatedAt,
  };
}

describe('retired Brokkr m5-memlimits panel', () => {
  let app;
  let db;
  const token = 'panel-retirement-token';
  const savedEnv = {};

  before(async () => {
    savedEnv.HEIMDALL_FLEET_TOKEN = process.env.HEIMDALL_FLEET_TOKEN;
    savedEnv.HEIMDALL_BIND = process.env.HEIMDALL_BIND;
    process.env.HEIMDALL_FLEET_TOKEN = token;
    process.env.HEIMDALL_BIND = '192.0.2.1';

    db = freshDb();
    upsertPanel(db, panel('hw-health', 'Hardware health', 10));
    upsertPanel(db, panel('m5-memlimits', 'm5 OOM prevention', 20));
    upsertPanel(db, panel('photos', 'Photo backup', 30));
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

  it('keeps the stored row for rollback but excludes exactly that panel from every read/count', () => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM panels WHERE service = 'brokkr'").get().n, 3);
    assert.deepEqual(getPanelsForService(db, 'brokkr').map((row) => row.panel), ['hw-health', 'photos']);
    assert.equal(countPanelsForService(db, 'brokkr'), 2);
    assert.equal(countPanels(db), 2);
    assert.equal(countPanelServices(db), 1);
    assert.deepEqual(listPanelServices(db).map(({ service, panels }) => ({ service, panels })), [
      { service: 'brokkr', panels: 2 },
    ]);
    assert.deepEqual(listPanels(db).map((row) => row.panel), ['hw-health', 'photos']);
  });

  it('does not count a service represented only by the retired raw row', () => {
    const retiredOnly = freshDb();
    try {
      upsertPanel(retiredOnly, panel('m5-memlimits', 'm5 OOM prevention', 20));
      assert.equal(countPanelsForService(retiredOnly, 'brokkr'), 0);
      assert.equal(countPanels(retiredOnly), 0);
      assert.equal(countPanelServices(retiredOnly), 0);
      assert.deepEqual(listPanelServices(retiredOnly), []);
    } finally {
      retiredOnly.close();
    }
  });

  it('does not render the retired card while preserving both useful Brokkr panels', async () => {
    const response = await app.inject({ method: 'GET', url: '/services/brokkr' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Hardware health'));
    assert.ok(response.body.includes('Photo backup'));
    assert.ok(!response.body.includes('m5 OOM prevention'));
  });

  it('omits the retired card from panel read-back', async () => {
    const summary = await app.inject({ method: 'GET', url: '/api/panels' });
    assert.equal(summary.statusCode, 200);
    assert.deepEqual(JSON.parse(summary.body).map((row) => row.panel), ['hw-health', 'photos']);

    const full = await app.inject({
      method: 'GET', url: '/api/panels?service=brokkr',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(full.statusCode, 200);
    assert.deepEqual(JSON.parse(full.body).map((row) => row.panel), ['hw-health', 'photos']);
  });

  it('acknowledges future pushes without mutating or reviving the retired row', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/panels',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        service: 'brokkr', panel: 'm5-memlimits', kind: 'stat',
        label: 'revived label', value: 99,
      }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).retired, true);

    const stored = db.prepare(
      "SELECT label, updated_at FROM panels WHERE service = 'brokkr' AND panel = 'm5-memlimits'",
    ).get();
    assert.deepEqual(stored, { label: 'm5 OOM prevention', updated_at: 20 });
    assert.deepEqual(getPanelsForService(db, 'brokkr').map((row) => row.panel), ['hw-health', 'photos']);
  });
});
