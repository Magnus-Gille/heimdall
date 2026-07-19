'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { handleAlertIngest, validateAlertEnvelope } = require('../src/alert-ingest');
const { openDatabase, getActiveAlerts, resolveAlertByDedupKey } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-ingest-'));
  return openDatabase(path.join(dir, 'test.db'));
}
const OK_AUTH = { token: 'secret', authHeader: 'Bearer secret', bindHost: '192.0.2.1' };

describe('validateAlertEnvelope', () => {
  it('requires a non-empty title', () => {
    assert.equal(validateAlertEnvelope({}).ok, false);
    assert.equal(validateAlertEnvelope({ title: '   ' }).ok, false);
    assert.equal(validateAlertEnvelope('nope').ok, false);
  });

  it('normalizes fields and defaults host/category/severity', () => {
    const v = validateAlertEnvelope({ title: 'Disk full', body: 'at 95%' });
    assert.equal(v.ok, true);
    assert.equal(v.value.title, 'Disk full');
    assert.equal(v.value.detail, 'at 95%');
    assert.equal(v.value.severity, 'warning'); // default, canonical
    assert.equal(v.value.host, 'external'); // default when no source
    assert.equal(v.value.category, 'external');
  });

  it('normalizes the wire severity vocabulary to canonical {info,warning,critical}', () => {
    const sev = (s) => validateAlertEnvelope({ title: 't', severity: s }).value.severity;
    assert.equal(sev('warn'), 'warning');
    assert.equal(sev('error'), 'critical');
    assert.equal(sev('critical'), 'critical');
    assert.equal(sev('info'), 'info');
    assert.equal(sev('bogus'), 'warning'); // unknown surfaces as warning
  });

  it('unwraps a { alert: {...} } envelope (Ratatoskr shape) and lowercases severity', () => {
    const v = validateAlertEnvelope({ chat_id: 1, alert: { title: 'X', severity: 'CRITICAL', source: 'm5-gateway', dedup_key: 'm5:down' } });
    assert.equal(v.value.title, 'X');
    assert.equal(v.value.severity, 'critical');
    assert.equal(v.value.source, 'm5-gateway');
    assert.equal(v.value.host, 'm5-gateway'); // host defaults to source
    assert.equal(v.value.dedup_key, 'm5:down');
  });

  it('accepts a resolved envelope without a title when dedup_key is present', () => {
    const v = validateAlertEnvelope({ state: 'resolved', dedup_key: 'm5:down' });
    assert.equal(v.ok, true);
    assert.equal(v.value.state, 'resolved');
    assert.equal(v.value.title, '');
  });

  it('rejects an invalid state or a resolution without dedup_key', () => {
    assert.equal(validateAlertEnvelope({ state: 'quiet', title: 'x' }).ok, false);
    const missingKey = validateAlertEnvelope({ state: 'resolved' });
    assert.equal(missingKey.ok, false);
    assert.ok(missingKey.errors.some((e) => /dedup_key/.test(e)));
  });
});

describe('handleAlertIngest — auth', () => {
  it('401s when no token configured on a non-loopback bind (fail-closed)', () => {
    const r = handleAlertIngest(freshDb(), { token: '', bindHost: '192.0.2.1', body: { title: 'x' } });
    assert.equal(r.status, 401);
  });

  it('allows tokenless loopback only when explicitly opted in', () => {
    const r = handleAlertIngest(freshDb(), { token: '', bindHost: '127.0.0.1', allowInsecureLoopback: true, body: { title: 'x' } });
    assert.equal(r.status, 200);
  });

  it('rejects a wrong/absent Bearer when a token is set', () => {
    assert.equal(handleAlertIngest(freshDb(), { token: 'secret', authHeader: 'Bearer nope', bindHost: '192.0.2.1', body: { title: 'x' } }).status, 401);
    assert.equal(handleAlertIngest(freshDb(), { token: 'secret', authHeader: '', bindHost: '192.0.2.1', body: { title: 'x' } }).status, 401);
  });
});

