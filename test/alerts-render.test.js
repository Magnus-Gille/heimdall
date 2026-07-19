'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { alertsCountBadge, alertsListFragment } = require('../src/render/alerts');

describe('alertsCountBadge — nav count pill', () => {
  it('is empty when nothing is pending (mount collapses)', () => {
    assert.equal(alertsCountBadge([]), '');
    assert.equal(alertsCountBadge(null), '');
  });

  it('renders the count', () => {
    const html = alertsCountBadge([{ severity: 'warning' }, { severity: 'warning' }]);
    assert.match(html, />2</);
  });

  it('colours by the MOST severe pending alert (crit wins over warn)', () => {
    const html = alertsCountBadge([{ severity: 'warning' }, { severity: 'critical' }]);
    assert.match(html, /nav-badge crit/);
  });

  it('warning-only set is warn-coloured', () => {
    assert.match(alertsCountBadge([{ severity: 'warning' }]), /nav-badge warn/);
  });

  it('info-only set is info-coloured, NOT warn', () => {
    const html = alertsCountBadge([{ severity: 'info' }, { severity: 'notice' }]);
    assert.match(html, /nav-badge info/);
    assert.doesNotMatch(html, /nav-badge warn/);
  });

  it('unknown severity falls back to info', () => {
    assert.match(alertsCountBadge([{ severity: 'whatever' }]), /nav-badge info/);
  });
});

describe('alertsListFragment', () => {
  it('shows an all-clear card when empty', () => {
    const html = alertsListFragment([]);
    assert.match(html, /all clear/i);
  });

  it('renders the strip with dismiss controls when alerts exist', () => {
    const html = alertsListFragment([{ id: 5, severity: 'warning', title: 'Drift', detail: 'x', host: 'h' }]);
    assert.match(html, /Drift/);
    assert.match(html, /hx-delete="\/api\/alerts\/5"/);
  });
});
