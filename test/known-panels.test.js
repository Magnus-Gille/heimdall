'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  knownPanelsFor, KNOWN, panelAliasOwnerOf, panelServiceIdsFor,
} = require('../src/plugins/known-panels');
const { pollService } = require('../src/discovery');

const NOW = Date.parse('2026-06-24T12:00:00Z');

describe('knownPanelsFor', () => {
  it('returns the 2 hugin panels for "hugin"', () => {
    const panels = knownPanelsFor('hugin');
    assert.equal(panels.length, 2);
    assert.equal(panels[0].id, 'hugin-tasks');
    assert.equal(panels[0].plugin, 'hugin');
    assert.equal(panels[0].view, 'tasks');
    assert.equal(panels[0].fullWidth, true);
    assert.equal(panels[1].id, 'hugin-history');
    assert.equal(panels[1].plugin, 'hugin');
    assert.equal(panels[1].view, 'history');
    assert.equal(panels[1].fullWidth, true);
  });

  it('returns the 1 skuld panel for "skuld"', () => {
    const panels = knownPanelsFor('skuld');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].id, 'skuld-briefing');
    assert.equal(panels[0].plugin, 'skuld');
    assert.equal(panels[0].view, 'briefing');
    assert.equal(panels[0].label, 'Daily Briefing');
    assert.equal(panels[0].refresh, 300);
    assert.equal(panels[0].fullWidth, true);
  });

  it('returns [] for an unknown service name', () => {
    assert.deepEqual(knownPanelsFor('unknown-service'), []);
    assert.deepEqual(knownPanelsFor(''), []);
    assert.deepEqual(knownPanelsFor(null), []);
  });

  it('returns independent copies (mutations do not affect KNOWN)', () => {
    const a = knownPanelsFor('hugin');
    a[0].label = 'MUTATED';
    const b = knownPanelsFor('hugin');
    assert.notEqual(b[0].label, 'MUTATED');
  });
});

describe('panel service aliases (#102)', () => {
  it('m5-inference is owned by m5-gateway', () => {
    assert.equal(panelAliasOwnerOf('m5-inference'), 'm5-gateway');
  });

  it('non-aliased names have no owner', () => {
    assert.equal(panelAliasOwnerOf('m5-gateway'), null);
    assert.equal(panelAliasOwnerOf('brokkr'), null);
    assert.equal(panelAliasOwnerOf(''), null);
    assert.equal(panelAliasOwnerOf(null), null);
  });

  it('panelServiceIdsFor returns the page id plus every producer id it owns', () => {
    assert.deepEqual(panelServiceIdsFor('m5-gateway'), ['m5-gateway', 'm5-inference']);
  });

  it('panelServiceIdsFor returns just the name for services without aliases', () => {
    assert.deepEqual(panelServiceIdsFor('brokkr'), ['brokkr']);
  });
});

describe('discovery.pollService — known panels injection', () => {
  // Tier-3 (config-only): no endpoints → unreachable; known panels injected
  it('injects hugin known panels for a Tier-3 (config-only) hugin entry', async () => {
    const svc = { name: 'hugin', health_url: 'http://hugin/health' };
    const snap = await pollService(svc, {
      fetchJson: async () => { throw new Error('ECONNREFUSED'); },
      now: NOW,
      knownPanels: knownPanelsFor,
    });
    assert.equal(snap.source, 'config');
    assert.equal(snap.reachable, false);
    assert.equal(snap.descriptor.panels.length, 2);
    assert.equal(snap.descriptor.panels[0].plugin, 'hugin');
  });

  // Tier-2 (/health): health responds; known panels injected
  it('injects hugin known panels for a Tier-2 (/health) hugin entry', async () => {
    const svc = { name: 'hugin', health_url: 'http://hugin/health' };
    const fetchJson = async (url) => {
      if (url.endsWith('heimdall.json')) return { ok: false, status: 404, json: null };
      return { ok: true, status: 200, json: { status: 'ok', version: 'abc' } };
    };
    const snap = await pollService(svc, {
      fetchJson,
      now: NOW,
      knownPanels: knownPanelsFor,
    });
    assert.equal(snap.source, 'health');
    assert.equal(snap.reachable, true);
    assert.equal(snap.descriptor.panels.length, 2);
    assert.equal(snap.descriptor.panels[0].plugin, 'hugin');
    assert.equal(snap.descriptor.panels[0].view, 'tasks');
  });

  // Tier-1 (self-describing): descriptor owns its panels; NOT overridden
  it('does NOT override panels for a Tier-1 self-describing service', async () => {
    const svc = { name: 'hugin', health_url: 'http://hugin/health' };
    const ownPanel = { id: 'custom', plugin: 'custom', view: 'custom-view' };
    const descriptor = {
      service: { name: 'hugin' }, kind: 'http-service', status: 'pass',
      panels: [ownPanel],
    };
    const fetchJson = async (url) => {
      if (url.endsWith('heimdall.json')) return { ok: true, status: 200, json: descriptor };
      return { ok: true, status: 200, json: { status: 'ok' } };
    };
    const snap = await pollService(svc, {
      fetchJson,
      now: NOW,
      knownPanels: knownPanelsFor,
    });
    assert.equal(snap.source, 'descriptor');
    // Tier-1 owns its panels; we must not override them
    assert.equal(snap.descriptor.panels.length, 1);
    assert.equal(snap.descriptor.panels[0].id, 'custom');
  });
});
