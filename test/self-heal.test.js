'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  openDatabase,
  insertMetrics,
  insertServiceVersion,
  getActiveAlerts,
} = require('../src/db');
const {
  checkAndHeal,
  buildDiagnosisTaskContent,
  DEFAULT_SELF_HEAL_SERVICES,
} = require('../src/self-heal');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpDb() {
  const dir = tmpDir('heimdall-self-heal-db-');
  return openDatabase(path.join(dir, 'heimdall.db'));
}

function tmpJson(obj) {
  const dir = tmpDir('heimdall-self-heal-json-');
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

async function withEnabledEnv(fn) {
  const previous = process.env.HEIMDALL_SELF_HEAL_ENABLED;
  process.env.HEIMDALL_SELF_HEAL_ENABLED = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HEIMDALL_SELF_HEAL_ENABLED;
    else process.env.HEIMDALL_SELF_HEAL_ENABLED = previous;
  }
}

function activeSelfHealAlert(db, service) {
  return getActiveAlerts(db).find((row) => row.title.includes(service));
}

function makeRegistry({ serviceName = 'hugin', host = 'control-node', port = 3032, unit = 'hugin' } = {}) {
  return {
    components: [
      {
        name: serviceName,
        repo: serviceName,
        host,
        port,
        deploy_path: `/srv/${serviceName}`,
        systemd_units: [{ name: unit, type: 'service' }],
      },
    ],
  };
}

function makeOverlay({
  serviceName = 'hugin',
  healthUrl = 'http://control-node.internal:3032/health',
  sshHost,
  aliases = {},
} = {}) {
  const service = { name: serviceName, health_url: healthUrl };
  if (sshHost !== undefined) service.ssh_host = sshHost;
  return {
    services: [service],
    fleet: { host_aliases: aliases },
  };
}

async function runEnabled(db, {
  serviceName = 'hugin',
  services,
  nowMs = Date.parse('2026-08-01T12:00:00Z'),
  grimnir = makeRegistry({ serviceName }),
  overlay = makeOverlay({ serviceName }),
  rpcResult = true,
  rpc,
  state,
  healthEvidenceLoader,
  restartEvidenceLoader,
  logger,
  saveState,
  pendingReservationTtlMs,
  resetReservations,
} = {}) {
  const writes = [];
  let savedState = null;
  const result = await withEnabledEnv(() => checkAndHeal(db, {
    nowMs,
    services: Array.isArray(services) && services.length ? services : [serviceName],
    grimnirPath: grimnir ? tmpJson(grimnir) : '/no/such/grimnir.json',
    configPath: overlay ? tmpJson(overlay) : '/no/such/heimdall-config.json',
    rpc: async (method, args) => {
      writes.push({ method, args });
      if (typeof rpc === 'function') return rpc(method, args);
      return rpcResult;
    },
    state,
    healthEvidenceLoader,
    restartEvidenceLoader,
    pendingReservationTtlMs,
    resetReservations,
    saveState(next) {
      savedState = JSON.parse(JSON.stringify(next));
      if (typeof saveState === 'function') return saveState(next);
    },
    logger: logger || { log() {}, warn() {}, error() {} },
  }));
  return { result, writes, savedState };
}

