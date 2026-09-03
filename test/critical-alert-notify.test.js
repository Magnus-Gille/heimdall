'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  openDatabase,
  createAlert,
  resolveAlert,
} = require('../src/db');
const {
  buildCriticalAlertText,
  sendCriticalAlertNotifications,
} = require('../src/notify');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-critical-notify-'));
  return path.join(dir, 'test.db');
}

function tmpDb() {
  return openDatabase(tmpPath());
}

function deliveryRow(db, id) {
  return db.prepare(`
    SELECT notification_sent_at, notification_attempts,
           notification_last_error, notification_next_attempt_at
    FROM alerts WHERE id = ?
  `).get(id);
}

describe('critical alert notification migration', () => {
  it('backfills an active pre-migration critical alert so deployment cannot spam it', () => {
    const dbPath = tmpPath();
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        host TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        acknowledged INTEGER DEFAULT 0,
        dedup_key TEXT,
        source TEXT
      );
      -- A genuine v6 database also has service_versions (created in v1); the
      -- v8 migration adds drift_state/drift_reason to it.
      CREATE TABLE service_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checked_at TEXT NOT NULL,
        service TEXT NOT NULL,
        host TEXT NOT NULL,
        deployed_commit TEXT,
        latest_commit TEXT,
        commits_behind INTEGER
      );
      INSERT INTO alerts (created_at, host, category, severity, title)
      VALUES ('2026-07-22T10:00:00Z', 'control-node', 'system', 'critical', 'Existing outage');
      PRAGMA user_version = 6;
    `);
    old.close();

    const db = openDatabase(dbPath);
    assert.equal(db.pragma('user_version', { simple: true }), 13);
    const row = db.prepare('SELECT notification_sent_at FROM alerts').get();
    assert.equal(row.notification_sent_at, 'backfilled');
    db.close();
  });
});

describe('critical alert notification delivery', () => {
  it('sends a newly fired critical alert once and deduplicates repeated observations', async () => {
    const db = tmpDb();
    const id = createAlert(db, 'control-node', 'system', 'critical', 'Disk full', '95% used');
    const sent = [];
    const deps = {
      chatId: 1234,
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async (chatId, text) => sent.push({ chatId, text }),
    };

    assert.deepEqual(await sendCriticalAlertNotifications(db, deps), {
      sent: 1, failed: 0, pending: 1,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 1234);
    assert.match(sent[0].text, /Disk full/);
    assert.equal(deliveryRow(db, id).notification_sent_at, '2026-07-23T10:00:00.000Z');

    assert.equal(
      createAlert(db, 'control-node', 'system', 'critical', 'Disk full', '96% used'),
      id,
    );
    assert.deepEqual(await sendCriticalAlertNotifications(db, deps), {
      sent: 0, failed: 0, pending: 0,
    });
    assert.equal(sent.length, 1);
    db.close();
  });

  it('allows a resolved critical condition to notify again when it re-fires', async () => {
    const db = tmpDb();
    const messages = [];
    const deps = {
      chatId: 42,
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async (_chatId, text) => messages.push(text),
    };

    const firstId = createAlert(db, 'nas', 'backup', 'critical', 'Backup stale', '31h');
    await sendCriticalAlertNotifications(db, deps);
    resolveAlert(db, 'nas', 'Backup stale');
    const secondId = createAlert(db, 'nas', 'backup', 'critical', 'Backup stale', '32h');
    await sendCriticalAlertNotifications(db, deps);

    assert.notEqual(secondId, firstId);
    assert.equal(messages.length, 2);
    db.close();
  });

  it('excludes a critical alert that resolves before the delivery phase', async () => {
    const db = tmpDb();
    createAlert(db, 'nas', 'backup', 'critical', 'Brief outage', 'recovered');
    resolveAlert(db, 'nas', 'Brief outage');
    let called = false;
    const result = await sendCriticalAlertNotifications(db, {
      chatId: 42,
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async () => { called = true; },
    });

    assert.deepEqual(result, { sent: 0, failed: 0, pending: 0 });
    assert.equal(called, false);
    db.close();
  });

  it('does not send warnings, but sends on warning-to-critical escalation', async () => {
    const db = tmpDb();
    const messages = [];
    const deps = {
      chatId: 42,
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async (_chatId, text) => messages.push(text),
    };

    const id = createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', '27h');
    await sendCriticalAlertNotifications(db, deps);
    assert.equal(messages.length, 0);
    assert.equal(createAlert(db, 'nas', 'backup', 'critical', 'Backup stale', '31h'), id);
    await sendCriticalAlertNotifications(db, deps);
    assert.equal(messages.length, 1);
    db.close();
  });

  it('resets delivery state after a critical alert downgrades, then notifies on re-escalation', async () => {
    const db = tmpDb();
    const messages = [];
    let now = new Date('2026-07-23T10:00:00Z');
    const deps = {
      chatId: 42,
      now: () => now,
      sendTelegram: async (_chatId, text) => messages.push(text),
    };

    const id = createAlert(db, 'nas', 'backup', 'critical', 'Backup stale', '31h');
    await sendCriticalAlertNotifications(db, deps);
    createAlert(db, 'nas', 'backup', 'warning', 'Backup stale', '27h');
    now = new Date('2026-07-23T10:05:00Z');
    createAlert(db, 'nas', 'backup', 'critical', 'Backup stale', '31h');
    await sendCriticalAlertNotifications(db, deps);

    assert.equal(messages.length, 2);
    assert.equal(deliveryRow(db, id).notification_sent_at, '2026-07-23T10:05:00.000Z');
    db.close();
  });

  it('records a safe failure class and retries after the persistent backoff expires', async () => {
    const db = tmpDb();
    const id = createAlert(db, 'control-node', 'system', 'critical', 'Router down', 'offline');
    let now = new Date('2026-07-23T10:00:00Z');
    let attempts = 0;
    const logs = [];
    const deps = {
      chatId: 42,
      now: () => now,
      onError: (alertId, errorClass) => logs.push({ alertId, errorClass }),
      sendTelegram: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('secret=https://private.example/?token=do-not-store');
      },
    };

    assert.deepEqual(await sendCriticalAlertNotifications(db, deps), {
      sent: 0, failed: 1, pending: 1,
    });
    const failed = deliveryRow(db, id);
    assert.equal(failed.notification_attempts, 1);
    assert.equal(failed.notification_last_error, 'transport-error');
    assert.ok(!JSON.stringify(failed).includes('do-not-store'));
    assert.deepEqual(logs, [{ alertId: id, errorClass: 'transport-error' }]);
    assert.ok(!JSON.stringify(logs).includes('Router down'));
    assert.ok(!JSON.stringify(logs).includes('offline'));
    assert.ok(!JSON.stringify(logs).includes('do-not-store'));
    assert.equal(failed.notification_next_attempt_at, '2026-07-23T10:01:00.000Z');

    now = new Date('2026-07-23T10:00:59Z');
    await sendCriticalAlertNotifications(db, deps);
    assert.equal(attempts, 1, 'backoff suppresses an early retry');

    now = new Date('2026-07-23T10:01:00Z');
    assert.deepEqual(await sendCriticalAlertNotifications(db, deps), {
      sent: 1, failed: 0, pending: 1,
    });
    assert.equal(attempts, 2);
    assert.equal(deliveryRow(db, id).notification_last_error, null);
    db.close();
  });

  it('keeps a missing chat id observable and retryable without calling the transport', async () => {
    const db = tmpDb();
    const id = createAlert(db, 'control-node', 'system', 'critical', 'No route', null);
    let called = false;
    const result = await sendCriticalAlertNotifications(db, {
      chatId: null,
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async () => { called = true; },
    });

    assert.deepEqual(result, { sent: 0, failed: 1, pending: 1, skipped: true });
    assert.equal(called, false);
    assert.equal(deliveryRow(db, id).notification_last_error, 'not-configured');
    db.close();
  });

  it('rejects a partially numeric chat id instead of sending to an unintended destination', async () => {
    const db = tmpDb();
    const id = createAlert(db, 'control-node', 'system', 'critical', 'Bad config', null);
    let called = false;
    const result = await sendCriticalAlertNotifications(db, {
      chatId: '1234-not-a-chat',
      now: () => new Date('2026-07-23T10:00:00Z'),
      sendTelegram: async () => { called = true; },
    });

    assert.equal(result.skipped, true);
    assert.equal(called, false);
    assert.equal(deliveryRow(db, id).notification_last_error, 'not-configured');
    db.close();
  });
});

describe('buildCriticalAlertText', () => {
  it('builds bounded plain text without forwarding multiline log noise', () => {
    const text = buildCriticalAlertText({
      host: 'control-node',
      title: 'Service down\nspoofed heading',
      detail: `First line\n${'x'.repeat(2000)}`,
    });
    assert.match(text, /^\[Grimnir alert\] CRITICAL:/);
    assert.ok(!text.includes('\nspoofed heading'));
    assert.ok(text.length <= 800);
  });
});
