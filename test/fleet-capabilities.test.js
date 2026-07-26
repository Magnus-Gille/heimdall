'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handlePush } = require('../src/fleet/ingest');
const { openDatabase, getLatestFleetMetric } = require('../src/db');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-capabilities-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('fleet monitoring-agent capability negotiation', () => {
  it('keeps legacy fleet payloads accepted without a capability envelope', () => {
    const db = tmpDb();
    const result = handlePush(db, { body: { hostname: 'legacy-agent' }, allowInsecureLoopback: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.capability_contract.version, 1);
    db.close();
  });

  it('accepts supported required capabilities and retains Brokkr evidence as observation only', () => {
    const db = tmpDb();
    const body = {
      hostname: 'brokkr-node',
      capability_contract: {
        version: 1,
        required: ['node-capability-freshness', 'lifecycle-result'],
        evidence: {
          'node-capability-freshness': { observed_at: '2026-07-26T00:00:00Z', status: 'fresh' },
          'lifecycle-result': { observed_at: '2026-07-26T00:01:00Z', result: 'completed' },
        },
      },
    };
    const result = handlePush(db, { body, allowInsecureLoopback: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.capability_contract.accepted, ['lifecycle-result', 'node-capability-freshness']);
    assert.equal(result.body.capability_contract.authority, 'observation_only');
    const stored = JSON.parse(getLatestFleetMetric(db, 'brokkr-node').extra);
    assert.deepEqual(stored.capability_evidence, body.capability_contract.evidence);
    db.close();
  });

  it('rejects unsupported required capabilities with a stable diagnostic before persistence', () => {
    const db = tmpDb();
    const result = handlePush(db, {
      body: { hostname: 'new-agent', capability_contract: { version: 1, required: ['topology-authority'] } },
      allowInsecureLoopback: true,
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.error, 'unsupported required capabilities');
    assert.deepEqual(result.body.capability_contract.unsupported_required, ['topology-authority']);
    assert.match(result.body.capability_contract.diagnostic, /not topology or workload authority/i);
    assert.equal(getLatestFleetMetric(db, 'new-agent'), undefined);
    db.close();
  });

  it('rejects a malformed versioned envelope without changing legacy validation', () => {
    const db = tmpDb();
    const result = handlePush(db, {
      body: { hostname: 'bad-agent', capability_contract: { version: 2, required: [] } },
      allowInsecureLoopback: true,
    });
    assert.equal(result.status, 400);
    assert.match(result.body.details.join(' '), /capability_contract.version/);
    db.close();
  });

  it('rejects topology-shaped evidence instead of retaining it as telemetry', () => {
    const db = tmpDb();
    const result = handlePush(db, {
      body: { hostname: 'bad-evidence', capability_contract: { version: 1, required: [], evidence: { topology: { host: 'private' } } } },
      allowInsecureLoopback: true,
    });
    assert.equal(result.status, 400);
    assert.match(result.body.details.join(' '), /not a supported observation/);
    assert.equal(getLatestFleetMetric(db, 'bad-evidence'), undefined);
    db.close();
  });
});
