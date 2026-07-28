'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateMaintenanceExecutionResult, displayState, autonomyDigest } = require('../src/maintenance-execution-result');
const { renderMaintenanceExecutionResult } = require('../src/render/maintenance-execution-result');
const { openDatabase, upsertMaintenanceExecutionResult, markUnsupportedMaintenanceExecutionResult, getMaintenanceExecutionResult, upsertServiceSnapshot, getServiceSnapshot } = require('../src/db');
const { handleMaintenanceExecutionIngest } = require('../src/maintenance-execution-ingest');
const { buildApp } = require('../src/server');
const fixtures = path.join(__dirname, 'fixtures', 'maintenance-execution-result');
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const now = Date.parse('2026-07-28T11:30:00Z');
function setPath(value, dotted, replacement) {
  const parts = dotted.split('.'); let cursor = value;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = replacement;
}

describe('maintenance execution result v1', () => {
  it('pins the exact merged Brokkr #79 schema bytes', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'docs', 'vendor', 'maintenance-execution-result-v1', 'maintenance-execution-result-v1.schema.json'));
    const hash = require('node:crypto').createHash('sha256').update(schema).digest('hex');
    assert.equal(hash, '7dc0510e413ae6634b1eaa9738f30668727b9e5d4bc210b89c857934ba06b312');
  });
  for (const name of ['clean.json', 'unknown.json', 'stale.json', 'unreconciled.json', 'failed.json', 'recovered-by-worker.json', 'disarmed.json', 'terminally-blocked.json']) {
    it(`accepts canonical producer fixture ${name}`, () => assert.equal(validateMaintenanceExecutionResult(load(name), now).ok, true));
  }
  it('rejects every adversarial producer fixture and digest/shape mutations', () => {
    const negative = load('negative.json');
    for (const test of negative.cases) {
      const value = load(negative.base);
      for (const [key, replacement] of Object.entries(test.mutations)) setPath(value, key, replacement);
      assert.equal(validateMaintenanceExecutionResult(value, now).ok, false, test.id);
    }
    const r = load('clean.json'); r.phase = 'recover';
    assert.equal(validateMaintenanceExecutionResult(r, now).ok, false);
  });
  it('uses the trusted local clock for the stale boundary', () => {
    const r = load('clean.json'); assert.equal(displayState(r, Date.parse(r.freshness.valid_until)), 'stale');
  });
  it('rejects any future observation and accepts producer-valid fractional journal time', () => {
    const future = load('clean.json');
    future.freshness.evaluated_at = '2026-07-28T11:30:01Z';
    future.result_digest = autonomyDigest(future, 'result_digest');
    assert.equal(validateMaintenanceExecutionResult(future, now).ok, false);

    const fractional = load('unknown.json');
    fractional.journal.tail_recorded_at = '2026-07-28T10:01:00.123Z';
    fractional.result_digest = autonomyDigest(fractional, 'result_digest');
    assert.equal(validateMaintenanceExecutionResult(fractional, now).ok, true);
  });
  it('rejects recomputed semantic contradictions rather than relying on the outer digest', () => {
    const falseHealth = load('unknown.json');
    falseHealth.health = 'healthy';
    falseHealth.promotion_eligible = true;
    falseHealth.result_digest = autonomyDigest(falseHealth, 'result_digest');
    assert.equal(validateMaintenanceExecutionResult(falseHealth, now).ok, false);

    const badReceipt = load('clean.json');
    badReceipt.receipt.binding_digest = `sha256:${'9'.repeat(64)}`;
    badReceipt.receipt.receipt_digest = autonomyDigest(badReceipt.receipt, 'receipt_digest');
    badReceipt.result_digest = autonomyDigest(badReceipt, 'result_digest');
    assert.equal(validateMaintenanceExecutionResult(badReceipt, now).ok, false);

    const coercedId = load('clean.json');
    coercedId.receipt.receipt_id = ['maintenance-receipt'];
    coercedId.receipt.receipt_digest = autonomyDigest(coercedId.receipt, 'receipt_digest');
    coercedId.result_digest = autonomyDigest(coercedId, 'result_digest');
    assert.equal(validateMaintenanceExecutionResult(coercedId, now).ok, false);

    const tooDeep = load('clean.json');
    let nested = {};
    for (let i = 0; i < 70; i++) nested = { child: nested };
    tooDeep.source.source_revision_digest = nested;
    assert.equal(validateMaintenanceExecutionResult(tooDeep, now).ok, false);
  });
  it('never renders unvalidated stored JSON as healthy and escapes display fields', () => {
    const bad = load('clean.json'); bad.source.source_id = '<script>'; assert.match(renderMaintenanceExecutionResult({ state: 'valid', result: bad }, now), /Execution evidence: unknown/);
    assert.match(renderMaintenanceExecutionResult({ state: 'missing' }, now), /Execution evidence: unknown/);
    assert.match(renderMaintenanceExecutionResult({ state: 'unsupported', schema_version: '<script>' }, now), /&lt;script&gt;/);
  });
  it('renders execution evidence without claiming policy compliance', () => {
    const html = renderMaintenanceExecutionResult({ state: 'valid', result: load('clean.json') }, now);
    assert.match(html, /Execution evidence: healthy/);
    assert.match(html, /Policy compliance.*not reported by v1/);
    assert.doesNotMatch(html, /Compliance: compliant/);
  });
  it('keeps only a monotonic epoch, permits canonical replays, and preserves an unsupported floor', () => {
    const db = openDatabase(path.join(require('node:os').tmpdir(), `heimdall-maintenance-${process.pid}-${Date.now()}.db`));
    const first = load('clean.json');
    assert.equal(upsertMaintenanceExecutionResult(db, first).ok, true);
    const reordered = JSON.parse(JSON.stringify(first));
    reordered.source = { configuration_digest: reordered.source.configuration_digest, source_id: reordered.source.source_id, source_revision_digest: reordered.source.source_revision_digest };
    assert.equal(upsertMaintenanceExecutionResult(db, reordered).replay, true);
    const conflict = load('clean.json'); conflict.result_digest = `sha256:${'b'.repeat(64)}`;
    assert.equal(upsertMaintenanceExecutionResult(db, conflict).code, 'epoch_conflict');
    assert.equal(markUnsupportedMaintenanceExecutionResult(db, 'brokkr-maintenance', 'unsupported').ok, true);
    assert.equal(getMaintenanceExecutionResult(db).state, 'unsupported');
    assert.equal(getMaintenanceExecutionResult(db).schema_version, 'unknown');
    assert.equal(upsertMaintenanceExecutionResult(db, first).code, 'epoch_conflict');
    const older = load('clean.json'); older.execution_epoch = 6;
    assert.equal(upsertMaintenanceExecutionResult(db, older).code, 'older_epoch');
    db.close();
  });
  it('fails closed on dedicated auth, wrong source, and records no unsupported body', () => {
    const db = openDatabase(path.join(require('node:os').tmpdir(), `heimdall-maintenance-ingest-${process.pid}-${Date.now()}.db`));
    const body = load('clean.json');
    assert.equal(handleMaintenanceExecutionIngest(db, { body, bindHost: '127.0.0.1', allowInsecureLoopback: true }).status, 401);
    assert.equal(handleMaintenanceExecutionIngest(db, { body, token: 'correct', authHeader: 'Bearer wrong' }).status, 401);
    assert.equal(handleMaintenanceExecutionIngest(db, {
      body: { kind: 'maintenance-execution-result' },
      token: 'correct', authHeader: 'Bearer correct', now,
    }).status, 400);
    const wrongSource = JSON.parse(JSON.stringify(body)); wrongSource.source.source_id = 'not-brokkr';
    assert.equal(handleMaintenanceExecutionIngest(db, { body: wrongSource, token: 'correct', authHeader: 'Bearer correct', now }).status, 400);
    const unsupported = { kind: 'maintenance-execution-result', source: { source_id: 'brokkr-maintenance' }, schema_version: 'v999', secret: 'never stored' };
    assert.equal(handleMaintenanceExecutionIngest(db, { body: unsupported, token: 'correct', authHeader: 'Bearer correct', now }).status, 422);
    const stored = getMaintenanceExecutionResult(db); assert.equal(stored.state, 'unsupported'); assert.equal(stored.schema_version, 'v999'); assert.doesNotMatch(stored.result, /never stored/);
    db.close();
  });
  it('enforces auth and the 64 KiB limit through the actual Fastify route', async () => {
    const db = openDatabase(path.join(require('node:os').tmpdir(), `heimdall-maintenance-route-${process.pid}-${Date.now()}.db`));
    const previousToken = process.env.HEIMDALL_MAINTENANCE_RESULT_TOKEN;
    process.env.HEIMDALL_MAINTENANCE_RESULT_TOKEN = 'route-token';
    const { app } = buildApp(db, { now: () => now });
    await app.ready();
    try {
      const missing = await app.inject({
        method: 'POST', url: '/api/maintenance-execution-results',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(load('clean.json')),
      });
      assert.equal(missing.statusCode, 401);

      const accepted = await app.inject({
        method: 'POST', url: '/api/maintenance-execution-results',
        headers: { 'content-type': 'application/json', authorization: 'Bearer route-token' },
        body: JSON.stringify(load('clean.json')),
      });
      assert.equal(accepted.statusCode, 200);

      const tooLarge = await app.inject({
        method: 'POST', url: '/api/maintenance-execution-results',
        headers: { 'content-type': 'application/json', authorization: 'Bearer route-token' },
        body: JSON.stringify({ kind: 'maintenance-execution-result', schema_version: 'v2', padding: 'x'.repeat(70 * 1024) }),
      });
      assert.equal(tooLarge.statusCode, 413);

      const unsupported = await app.inject({
        method: 'POST', url: '/api/maintenance-execution-results',
        headers: { 'content-type': 'application/json', authorization: 'Bearer route-token' },
        body: JSON.stringify({ kind: 'maintenance-execution-result', schema_version: 'v2' }),
      });
      assert.equal(unsupported.statusCode, 422);
      assert.equal(getMaintenanceExecutionResult(db).schema_version, 'v2');

      upsertServiceSnapshot(db, {
        service: 'brokkr', kind: 'timer', status: 'pass', reachable: true,
        source: 'test', fetchedAt: '2026-07-28T11:29:00Z',
        descriptor: {
          service: { name: 'brokkr', label: 'Brokkr' },
          kind: 'timer', status: 'pass', metrics: [], panels: [], links: {},
        },
      });
      const page = await app.inject({ method: 'GET', url: '/services/brokkr' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Maintenance evidence/);
      assert.match(page.body, /Execution evidence: unknown — unsupported version/);
      assert.equal(getServiceSnapshot(db, 'brokkr').status, 'pass');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0);
    } finally {
      await app.close();
      db.close();
      if (previousToken === undefined) delete process.env.HEIMDALL_MAINTENANCE_RESULT_TOKEN;
      else process.env.HEIMDALL_MAINTENANCE_RESULT_TOKEN = previousToken;
    }
  });
});
