'use strict';

/**
 * Tests for src/notify.js — Telegram-based task notification.
 *
 * Tests:
 *   (a) builds expected plain-text message from a sample terminal task
 *   (b) HEIMDALL_NOTIFY_CHAT_ID unset → returns { sent:0, skipped:true }, no fetch
 *   (c) chat_id set → POSTs to ratatoskr URL with {chat_id, text}
 *   (d) fetch rejecting → does NOT throw, marks failed
 *   (e) ratatoskr 500 → does NOT throw, marks failed
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// --- helpers ------------------------------------------------------------------

function makeDb(tasks = []) {
  const marked = [];
  const failed = [];
  return {
    _marked: marked,
    _failed: failed,
    prepare: (sql) => {
      if (sql.includes('SELECT COUNT(*)')) {
        return { get: () => ({ c: 0 }) };
      }
      if (sql.includes('SELECT task_key')) {
        return { all: () => tasks };
      }
      if (sql.includes('notified_at = datetime')) {
        return { run: (key) => marked.push(key) };
      }
      if (sql.includes('notify_attempts = COALESCE')) {
        return { run: (key) => failed.push(key) };
      }
      if (sql.includes('LIMIT 0')) {
        return { run: () => {} };
      }
      return { run: () => {}, all: () => [], get: () => ({}) };
    },
    exec: () => {},
  };
}

// Stub global.fetch and restore after each test
let fetchCalls = [];
let fetchImpl = null;

function stubFetch(impl) {
  fetchImpl = impl;
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
}

function restoreFetch() {
  delete global.fetch;
  fetchImpl = null;
  fetchCalls = [];
}

// --- (a) buildNotifyText helper -----------------------------------------------

describe('buildNotifyText', () => {
  const { buildNotifyText } = require(path.join(__dirname, '..', 'src', 'notify.js'));

  it('builds expected plain-text message for a completed task', () => {
    const task = {
      name: 'deploy-heimdall',
      status: 'completed',
      result: 'Exit code: 0\nDuration: 12s\nAll systems go.',
    };
    const text = buildNotifyText(task);
    assert.ok(text.includes('[Grimnir]'), 'should have [Grimnir] prefix');
    assert.ok(text.includes('deploy-heimdall'), 'should include task name');
    assert.ok(text.includes('completed') || text.includes('Completed'), 'should include status');
  });

  it('truncates result to ~200 chars', () => {
    const longResult = 'x'.repeat(500);
    const task = { name: 'big-task', status: 'done', result: longResult };
    const text = buildNotifyText(task);
    assert.ok(text.length < 600, 'message should not be excessively long');
  });

  it('handles missing result gracefully', () => {
    const task = { name: 'empty-task', status: 'failed', result: null };
    const text = buildNotifyText(task);
    assert.ok(text.includes('[Grimnir]'));
    assert.ok(typeof text === 'string');
  });
});

// --- (b) no HEIMDALL_NOTIFY_CHAT_ID → skipped, no fetch ----------------------

describe('sendTaskNotifications — no chat_id', () => {
  let origChatId;

  beforeEach(() => {
    origChatId = process.env.HEIMDALL_NOTIFY_CHAT_ID;
    delete process.env.HEIMDALL_NOTIFY_CHAT_ID;
    fetchCalls = [];
    // Make sure fetch is NOT stubbed so we catch accidental calls
    delete global.fetch;
  });

  afterEach(() => {
    if (origChatId !== undefined) process.env.HEIMDALL_NOTIFY_CHAT_ID = origChatId;
    else delete process.env.HEIMDALL_NOTIFY_CHAT_ID;
    restoreFetch();
  });

  it('returns { sent:0, skipped:true } when HEIMDALL_NOTIFY_CHAT_ID is unset', async () => {
    // Reload module each time to pick up env changes
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{ task_key: 'tasks/20240101-120000-test/status', last_status: 'completed', last_updated: new Date().toISOString() }]);
    const result = await sendTaskNotifications(db);
    assert.equal(result.skipped, true);
    assert.equal(result.sent, 0);
    assert.equal(fetchCalls.length, 0, 'fetch must not be called');
  });

  it('does not throw when chat_id is unset', async () => {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb();
    await assert.doesNotReject(() => sendTaskNotifications(db));
  });
});

// --- (c) chat_id set → POSTs {chat_id, text} to ratatoskr ------------------

describe('sendTaskNotifications — chat_id configured', () => {
  const CHAT_ID = 12345678;
  const RATATOSKR_URL = 'http://127.0.0.1:3034/api/send'; // matches the safe local-only default

  let origReadHuginTaskFull;

  beforeEach(() => {
    process.env.HEIMDALL_NOTIFY_CHAT_ID = String(CHAT_ID);
    delete process.env.RATATOSKR_URL;
    delete process.env.RATATOSKR_SEND_API_KEY;
    stubFetch(async () => ({ ok: true, status: 200 }));
    // Stub hugin.readHuginTaskFull — pre-load hugin then monkey-patch exports
    const huginMod = require(path.join(__dirname, '..', 'src', 'hugin.js'));
    origReadHuginTaskFull = huginMod.readHuginTaskFull;
    huginMod.readHuginTaskFull = (ns) => ({
      name: ns.split('/').pop(),
      status: 'completed',
      result: 'Task finished successfully.',
      namespace: ns,
    });
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
  });

  afterEach(() => {
    // Restore hugin stub
    const huginMod = require(path.join(__dirname, '..', 'src', 'hugin.js'));
    huginMod.readHuginTaskFull = origReadHuginTaskFull;
    delete process.env.HEIMDALL_NOTIFY_CHAT_ID;
    delete process.env.RATATOSKR_URL;
    delete process.env.RATATOSKR_SEND_API_KEY;
    restoreFetch();
  });

  it('POSTs to ratatoskr with {chat_id, text}', async () => {
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-test/status',
      last_status: 'completed',
      last_updated: new Date().toISOString(),
    }]);
    await sendTaskNotifications(db);
    assert.equal(fetchCalls.length, 1, 'exactly one fetch call');
    assert.equal(fetchCalls[0].url, RATATOSKR_URL);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.chat_id, CHAT_ID);
    assert.ok(typeof body.text === 'string' && body.text.length > 0);
  });

  it('marks task as notified on success', async () => {
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-test/status',
      last_status: 'completed',
      last_updated: new Date().toISOString(),
    }]);
    const result = await sendTaskNotifications(db);
    assert.equal(result.sent, 1);
    assert.equal(db._marked.length, 1);
    assert.equal(db._failed.length, 0);
  });

  it('adds Authorization header when RATATOSKR_SEND_API_KEY is set', async () => {
    process.env.RATATOSKR_SEND_API_KEY = 'myapikey';
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-test/status',
      last_status: 'completed',
      last_updated: new Date().toISOString(),
    }]);
    await sendTaskNotifications(db);
    assert.equal(fetchCalls[0].opts.headers['Authorization'], 'Bearer myapikey');
  });

  it('uses RATATOSKR_URL env override', async () => {
    process.env.RATATOSKR_URL = 'http://localhost:9999/api/send';
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-test/status',
      last_status: 'completed',
      last_updated: new Date().toISOString(),
    }]);
    await sendTaskNotifications(db);
    assert.equal(fetchCalls[0].url, 'http://localhost:9999/api/send');
  });
});

// --- (d)+(e) fetch failure → does NOT throw, marks failed --------------------

describe('sendTaskNotifications — fetch failures', () => {
  const CHAT_ID = 12345678;

  let origReadHuginTaskFull2;

  beforeEach(() => {
    process.env.HEIMDALL_NOTIFY_CHAT_ID = String(CHAT_ID);
    // Stub hugin.readHuginTaskFull
    const huginMod = require(path.join(__dirname, '..', 'src', 'hugin.js'));
    origReadHuginTaskFull2 = huginMod.readHuginTaskFull;
    huginMod.readHuginTaskFull = (ns) => ({
      name: ns.split('/').pop(),
      status: 'failed',
      result: 'Something went wrong.',
      namespace: ns,
    });
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'notify.js'))];
  });

  afterEach(() => {
    const huginMod = require(path.join(__dirname, '..', 'src', 'hugin.js'));
    huginMod.readHuginTaskFull = origReadHuginTaskFull2;
    delete process.env.HEIMDALL_NOTIFY_CHAT_ID;
    restoreFetch();
  });

  it('does NOT throw when fetch rejects (network error)', async () => {
    stubFetch(async () => { throw new Error('ECONNREFUSED'); });
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-fail/status',
      last_status: 'failed',
      last_updated: new Date().toISOString(),
    }]);
    await assert.doesNotReject(() => sendTaskNotifications(db));
    assert.equal(db._failed.length, 1, 'should mark as failed');
    assert.equal(db._marked.length, 0);
  });

  it('does NOT throw when ratatoskr returns 500', async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-fail/status',
      last_status: 'failed',
      last_updated: new Date().toISOString(),
    }]);
    await assert.doesNotReject(() => sendTaskNotifications(db));
    assert.equal(db._failed.length, 1, 'should mark as failed on 500');
    assert.equal(db._marked.length, 0);
  });

  it('returns { sent:0, failed:1 } on single fetch failure', async () => {
    stubFetch(async () => { throw new Error('timeout'); });
    const { sendTaskNotifications } = require(path.join(__dirname, '..', 'src', 'notify.js'));
    const db = makeDb([{
      task_key: 'tasks/20240101-120000-fail/status',
      last_status: 'failed',
      last_updated: new Date().toISOString(),
    }]);
    const result = await sendTaskNotifications(db);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
  });
});
