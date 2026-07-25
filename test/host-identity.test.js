'use strict';

/**
 * Regression tests for the huginmunin/control-node identity split (defect 2a).
 *
 * One physical Pi 5 appears under two host identities:
 *   - Heimdall's own collectors hard-code `control-node`.
 *   - Grimnir's services.json declares `host: "huginmunin.local"`, so every
 *     service_versions row and every deploy alert lands on `huginmunin`.
 *   - The fleet push agent used to report `huginmunin` too.
 * The result is metric series and alerts that can never meet: an alert raised
 * against `huginmunin` is never re-evaluated, because nothing writes that host
 * any more.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalHost, loadHostAliases } = require('../src/host-identity');

describe('canonicalHost', () => {
  const aliases = { huginmunin: 'control-node' };

  it('maps a legacy identity onto the canonical one', () => {
    assert.strictEqual(canonicalHost('huginmunin', aliases), 'control-node');
  });

  it('strips a .local suffix before matching (grimnir writes huginmunin.local)', () => {
    assert.strictEqual(canonicalHost('huginmunin.local', aliases), 'control-node');
  });

  it('is case-insensitive', () => {
    assert.strictEqual(canonicalHost('HuginMunin', aliases), 'control-node');
  });

  it('leaves an unaliased host untouched (minus the .local suffix)', () => {
    assert.strictEqual(canonicalHost('nas.local', aliases), 'nas');
    assert.strictEqual(canonicalHost('m5', aliases), 'm5');
  });

  it('is a no-op without an alias table', () => {
    assert.strictEqual(canonicalHost('huginmunin'), 'huginmunin');
  });

  it('passes through non-strings unchanged', () => {
    assert.strictEqual(canonicalHost(null, aliases), null);
    assert.strictEqual(canonicalHost(undefined, aliases), undefined);
  });

  it('does not follow alias chains into a loop', () => {
    const looped = { a: 'b', b: 'a' };
    const out = canonicalHost('a', looped);
    assert.ok(out === 'a' || out === 'b', `expected a terminating result, got ${out}`);
  });
});

describe('loadHostAliases', () => {
  it('reads fleet.host_aliases from the config overlay', () => {
    const m = loadHostAliases({ fleet: { host_aliases: { huginmunin: 'control-node' } } });
    assert.strictEqual(m.huginmunin, 'control-node');
  });

  it('normalizes keys to lowercase and strips .local', () => {
    const m = loadHostAliases({ fleet: { host_aliases: { 'HuginMunin.local': 'control-node' } } });
    assert.strictEqual(m.huginmunin, 'control-node');
  });

  it('returns an empty map for a missing or malformed config', () => {
    assert.deepStrictEqual(loadHostAliases(null), {});
    assert.deepStrictEqual(loadHostAliases({}), {});
    assert.deepStrictEqual(loadHostAliases({ fleet: { host_aliases: 'nope' } }), {});
  });
});

describe('config/services host canonicalization', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { loadServices } = require('../src/config/services');

  function write(dir, name, obj) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it('rewrites a grimnir registry host through the alias table', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-hostid-'));
    const configPath = write(dir, 'heimdall.config.json', {
      services: [],
      fleet: { host_aliases: { huginmunin: 'control-node' } },
    });
    const grimnirPath = write(dir, 'services.json', {
      components: [
        { name: 'hugin', host: 'huginmunin.local', port: 3032, repo: 'hugin', systemd_units: [{ name: 'hugin', type: 'service' }] },
      ],
    });
    const services = loadServices({ configPath, grimnirPath });
    const hugin = services.find((s) => s.name === 'hugin');
    assert.strictEqual(hugin.host, 'control-node',
      'a registry host that is an alias of the local node must resolve to the canonical id');
  });
});
