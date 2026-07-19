'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { activeAlertsStrip } = require('../src/render/components');
const { openDatabase, createAlert, getActiveAlerts, resolveAlertById } = require('../src/db');

describe('activeAlertsStrip — db rows → sticky strip', () => {
  it('maps the v1 severity vocabulary onto crit/warn/info', () => {
    const html = activeAlertsStrip([
      { id: 1, severity: 'critical', title: 'Boot fail', detail: 'x', host: 'control-node' },
      { id: 2, severity: 'warning', title: 'M5 down', detail: 'y', host: 'm5' },
      { id: 3, severity: 'whatever', title: 'Mystery', detail: 'z', host: 'nas' },
    ]);
    assert.ok(/class="alert crit"/.test(html), 'critical → crit');
    assert.ok(/class="alert warn"/.test(html), 'warning → warn');
    assert.ok(/class="alert info"/.test(html), 'unknown → info');
    // crit sorts first and gets role="alert"
    assert.ok(html.indexOf('Boot fail') < html.indexOf('M5 down'), 'severity-sorted, crit first');
    assert.ok(/role="alert"/.test(html));
  });

  it('renders detail as body, a dismiss button (by id), and the source/host tag', () => {
    const html = activeAlertsStrip([{ id: 7, severity: 'warning', title: 'T', detail: 'because reasons', host: 'm5' }]);
    assert.ok(html.includes('because reasons'), 'detail → body');
    assert.ok(html.includes('hx-delete="/api/alerts/7"'), 'dismiss button keyed by id');
    assert.ok(html.includes('m5'), 'host shown as source when no explicit source');
  });

  it('prefers an explicit source column over host', () => {
    const html = activeAlertsStrip([{ id: 1, severity: 'info', title: 'T', source: 'm5-gateway', host: 'm5' }]);
    assert.ok(html.includes('m5-gateway'));
  });

  it('truncates a long detail to keep the strip a one-liner', () => {
    const long = 'a'.repeat(300);
    const html = activeAlertsStrip([{ id: 1, severity: 'info', title: 'T', detail: long }]);
    assert.ok(html.includes('…'), 'truncated with ellipsis');
    assert.ok(!html.includes('a'.repeat(200)), 'not the full 300-char body');
  });

  it('empty input returns empty string (mount collapses via :empty CSS rule)', () => {
    const html = activeAlertsStrip([]);
    assert.equal(html, '', 'empty alert list → empty string so .alert-strip-mount:empty hides');
  });

  it('escapes a title carrying markup (XSS)', () => {
    const html = activeAlertsStrip([{ id: 1, severity: 'warn', title: '<script>alert(1)</script>', host: 'x' }]);
    assert.ok(!/<script>alert/.test(html));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

describe('resolveAlertById — dismiss by id', () => {
  function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-alert-'));
    return openDatabase(path.join(dir, 'test.db'));
  }

  it('resolves an active alert and removes it from getActiveAlerts', () => {
    const db = freshDb();
    const id = createAlert(db, 'm5', 'system', 'warning', 'M5 down', 'detail');
    assert.equal(getActiveAlerts(db).length, 1);
    assert.equal(resolveAlertById(db, id), true);
    assert.equal(getActiveAlerts(db).length, 0, 'resolved alert leaves the active set');
  });

  it('returns false for an unknown / already-resolved id', () => {
    const db = freshDb();
    const id = createAlert(db, 'm5', 'system', 'warning', 'M5 down', 'detail');
    assert.equal(resolveAlertById(db, 999999), false, 'unknown id');
    assert.equal(resolveAlertById(db, id), true);
    assert.equal(resolveAlertById(db, id), false, 'already resolved → no-op');
  });
});
