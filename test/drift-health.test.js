'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { collectServiceDrift } = require('../src/drift');

test('collectServiceDrift persists non-OK HTTP health as unhealthy', async () => {
  const db = openDatabase(':memory:');
  try {
    const results = await collectServiceDrift(db, {
      services: [{ name: 'probe-fixture', host: 'control-node', health_url: 'http://probe-fixture/health' }],
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ status: 'ok', version: 'stamped-commit' }),
      }),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].health_status, 'unhealthy');
    assert.equal(results[0].health_reason, 'HTTP 503');
    const row = db.prepare(`
      SELECT deployed_commit, health_status, health_reason
      FROM service_versions WHERE service = ?
    `).get('probe-fixture');
    assert.equal(row.deployed_commit, 'stamped-commit');
    assert.equal(row.health_status, 'unhealthy');
    assert.equal(row.health_reason, 'HTTP 503');
  } finally {
    db.close();
  }
});