describe('handleAlertIngest — validate + persist', () => {
  it('400s on an invalid envelope', () => {
    const r = handleAlertIngest(freshDb(), { ...OK_AUTH, body: { severity: 'warn' } }); // no title
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some((e) => /title/.test(e)));
  });

  it('persists a pushed alert with source + dedup_key, visible via getActiveAlerts', () => {
    const db = freshDb();
    const r = handleAlertIngest(db, { ...OK_AUTH, body: { title: 'M5 pass rate low', severity: 'warn', source: 'm5-gateway', dedup_key: 'm5:pass-rate', body: '58% over 12 evals' } });
    assert.equal(r.status, 200);
    const active = getActiveAlerts(db);
    assert.equal(active.length, 1);
    assert.equal(active[0].title, 'M5 pass rate low');
    assert.equal(active[0].source, 'm5-gateway');
    assert.equal(active[0].dedup_key, 'm5:pass-rate');
    assert.equal(active[0].detail, '58% over 12 evals');
  });

  it('escalates an existing dedup_key row in place (latest push wins)', () => {
    const db = freshDb();
    handleAlertIngest(db, { ...OK_AUTH, body: { title: 'pass rate dipping', severity: 'warn', dedup_key: 'm5:pass', body: '68%' } });
    handleAlertIngest(db, { ...OK_AUTH, body: { title: 'pass rate critical', severity: 'critical', dedup_key: 'm5:pass', body: '41%' } });
    const active = getActiveAlerts(db);
    assert.equal(active.length, 1, 'still one active row for the dedup_key');
    assert.equal(active[0].severity, 'critical', 'severity escalated in place');
    assert.equal(active[0].title, 'pass rate critical', 'title refreshed');
    assert.equal(active[0].detail, '41%', 'detail refreshed');
  });

  it('collapses repeats by dedup_key (one active row), and resolveAlertByDedupKey clears it', () => {
    const db = freshDb();
    handleAlertIngest(db, { ...OK_AUTH, body: { title: 'first', dedup_key: 'k1' } });
    handleAlertIngest(db, { ...OK_AUTH, body: { title: 'second (same key)', dedup_key: 'k1' } });
    assert.equal(getActiveAlerts(db).length, 1, 'same dedup_key → single active alert');
    assert.equal(resolveAlertByDedupKey(db, 'k1'), 1);
    assert.equal(getActiveAlerts(db).length, 0);
  });

  it('resolves a firing alert through the same authenticated ingest endpoint', () => {
    const db = freshDb();
    handleAlertIngest(db, { ...OK_AUTH, body: { title: 'M5 down', dedup_key: 'm5:down' } });
    const r = handleAlertIngest(db, { ...OK_AUTH, body: { state: 'resolved', dedup_key: 'm5:down' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved, 1);
    assert.equal(getActiveAlerts(db).length, 0);
  });

  it('makes repeated resolutions idempotent', () => {
    const db = freshDb();
    const r = handleAlertIngest(db, { ...OK_AUTH, body: { state: 'resolved', dedup_key: 'absent' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved, 0);
  });

  it('500s gracefully if persistence throws', () => {
    const r = handleAlertIngest({}, { ...OK_AUTH, body: { title: 'x' }, createAlertFn: () => { throw new Error('boom'); } });
    assert.equal(r.status, 500);
    assert.ok(/boom/.test(r.body.detail));
  });

  it('500s gracefully if resolution persistence throws', () => {
    const r = handleAlertIngest({}, {
      ...OK_AUTH,
      body: { state: 'resolved', dedup_key: 'x' },
      resolveAlertByDedupKeyFn: () => { throw new Error('resolve boom'); },
    });
    assert.equal(r.status, 500);
    assert.ok(/resolve boom/.test(r.body.detail));
  });
});
