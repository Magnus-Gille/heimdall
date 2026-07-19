'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const QUERY_SCRIPT = path.join(__dirname, '..', 'scripts', 'heimdall-query');

function setupTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-query-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      host TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      unit TEXT,
      metadata TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      host TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      detail TEXT,
      source TEXT
    );
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      host TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      acknowledged_at TEXT
    );
  `);

  // Seed test data
  db.prepare(`INSERT INTO events (timestamp, host, category, severity, title) VALUES (datetime('now'), 'control-node', 'ssh', 'warning', 'SSH login from 198.51.100.1')`).run();
  db.prepare(`INSERT INTO events (timestamp, host, category, severity, title) VALUES (datetime('now'), 'nas', 'backup', 'info', 'Backup completed')`).run();
  db.prepare(`INSERT INTO metrics (timestamp, host, metric, value, unit) VALUES (datetime('now'), 'control-node', 'cpu_temp', 42.5, '°C')`).run();
  db.prepare(`INSERT INTO alerts (created_at, host, category, severity, title) VALUES (datetime('now'), 'control-node', 'threshold', 'warning', 'CPU temp high')`).run();
  db.prepare(`INSERT INTO alerts (created_at, resolved_at, host, category, severity, title) VALUES (datetime('now', '-1 hour'), datetime('now'), 'nas', 'backup', 'critical', 'Backup failed')`).run();

  db.close();
  return { dbPath, dir };
}

// Note: execFileSync is used intentionally (not exec) — it does not spawn a
// shell, so there is no command-injection risk from test arguments.
function run(args, dbPath) {
  return execFileSync(process.execPath, [QUERY_SCRIPT, ...args], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf-8',
    timeout: 5000,
  });
}

function runExpectFail(args, dbPath) {
  try {
    execFileSync(process.execPath, [QUERY_SCRIPT, ...args], {
      env: { ...process.env, DB_PATH: dbPath || '/nonexistent/db' },
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.fail('Expected command to fail');
  } catch (err) {
    return err.stderr || err.stdout || '';
  }
}

describe('heimdall-query', () => {
  let dbPath, dir;

  beforeEach(() => {
    ({ dbPath, dir } = setupTestDb());
  });

  // --- Normal operation ---

  describe('events', () => {
    it('lists events', () => {
      const out = run(['events'], dbPath);
      assert.ok(out.includes('SSH login'));
      assert.ok(out.includes('Backup completed'));
    });

    it('filters by --category', () => {
      const out = run(['events', '--category', 'ssh'], dbPath);
      assert.ok(out.includes('SSH login'));
      assert.ok(!out.includes('Backup completed'));
    });

    it('filters by --severity', () => {
      const out = run(['events', '--severity', 'warning'], dbPath);
      assert.ok(out.includes('SSH login'));
      assert.ok(!out.includes('Backup completed'));
    });

    it('filters by --last', () => {
      const out = run(['events', '--last', '1h'], dbPath);
      assert.ok(out.includes('SSH login'));
    });

    it('respects --limit', () => {
      const out = run(['events', '--limit', '1'], dbPath);
      const lines = out.trim().split('\n');
      // header + separator + 1 data row
      assert.equal(lines.length, 3);
    });
  });

  describe('metrics', () => {
    it('queries metrics with host and metric', () => {
      const out = run(['metrics', '--host', 'control-node', '--metric', 'cpu_temp'], dbPath);
      assert.ok(out.includes('42.5'));
    });

    it('requires --host and --metric', () => {
      const err = runExpectFail(['metrics', '--host', 'control-node'], dbPath);
      assert.ok(err.includes('--host and --metric are required'));
    });
  });

  describe('alerts', () => {
    it('lists all alerts', () => {
      const out = run(['alerts'], dbPath);
      assert.ok(out.includes('CPU temp high'));
      assert.ok(out.includes('Backup failed'));
    });

    it('filters active only', () => {
      const out = run(['alerts', '--active'], dbPath);
      assert.ok(out.includes('CPU temp high'));
      assert.ok(!out.includes('Backup failed'));
    });
  });

  // --- SQL injection prevention ---

  describe('SQL injection prevention', () => {
    it('rejects SQL injection in --category', () => {
      const err = runExpectFail(['events', '--category', "'; DROP TABLE events; --"], dbPath);
      assert.ok(err.includes('Invalid category'));
    });

    it('rejects SQL injection in --severity', () => {
      const err = runExpectFail(['events', '--severity', "' OR 1=1 --"], dbPath);
      assert.ok(err.includes('Invalid severity'));
    });

    it('rejects SQL injection in --host', () => {
      const err = runExpectFail(['metrics', '--host', "' UNION SELECT * FROM events --", '--metric', 'cpu_temp'], dbPath);
      assert.ok(err.includes('Invalid host'));
    });

    it('rejects SQL injection in --metric', () => {
      const err = runExpectFail(['metrics', '--host', 'control-node', '--metric', "'; DROP TABLE metrics; --"], dbPath);
      assert.ok(err.includes('Invalid metric'));
    });

    it('rejects SQL injection in --last', () => {
      const err = runExpectFail(['events', '--last', "1h'); DROP TABLE events; --"], dbPath);
      assert.ok(err.includes('Invalid --last period'));
    });

    it('rejects SQL injection in --limit', () => {
      const err = runExpectFail(['events', '--limit', '1; DROP TABLE events'], dbPath);
      assert.ok(err.includes('Invalid --limit'));
    });
  });

  // --- Input validation ---

  describe('input validation', () => {
    it('rejects missing database', () => {
      const err = runExpectFail(['events'], '/nonexistent/path/db.sqlite');
      assert.ok(err.includes('Database not found'));
    });

    it('rejects invalid period format', () => {
      const err = runExpectFail(['events', '--last', 'abc'], dbPath);
      assert.ok(err.includes('Invalid --last period'));
    });

    it('rejects limit of 0', () => {
      const err = runExpectFail(['events', '--limit', '0'], dbPath);
      assert.ok(err.includes('--limit must be between'));
    });

    it('rejects excessive limit', () => {
      const err = runExpectFail(['events', '--limit', '99999'], dbPath);
      assert.ok(err.includes('--limit must be between'));
    });

    it('shows usage with no arguments', () => {
      const err = runExpectFail([], dbPath);
      assert.ok(err.includes('Usage'));
    });
  });
});
