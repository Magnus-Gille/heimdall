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
const { checkAndHeal, buildDiagnosisTaskContent } = require('../src/self-heal');

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
  nowMs = Date.parse('2026-08-01T12:00:00Z'),
  grimnir = makeRegistry({ serviceName }),
  overlay = makeOverlay({ serviceName }),
  rpcResult = true,
  state,
  healthEvidenceLoader,
  logger,
} = {}) {
  const writes = [];
  let savedState = null;
  const result = await withEnabledEnv(() => checkAndHeal(db, {
    nowMs,
    services: [serviceName],
    grimnirPath: grimnir ? tmpJson(grimnir) : '/no/such/grimnir.json',
    configPath: overlay ? tmpJson(overlay) : '/no/such/heimdall-config.json',
    rpc: async (method, args) => {
      writes.push({ method, args });
      return rpcResult;
    },
    state,
    saveState(next) { savedState = JSON.parse(JSON.stringify(next)); },
    healthEvidenceLoader,
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

function extractEvidenceRefs(content) {
  const match = content.match(/- \*\*Evidence refs:\*\* (.+)/u);
  assert.ok(match, 'task content must include evidence refs');
  return match[1].split(/,\s*/u);
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

test('repeated post-diagnosis failures stay alert-only unknown', async () => {
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
    );
    insertRestartMetric(db);
    const { result, writes } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only' } },
        diagnosisOutcomes: { hugin: { submittedAt: '2026-08-01T10:00:00Z', mode: 'diagnosis-only', taskId: '20260801-heal-hugin' } },
        circuitBreaker: { recentDiagnoses: [{ service: 'hugin', submittedAt: '2026-08-01T10:00:00Z' }] },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /repeated failure/i);
  } finally {
    db.close();
  }
});

test('legacy lastHeal migration consumes the diagnosis budget after cooldown', async () => {
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
    );
    insertRestartMetric(db);
    const { result, writes, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v0',
        failures: { hugin: 1 },
        lastHeal: { hugin: Date.parse('2026-08-01T10:00:00Z') },
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    assert.equal(result.tasksSubmitted, 0);
    assert.equal(writes.length, 0);
    const alert = activeSelfHealAlert(db, 'hugin');
    assert.ok(alert);
    assert.match(alert.detail, /repeated failure/i);
    assert.ok(savedState);
    assert.deepEqual(savedState.diagnosisOutcomes.hugin, {
      submittedAt: '2026-08-01T10:00:00Z',
      mode: 'diagnosis-only',
      taskId: null,
    });
  } finally {
    db.close();
  }
});

test('self-heal enabled submits a diagnosis-only task with no shell snippets', async () => {
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
    );
    insertRestartMetric(db);
    const { result, writes, savedState } = await runEnabled(db, {
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    assert.equal(result.tasksSubmitted, 1);
    const write = writes.find((entry) => entry.method === 'memory_write');
    assert.ok(write);
    assert.match(write.args.namespace, /^tasks\//u);
    assert.match(write.args.content, /diagnosis-only/i);
    assert.match(write.args.content, /typed actuation blocked/i);
    assert.match(write.args.content, /grimnir #183/i);
    const evidenceRefs = extractEvidenceRefs(write.args.content);
    assert.equal(evidenceRefs.length, 2);
    assert.match(evidenceRefs[0], /^ref:heim-sh-sv-r\d+-t\d{14}-d[a-f0-9]{12}$/u);
    assert.match(evidenceRefs[1], /^ref:heim-sh-mt-r\d+-t\d{14}-d[a-f0-9]{12}$/u);
    assert.doesNotMatch(write.args.content, /\bssh\b|\bsudo\b|systemctl|journalctl|pgrep\b|df -h|free -h/u);
    assert.ok(savedState);
    assert.equal(savedState.diagnosisOutcomes.hugin.mode, 'diagnosis-only');
    assert.equal(savedState.circuitBreaker.recentDiagnoses.length, 1);
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

test('diagnosis task content rejects unbounded or non-opaque evidence refs', () => {
  assert.throws(
    () => buildDiagnosisTaskContent({
      service: 'hugin',
      host: 'control-node',
      unit: 'hugin',
      evidenceRefs: ['https://heimdall.local/private/path'],
    }),
    /opaque evidence ref/i,
  );
  assert.throws(
    () => buildDiagnosisTaskContent({
      service: 'hugin',
      host: 'control-node',
      unit: 'hugin',
      evidenceRefs: [`ref:${'a'.repeat(122)}`],
    }),
    /opaque evidence ref/i,
  );
});

test('updated observations produce new opaque evidence refs for the next diagnosis envelope', async () => {
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
    );
    insertRestartMetric(db, { timestamp: '2026-08-01T12:00:00Z', value: 1 });
    const first = await runEnabled(db, {
      nowMs: Date.parse('2026-08-01T12:01:00Z'),
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    const firstWrite = first.writes.find((entry) => entry.method === 'memory_write');
    assert.ok(firstWrite);
    const firstRefs = extractEvidenceRefs(firstWrite.args.content);

    insertServiceVersion(
      db,
      '2026-08-01T12:05:00Z',
      'hugin',
      'control-node',
      null,
      'cafebabe',
      0,
      'up-to-date',
      null,
    );
    insertRestartMetric(db, { timestamp: '2026-08-01T12:05:00Z', value: 2 });
    const second = await runEnabled(db, {
      nowMs: Date.parse('2026-08-01T12:06:00Z'),
      state: {
        schemaVersion: 'v1',
        failures: { hugin: 1 },
        lastDiagnosis: {},
        diagnosisOutcomes: {},
        circuitBreaker: { recentDiagnoses: [] },
      },
    });
    const secondWrite = second.writes.find((entry) => entry.method === 'memory_write');
    assert.ok(secondWrite);
    const secondRefs = extractEvidenceRefs(secondWrite.args.content);

    assert.notEqual(firstRefs[0], secondRefs[0], 'health evidence ref must bind to one immutable observation');
    assert.notEqual(firstRefs[1], secondRefs[1], 'restart evidence ref must bind to one immutable observation');
  } finally {
    db.close();
  }
});