function insertRestartMetric(db, { serviceName = 'hugin', value = 0, timestamp = '2026-08-01T12:00:00Z' } = {}) {
  insertMetrics(db, [{
    timestamp,
    host: 'control-node',
    metric: `service_restarts_24h_${serviceName.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    value,
    unit: 'count',
    metadata: null,
  }]);
}

function createMuninStub() {
  const entries = new Map();
  const calls = [];
  let updatedCounter = 0;

  return {
    entries,
    calls,
    async rpc(method, args) {
      calls.push({ method, args });

      if (method === 'memory_write') {
        const entryKey = `${args.namespace}\u0000${args.key}`;
        const existing = entries.get(entryKey);
        if (args.create_if_absent === true) {
          if (existing) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({
                error: 'conflict',
                conflict_reason: 'already_exists',
                current_updated_at: existing.updated_at,
              }) }],
            };
          }
        }

        const updatedAt = `2026-08-01T12:00:${String(updatedCounter).padStart(2, '0')}Z`;
        updatedCounter += 1;
        entries.set(entryKey, {
          namespace: args.namespace,
          key: args.key,
          content: args.content,
          tags: args.tags || [],
          updated_at: updatedAt,
        });
        return { updated_at: updatedAt };
      }

      if (method === 'memory_read') {
        const entry = entries.get(`${args.namespace}\u0000${args.key}`);
        return {
          content: [{
            text: JSON.stringify(entry
              ? {
                found: true,
                namespace: entry.namespace,
                key: entry.key,
                content: entry.content,
                updated_at: entry.updated_at,
              }
              : {
                found: false,
                namespace: args.namespace,
                key: args.key,
              }),
          }],
        };
      }

      return { ok: true };
    },
  };
}

function parseHuginMetadata(content) {
  const [header] = content.split(/\n\n/u, 1);
  const fields = new Map();
  for (const line of header.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z -]*):\s*(.+)$/u);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

function extractContextRefs(content) {
  const fields = parseHuginMetadata(content);
  const raw = fields.get('Context-refs');
  assert.ok(raw, 'task content must include Hugin Context-refs');
  const refs = raw.split(/,\s*/u).filter(Boolean);
  assert.ok(refs.length > 0, 'task content must include at least one context ref');
  for (const ref of refs) {
    assert.match(ref, /^(?:[a-z0-9][a-z0-9-]*\/)+[a-z0-9][a-z0-9-]*$/u);
  }
  return refs;
}

function seedReservation(db, {
  service = 'hugin',
  phase = 'pending',
  taskId = '20260801110000-heal-hugin',
  reservedAt = '2026-08-01T11:00:00Z',
  expiresAt = '2026-08-01T11:10:00Z',
  submittedAt = null,
  updatedAt = reservedAt,
} = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_heal_reservations (
      service TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      expires_at TEXT,
      submitted_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO self_heal_reservations (
      service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(service, phase, taskId, reservedAt, expiresAt, submittedAt, updatedAt);
}

function readReservation(db, service = 'hugin') {
  try {
    return db.prepare(`
      SELECT service, phase, task_id, reserved_at, expires_at, submitted_at, updated_at
      FROM self_heal_reservations
      WHERE service = ?
    `).get(service) || null;
  } catch {
    return null;
  }
}

test('self-heal is disabled by default without touching the database', async () => {
  const previous = process.env.HEIMDALL_SELF_HEAL_ENABLED;
  delete process.env.HEIMDALL_SELF_HEAL_ENABLED;
  try {
    const result = await checkAndHeal({
      prepare() { throw new Error('database must not be read while disabled'); },
    });
    assert.deepEqual(result, { enabled: false, tasksSubmitted: 0 });
  } finally {
    if (previous === undefined) delete process.env.HEIMDALL_SELF_HEAL_ENABLED;
    else process.env.HEIMDALL_SELF_HEAL_ENABLED = previous;
  }
});

test('default autonomous self-heal scope excludes remote services until host-correct restart evidence exists', () => {
  assert.deepEqual(DEFAULT_SELF_HEAL_SERVICES, ['munin-memory', 'hugin', 'ratatoskr', 'skuld']);
});

test('an unreachable health status is not masked by a deployed commit', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      'deployed-commit',
      'latest-commit',
      0,
      'up-to-date',
      null,
      'unreachable',
      'HTTP 503',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
  } finally {
    db.close();
  }
});

test('an explicit unhealthy health status becomes failed evidence', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      'deployed-commit',
      'latest-commit',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health status=fail',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
  } finally {
    db.close();
  }
});

test('null, unknown, and malformed persisted health statuses stay alert-only', async () => {
  for (const healthStatus of [null, 'unknown', 'malformed']) {
    const db = tmpDb();
    try {
      insertServiceVersion(
        db,
        '2026-08-01T12:00:00Z',
        'hugin',
        'control-node',
        'deployed-commit',
        'latest-commit',
        0,
        'up-to-date',
        null,
        healthStatus,
        `persisted health status=${healthStatus}`,
      );
      insertRestartMetric(db);
      const { result, writes, savedState } = await runEnabled(db, {
        state: {
          schemaVersion: 'v1',
          failures: { hugin: 2 },
          lastDiagnosis: {},
          diagnosisOutcomes: {},
          circuitBreaker: { recentDiagnoses: [] },
        },
      });
      assert.equal(result.tasksSubmitted, 0, `status=${healthStatus}`);
      assert.equal(writes.length, 0, `status=${healthStatus}`);
      assert.deepEqual(result.decisions, [{
        service: 'hugin',
        diagnosis: 'blocked',
        reason: 'unknown-status',
        actuation: 'blocked',
      }]);
      assert.equal(savedState.failures.hugin, 2, `status=${healthStatus}`);
      const alert = activeSelfHealAlert(db, 'hugin');
      assert.ok(alert, `status=${healthStatus}`);
      assert.match(alert.detail, /health status is unknown/i, `status=${healthStatus}`);
    } finally {
      db.close();
    }
  }
});

test('missing health evidence becomes alert-only unknown with no task submission', async () => {
  const db = tmpDb();
  try {
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db);
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.title, /self-heal blocked/i);
    assert.match(alert.detail, /no data/i);
  } finally {
    db.close();
  }
});

test('stale health evidence becomes alert-only unknown with no task submission', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T11:20:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db);
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /stale/i);
  } finally {
    db.close();
  }
});

test('malformed health evidence becomes alert-only unknown with no task submission', async () => {
  const db = tmpDb();
  try {
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      healthEvidenceLoader: () => ({
        schemaVersion: 'v1',
        serviceId: 'hugin',
        instanceId: 'control-node',
        observedAt: 'not-a-timestamp',
        outcome: 'failed',
        diagnosticRef: 'ref:heim-hugin-health',
      }),
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /malformed/i);
  } finally {
    db.close();
  }
});

test('unsupported health evidence version becomes alert-only unknown with no task submission', async () => {
  const db = tmpDb();
  try {
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      healthEvidenceLoader: () => ({
        schemaVersion: 'v2',
        serviceId: 'hugin',
        instanceId: 'control-node',
        observedAt: '2026-08-01T12:00:00Z',
        outcome: 'failed',
        diagnosticRef: 'ref:heim-hugin-health',
      }),
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /unsupported version/i);
  } finally {
    db.close();
  }
});

test('missing validated registry configuration fails closed', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      grimnir: null,
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /validated registry/i);
  } finally {
    db.close();
  }
});

test('placeholder runtime identities fail closed before diagnosis submission', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'mimir',
      'nas',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertMetrics(db, [{
      timestamp: '2026-08-01T12:00:00Z',
      host: 'control-node',
      metric: 'service_restarts_24h_mimir',
      value: 0,
      unit: 'count',
      metadata: null,
    }]);
    const { result, writes } = await runEnabled(db, {
      serviceName: 'mimir',
      grimnir: makeRegistry({ serviceName: 'mimir', host: 'nas', port: 3031, unit: 'mimir' }),
      overlay: makeOverlay({
        serviceName: 'mimir',
        healthUrl: 'http://192.0.2.20:3031/health',
        sshHost: '192.0.2.20',
      }),
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'mimir');
    assert.ok(alert);
    assert.match(alert.detail, /placeholder/i);
  } finally {
    db.close();
  }
});

test('restart storm evidence is fail-closed when unavailable', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    const { result, writes } = await runEnabled(db);
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /restart storm evidence unavailable/i);
  } finally {
    db.close();
  }
});

test('restart storm exhaustion becomes alert-only unknown with no task submission', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db, { value: 9 });
    const { result, writes } = await runEnabled(db);
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /restart storm/i);
  } finally {
    db.close();
  }
});

test('cooldown evidence blocks repeat diagnosis submissions', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: { hugin: { submittedAt: '2026-08-01T11:30:00Z', mode: 'diagnosis-only' } },
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /cooldown/i);
  } finally {
    db.close();
  }
});

test('repeated post-diagnosis failures resubmit after cooldown when no reservation is active', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result, writes, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only' } },
        diagnosisOutcomes: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only', taskId: '20260801-heal-hugin' } },
        circuitBreaker: { recentDiagnoses: [{ service: 'hugin', submittedAt: '2026-08-01T10:00:00Z' }] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
    assert.ok(
      writes.some((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace)),
      'expected a fresh diagnosis task submission',
    );
    assert.equal(savedState.lastDiagnosis.hugin.taskId, '20260801120000-heal-hugin');
    assert.ok(!savedState.diagnosisOutcomes || !savedState.diagnosisOutcomes.hugin);
  } finally {
    db.close();
  }
});

test('legacy lastHeal migration preserves the cooldown window without creating a permanent budget gate', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const { result, writes, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v0',
        failures: { hugin: 1 },
        lastHeal: { hugin: Date.parse('2026-08-01T11:30:00Z') },
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /cooldown/i);
    assert.ok(savedState);
    assert.deepEqual(savedState.lastDiagnosis.hugin, {
      submittedAt: '2026-08-01T11:30:00Z',
      mode: 'diagnosis-only',
      taskId: null,
    });
    assert.ok(!savedState.diagnosisOutcomes || !savedState.diagnosisOutcomes.hugin);
  } finally {
    db.close();
  }
});

test('millisecond evidence rows are accepted and remain canonical with persisted timestamps', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00.123Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db, { timestamp: '2026-08-01T12:00:00.456Z' });
    const munin = createMuninStub();
    const { result, writes } = await runEnabled(db, {
      nowMs: Date.parse('2026-08-01T12:05:00Z'),
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
    const snapshots = writes
      .filter((entry) => entry.method === 'memory_write' && entry.args.key === 'snapshot')
      .map((entry) => JSON.parse(entry.args.content))
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.observed_at),
      ['2026-08-01T12:00:00.456Z', '2026-08-01T12:00:00.123Z'].sort(),
    );
  } finally {
    db.close();
  }
});

test('recent diagnoses keep the one-per-hour cooldown across recovery flapping', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: {
          recentDiagnoses: [{ service: 'hugin', submittedAt: '2026-08-01T11:30:00Z' }],
        },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /cooldown/i);
  } finally {
    db.close();
  }
});

test('invalid persisted diagnosis mode is rejected instead of being coerced into a budget gate', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'actuate' } },
        diagnosisOutcomes: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'actuate', taskId: 'bad-old-task' } },
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
    assert.equal(savedState.lastDiagnosis.hugin.taskId, '20260801120000-heal-hugin');
    assert.equal(savedState.lastDiagnosis.hugin.mode, 'diagnosis-only');
  } finally {
    db.close();
  }
});

test('self-heal enabled persists immutable snapshots and submits Hugin Context-refs with no shell snippets', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result, writes, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
    const snapshotWrites = writes.filter((entry) => entry.method === 'memory_write' && entry.args.key === 'snapshot');
    assert.equal(snapshotWrites.length, 2);
    assert.ok(snapshotWrites.every((entry) => entry.args.create_if_absent === true));
    assert.ok(snapshotWrites.every((entry) => !Object.prototype.hasOwnProperty.call(entry.args, 'expected_updated_at')));
    const taskWrite = writes.find((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace));
    assert.ok(taskWrite);
    assert.match(taskWrite.args.content, /diagnosis-only/i);
    assert.match(taskWrite.args.content, /typed actuation blocked/i);
    assert.match(taskWrite.args.content, /grimnir #183/i);
    assert.doesNotMatch(taskWrite.args.content, /Evidence refs:/iu);
    const contextRefs = extractContextRefs(taskWrite.args.content);
    assert.equal(contextRefs.length, 2);
    assert.match(contextRefs[0], /^observations\/self-heal\/heim-sh-sv-r\d+-t\d{14}-d[a-f0-9]{12}\/snapshot$/u);
    assert.match(contextRefs[1], /^observations\/self-heal\/heim-sh-mt-r\d+-t\d{14}-d[a-f0-9]{12}\/snapshot$/u);
    assert.deepEqual(
      contextRefs,
      snapshotWrites.map((entry) => `${entry.args.namespace}/${entry.args.key}`),
    );
    for (const entry of snapshotWrites) {
      const snapshot = JSON.parse(entry.args.content);
      assert.equal(snapshot.schema_version, 'v1');
      assert.equal(snapshot.source, 'heimdall-self-heal');
      assert.ok(snapshot.identity);
      assert.ok(Number.isInteger(snapshot.identity.row_id));
      assert.match(snapshot.identity.digest, /^[a-f0-9]{12}$/u);
      assert.equal(snapshot.instance_id, 'control-node');
      if (snapshot.observation_type === 'restart-budget') {
        assert.equal(snapshot.restart_count_24h, 0);
      } else {
        assert.equal(snapshot.outcome, 'failed');
      }
      assert.ok(!Object.hasOwn(snapshot, 'prompt'));
      assert.ok(!Object.hasOwn(snapshot, 'detail'));
    }
    assert.doesNotMatch(taskWrite.args.content, /\bssh\b|\bsudo\b|systemctl|journalctl|pgrep\b|df -h|free -h/u);
    assert.ok(savedState);
    assert.equal(savedState.lastDiagnosis.hugin.mode, 'diagnosis-only');
    assert.ok(!savedState.diagnosisOutcomes || !savedState.diagnosisOutcomes.hugin);
    assert.equal(savedState.circuitBreaker.recentDiagnoses.length, 1);
    assert.deepEqual(readReservation(db), {
      service: 'hugin',
      phase: 'submitted',
      task_id: '20260801120000-heal-hugin',
      reserved_at: '2026-08-01T12:00:00Z',
      expires_at: null,
      submitted_at: '2026-08-01T12:00:00Z',
      updated_at: '2026-08-01T12:00:00Z',
    });
  } finally {
    db.close();
  }
});

test('snapshot persistence must be proven before diagnosis submission', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result, writes } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: async (method, args) => {
        if (method === 'memory_read' && /^observations\/self-heal\//u.test(args.namespace)) {
          return {
            content: [{
              text: JSON.stringify({
                found: true,
                namespace: args.namespace,
                key: args.key,
                content: JSON.stringify({ schema_version: 'v1', source: 'tampered' }),
                updated_at: '2026-08-01T12:00:00Z',
              }),
            }],
          };
        }
        return munin.rpc(method, args);
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(
      writes.filter((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace)).length,
      0,
    );
    assert.match(activeSelfHealAlert(db, 'hugin').detail, /snapshot persistence/i);
    assert.equal(readReservation(db), null);
  } finally {
    db.close();
  }
});

test('task submission requires durable read-back proof when Munin reports isError', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: async (method, args) => {
        if (method === 'memory_write' && /^tasks\//u.test(args.namespace)) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'write_failed' }) }],
          };
        }
        if (method === 'memory_read' && /^tasks\//u.test(args.namespace)) {
          return {
            content: [{
              text: JSON.stringify({
                found: false,
                namespace: args.namespace,
                key: args.key,
              }),
            }],
          };
        }
        return munin.rpc(method, args);
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.match(activeSelfHealAlert(db, 'hugin').detail, /submission could not be confirmed/i);
    assert.deepEqual(readReservation(db), {
      service: 'hugin',
      phase: 'pending',
      task_id: '20260801120000-heal-hugin',
      reserved_at: '2026-08-01T12:00:00Z',
      expires_at: '2026-08-01T12:10:00Z',
      submitted_at: null,
      updated_at: '2026-08-01T12:00:00Z',
    });
  } finally {
    db.close();
  }
});

test('task submission accepts an idempotent isError response only when read-back proves the exact task body', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: async (method, args) => {
        if (method === 'memory_write' && /^tasks\//u.test(args.namespace)) {
          munin.entries.set(`${args.namespace}\u0000${args.key}`, {
            namespace: args.namespace,
            key: args.key,
            content: args.content,
            tags: args.tags || [],
            updated_at: '2026-08-01T12:00:30Z',
          });
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'already_exists' }) }],
          };
        }
        return munin.rpc(method, args);
      },
    });
    assert.equal(result.tasksSubmitted, 1);
  } finally {
    db.close();
  }
});

test('pending reservation blocks overlapping diagnosis submissions', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    let releaseSnapshotWrite;
    const snapshotWriteGate = new Promise((resolve) => {
      releaseSnapshotWrite = resolve;
    });
    let snapshotWriteSeen;
    const snapshotWriteSeenPromise = new Promise((resolve) => {
      snapshotWriteSeen = resolve;
    });
    let blocked = false;
    const rpc = async (method, args) => {
      if (!blocked && method === 'memory_write' && args.key === 'snapshot') {
        blocked = true;
        snapshotWriteSeen();
        await snapshotWriteGate;
      }
      return munin.rpc(method, args);
    };

    const firstRun = withEnabledEnv(() => checkAndHeal(db, {
      nowMs: Date.parse('2026-08-01T12:00:00Z'),
      services: ['hugin'],
      grimnirPath: tmpJson(makeRegistry({ serviceName: 'hugin' })),
      configPath: tmpJson(makeOverlay({ serviceName: 'hugin' })),
      rpc,
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      saveState() {},
      logger: { log() {}, warn() {}, error() {} },
    }));

    await snapshotWriteSeenPromise;

    const second = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: async () => {
        throw new Error('overlap must stop before any Munin writes');
      },
    });

    assert.equal(second.result.tasksSubmitted, 0);
    assert.equal(second.writes.length, 0);
    assert.match(activeSelfHealAlert(db, 'hugin').detail, /reservation pending/i);

    releaseSnapshotWrite();
    const firstResult = await firstRun;
    assert.equal(firstResult.tasksSubmitted, 1);
    assert.equal(
      munin.calls.filter((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace)).length,
      1,
    );
  } finally {
    db.close();
  }
});

test('submitted reservation stays fail-closed when state save fails after task submission', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    await assert.rejects(
      runEnabled(db, {
        state: {
          schemaVersion: 'v1',
          failures: { hugin: 1 },
          lastDiagnosis: {},
          diagnosisOutcomes: {},
          circuitBreaker: { recentDiagnoses: [] },
        },
        rpc: munin.rpc,
        saveState() {
          throw new Error('disk full');
        },
      }),
      /disk full/u,
    );

    const reservation = readReservation(db);
    assert.ok(reservation);
    assert.equal(reservation.phase, 'submitted');
    assert.equal(reservation.task_id, '20260801120000-heal-hugin');

    const second = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: async () => {
        throw new Error('submitted reservation must block retries before Munin writes');
      },
    });
    assert.equal(second.result.tasksSubmitted, 0);
    assert.equal(second.writes.length, 0);
    assert.match(activeSelfHealAlert(db, 'hugin').detail, /reservation submitted/i);
  } finally {
    db.close();
  }
});

test('stale pending reservation is recovered and replaced with the current task id', async () => {
  const db = tmpDb();
  try {
    seedReservation(db, {
      taskId: '20260801110000-heal-hugin',
      reservedAt: '2026-08-01T11:00:00Z',
      expiresAt: '2026-08-01T11:05:00Z',
      updatedAt: '2026-08-01T11:00:00Z',
    });
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
    });
    assert.equal(result.tasksSubmitted, 1);
    const reservation = readReservation(db);
    assert.ok(reservation);
    assert.equal(reservation.phase, 'submitted');
    assert.equal(reservation.task_id, '20260801120000-heal-hugin');
    assert.equal(reservation.expires_at, null);
  } finally {
    db.close();
  }
});

test('operator reset can recover a stale submitted reservation after the cooldown window', async () => {
  const db = tmpDb();
  try {
    seedReservation(db, {
      phase: 'submitted',
      taskId: '20260801100000-heal-hugin',
      reservedAt: '2026-08-01T10:00:00Z',
      expiresAt: null,
      submittedAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-01T10:00:00Z',
    });
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: munin.rpc,
      resetReservations: ['hugin'],
    });
    assert.equal(result.tasksSubmitted, 1);
    const reservation = readReservation(db);
    assert.ok(reservation);
    assert.equal(reservation.phase, 'submitted');
    assert.equal(reservation.task_id, '20260801120000-heal-hugin');
  } finally {
    db.close();
  }
});

test('operator reset clears a stale submitted reservation coherently with persisted diagnosis state after cooldown', async () => {
  const db = tmpDb();
  try {
    seedReservation(db, {
      phase: 'submitted',
      taskId: '20260801100000-heal-hugin',
      reservedAt: '2026-08-01T10:00:00Z',
      expiresAt: null,
      submittedAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-01T10:00:00Z',
    });
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(db);
    const munin = createMuninStub();
    const { result, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only', taskId: '20260801100000-heal-hugin' } },
        diagnosisOutcomes: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only', taskId: '20260801100000-heal-hugin' } },
        circuitBreaker: { recentDiagnoses: [{ service: 'hugin', submittedAt: '2026-08-01T10:00:00Z' }] },
      },
      rpc: munin.rpc,
      resetReservations: ['hugin'],
    });
    assert.equal(result.tasksSubmitted, 1);
    assert.deepEqual(readReservation(db), {
      service: 'hugin',
      phase: 'submitted',
      task_id: '20260801120000-heal-hugin',
      reserved_at: '2026-08-01T12:00:00Z',
      expires_at: null,
      submitted_at: '2026-08-01T12:00:00Z',
      updated_at: '2026-08-01T12:00:00Z',
    });
    assert.equal(savedState.lastDiagnosis.hugin.taskId, '20260801120000-heal-hugin');
    assert.ok(!savedState.diagnosisOutcomes || !savedState.diagnosisOutcomes.hugin);
  } finally {
    db.close();
  }
});

test('remote services do not inherit control-node restart metrics', async () => {
  const db = tmpDb();
  try {
    insertServiceVersion(
      db,
      '2026-08-01T12:00:00Z',
      'mimir',
      'nas',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertMetrics(db, [{
      timestamp: '2026-08-01T12:00:00Z',
      host: 'control-node',
      metric: 'service_restarts_24h_mimir',
      value: 0,
      unit: 'count',
      metadata: null,
    }]);
    const { result, writes } = await runEnabled(db, {
      serviceName: 'mimir',
      grimnir: makeRegistry({ serviceName: 'mimir', host: 'nas', port: 3031, unit: 'mimir' }),
      overlay: makeOverlay({
        serviceName: 'mimir',
        healthUrl: 'http://nas.internal:3031/health',
        sshHost: 'nas',
      }),
      state: {
        schemaVersion: 'v1',
        failures: { mimir: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    assert.match(activeSelfHealAlert(db, 'mimir').detail, /unavailable/i);
  } finally {
    db.close();
  }
});

test('cross-service identity mismatches fail closed', async () => {
  const db = tmpDb();
  try {
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      healthEvidenceLoader: () => ({
        schemaVersion: 'v1',
        serviceId: 'mimir',
        instanceId: 'control-node',
        observedAt: '2026-08-01T12:00:00Z',
        outcome: 'failed',
        diagnosticRef: 'ref:heim-mimir-health',
      }),
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /identity mismatch/i);
  } finally {
    db.close();
  }
});

test('diagnosis task content rejects unbounded or non-resolvable Hugin Context-refs', () => {
  assert.throws(
    () => buildDiagnosisTaskContent({
      service: 'hugin',
      host: 'control-node',
      unit: 'hugin',
      contextRefs: ['https://heimdall.local/private/path'],
    }),
    /context ref/i,
  );
  assert.throws(
    () => buildDiagnosisTaskContent({
      service: 'hugin',
      host: 'control-node',
      unit: 'hugin',
      contextRefs: Array.from({ length: 9 }, () => 'observations/self-heal/heim-sh-sv-r1-t20260801120000-dabc123def456/snapshot'),
    }),
    /context ref/i,
  );
});

test('updated observations produce new Context-refs for the next diagnosis envelope', async () => {
  const firstDb = tmpDb();
  const secondDb = tmpDb();
  try {
    insertServiceVersion(
      firstDb,
      '2026-08-01T12:00:00Z',
      'hugin',
      'control-node',
      null,
      'deadbeef',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(firstDb, { timestamp: '2026-08-01T12:00:00Z', value: 1 });
    const firstMunin = createMuninStub();
    const first = await runEnabled(firstDb, {
      nowMs: Date.parse('2026-08-01T12:01:00Z'),
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: firstMunin.rpc,
    });
    const firstWrite = first.writes.find((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace));
    assert.ok(firstWrite);
    const firstRefs = extractContextRefs(firstWrite.args.content);

    insertServiceVersion(
      secondDb,
      '2026-08-01T12:05:00Z',
      'hugin',
      'control-node',
      null,
      'cafebabe',
      0,
      'up-to-date',
      null,
      'unhealthy',
      'health probe fixture',
    );
    insertRestartMetric(secondDb, { timestamp: '2026-08-01T12:05:00Z', value: 2 });
    const secondMunin = createMuninStub();
    const second = await runEnabled(secondDb, {
      nowMs: Date.parse('2026-08-01T12:06:00Z'),
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
      rpc: secondMunin.rpc,
    });
    const secondWrite = second.writes.find((entry) => entry.method === 'memory_write' && /^tasks\//u.test(entry.args.namespace));
    assert.ok(secondWrite);
    const secondRefs = extractContextRefs(secondWrite.args.content);

    assert.notEqual(firstRefs[0], secondRefs[0], 'health evidence ref must bind to one immutable observation');
    assert.notEqual(firstRefs[1], secondRefs[1], 'restart evidence ref must bind to one immutable observation');
  } finally {
    firstDb.close();
    secondDb.close();
  }
});
