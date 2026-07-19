'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadServices, loadServicesWithMeta, deriveBaseServices } = require('../src/config/services');

function tmpJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-cfg-'));
  const p = path.join(dir, 'f.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A minimal grimnir services.json shaped like the real one.
const GRIMNIR = {
  components: [
    { name: 'munin-memory', repo: 'munin-memory', host: 'control-node.local', port: 3030, deploy_path: '/home/heimdall/munin-memory', systemd_units: [{ name: 'munin-memory', type: 'service' }] },
    { name: 'mimir', repo: 'mimir', host: 'nas.local', port: 3031, deploy_path: '/home/heimdall/mimir-server', systemd_units: [{ name: 'mimir', type: 'service' }] },
    { name: 'heimdall', repo: 'heimdall', host: 'control-node.local', port: 3033, deploy_path: '/home/heimdall/repos/heimdall', systemd_units: [{ name: 'heimdall', type: 'service' }, { name: 'heimdall-collect', type: 'timer' }, { name: 'heimdall-maintain', type: 'timer' }] },
    { name: 'brokkr', repo: 'brokkr', host: 'control-node.local', port: null, deploy_path: '/home/heimdall/repos/brokkr', systemd_units: [{ name: 'brokkr-maintenance-os', type: 'timer' }, { name: 'brokkr-maintenance-deps', type: 'timer' }] },
    { name: 'verdandi', repo: 'verdandi', host: 'control-node.local', port: 3036, deploy_path: '/home/heimdall/repos/verdandi', systemd_units: [{ name: 'verdandi', type: 'service' }] },
    { name: 'fortnox-mcp', repo: 'fortnox-mcp', host: null, port: null, systemd_units: [] },
  ],
};

const OVERLAY = {
  services: [
    { name: 'munin-memory', host: 'control-node', health_url: 'http://localhost:3030/health', repo: 'Magnus-Gille/munin-memory', deploy_path: '/home/heimdall/munin-memory' },
    { name: 'mimir', host: 'nas', health_url: 'http://192.0.2.20:3031/health', ssh_host: '192.0.2.20', repo: 'Magnus-Gille/mimir', deploy_path: '/home/heimdall/repos/mimir' },
    { name: 'heimdall', host: 'control-node', health_url: 'http://192.0.2.10:3033/api/health', repo: 'Magnus-Gille/heimdall', deploy_path: '/home/heimdall/repos/heimdall' },
    { name: 'verdandi', monitor: false },
    { name: 'brokkr-maintenance-os', host: 'control-node', type: 'timer', repo: 'Magnus-Gille/brokkr', systemd_unit: 'brokkr-maintenance-os', deploy_path: '/home/heimdall/repos/brokkr' },
    { name: 'brokkr-maintenance-deps', host: 'control-node', type: 'timer', repo: 'Magnus-Gille/brokkr', systemd_unit: 'brokkr-maintenance-deps', deploy_path: '/home/heimdall/repos/brokkr' },
    { name: 'hugin-daily-analysis', host: 'control-node', type: 'timer', repo: 'Magnus-Gille/hugin', systemd_unit: 'hugin-daily-analysis', deploy_path: '/home/heimdall/repos/hugin', additive: true },
    { name: 'tallriksvis', host: 'control-node', type: 'static', health_url: 'http://localhost/', additive: true },
  ],
};

const quietLogger = { warn: () => {} };
const load = (grimnir, overlay, extra = {}) => loadServices({
  grimnirPath: grimnir === null ? '/no/such/file.json' : tmpJson(grimnir),
  configPath: tmpJson(overlay),
  logger: quietLogger,
  ...extra,
});

describe('config/services deriveBaseServices (#92)', () => {
  it('emits one server entry per service-unit and one timer entry per timer-unit', () => {
    const base = deriveBaseServices(GRIMNIR);
    const byName = Object.fromEntries(base.map((b) => [b.name, b]));
    // heimdall component → 1 server + 2 timers
    assert.ok(byName['heimdall'] && !byName['heimdall'].type, 'heimdall is a server (no timer type)');
    assert.equal(byName['heimdall-collect'].type, 'timer');
    assert.equal(byName['heimdall-maintain'].type, 'timer');
    // brokkr → 2 timers, no server (no service unit)
    assert.equal(byName['brokkr-maintenance-os'].type, 'timer');
    assert.equal(byName['brokkr'], undefined);
  });

  it('strips .local and defaults localhost health URLs for the heimdall host', () => {
    const base = deriveBaseServices(GRIMNIR);
    const munin = base.find((b) => b.name === 'munin-memory');
    assert.equal(munin.host, 'control-node');
    assert.equal(munin.health_url, 'http://localhost:3030/health');
    const mimir = base.find((b) => b.name === 'mimir');
    assert.equal(mimir.host, 'nas');
    assert.equal(mimir.health_url, 'http://nas:3031/health'); // non-heimdall host → named
  });

  it('skips components with no systemd units (e.g. fortnox-mcp)', () => {
    const base = deriveBaseServices(GRIMNIR);
    assert.ok(!base.some((b) => b.name === 'fortnox-mcp'));
  });

  it('gives multiple service-type units in one component distinct names (no PK collision)', () => {
    const g = { components: [
      { name: 'multi', repo: 'multi', host: 'control-node.local', port: 4000, deploy_path: '/x', systemd_units: [
        { name: 'multi-api', type: 'service' },
        { name: 'multi-worker', type: 'service' },
      ] },
    ] };
    const base = deriveBaseServices(g);
    const names = base.map((b) => b.name).sort();
    assert.deepEqual(names, ['multi-api', 'multi-worker'], 'each service unit keeps its own name');
    // sanity: no two entries share a name (would collide on the snapshot PK)
    assert.equal(new Set(names).size, names.length);
  });

  it('keeps the component name when there is exactly one service unit (overlay keying preserved)', () => {
    const base = deriveBaseServices(GRIMNIR);
    // munin-memory component's single service unit → emitted as 'munin-memory'
    assert.ok(base.some((b) => b.name === 'munin-memory'));
  });
});

describe('config/services loadServices merge (#92)', () => {
  it('overlay probe details win over derived defaults (health_url, ssh_host)', () => {
    const out = load(GRIMNIR, OVERLAY);
    const byName = Object.fromEntries(out.map((s) => [s.name, s]));
    assert.equal(byName['heimdall'].health_url, 'http://192.0.2.10:3033/api/health');
    assert.equal(byName['mimir'].ssh_host, '192.0.2.20');
    assert.equal(byName['mimir'].health_url, 'http://192.0.2.20:3031/health');
  });

  it('keeps registry-owned identity/deployment facts authoritative over a stale overlay', () => {
    const overlay = { services: [
      {
        name: ' Mimir ',
        host: 'stale-host',
        repo: 'Wrong-Owner/wrong-repo',
        deploy_path: '/home/heimdall/repos/mimir',
        systemd_unit: 'stale-unit',
        type: 'timer',
        health_url: 'http://192.0.2.20:3031/health',
        ssh_host: '192.0.2.20',
      },
    ] };
    const mimir = load(GRIMNIR, overlay).find((service) => service.name === 'mimir');

    assert.deepEqual(
      {
        name: mimir.name,
        host: mimir.host,
        repo: mimir.repo,
        deploy_path: mimir.deploy_path,
        systemd_unit: mimir.systemd_unit,
        type: mimir.type,
      },
      {
        name: 'mimir',
        host: 'nas',
        repo: 'Magnus-Gille/mimir',
        deploy_path: '/home/heimdall/mimir-server',
        systemd_unit: 'mimir',
        type: undefined,
      },
    );
    assert.equal(mimir.health_url, 'http://192.0.2.20:3031/health');
    assert.equal(mimir.ssh_host, '192.0.2.20');
  });

  it('surfaces new grimnir timer units not in the overlay', () => {
    const out = load(GRIMNIR, OVERLAY).map((s) => s.name);
    assert.ok(out.includes('heimdall-collect'));
    assert.ok(out.includes('heimdall-maintain'));
  });

  it('appends additive overlay entries not present in grimnir (tallriksvis, hugin-daily-analysis)', () => {
    const out = load(GRIMNIR, OVERLAY).map((s) => s.name);
    assert.ok(out.includes('tallriksvis'));
    assert.ok(out.includes('hugin-daily-analysis'));
  });

  it('drops a stale overlay entry after a grimnir rename (unmatched, not additive)', () => {
    // Overlay still lists the OLD name; grimnir has renamed it. Old must vanish,
    // new must appear — with no overlay edit. This is the core #92 guarantee.
    const overlay = { services: [
      ...OVERLAY.services,
      { name: 'grimnir-maintenance-os', host: 'control-node', type: 'timer', repo: 'Magnus-Gille/grimnir', systemd_unit: 'grimnir-maintenance-os', deploy_path: '/home/heimdall/repos/grimnir' },
    ] };
    const out = load(GRIMNIR, overlay).map((s) => s.name);
    assert.ok(!out.includes('grimnir-maintenance-os'), 'stale renamed unit is dropped');
    assert.ok(out.includes('brokkr-maintenance-os'), 'new name comes from grimnir');
  });

  it('matches overlay to base case/whitespace-insensitively (probe details not lost)', () => {
    // Grimnir names it 'mimir'; overlay pins probe details under ' Mimir ' —
    // the merge must still apply the overlay, not drop it as stale.
    const overlay = { services: [
      { name: ' Mimir ', host: 'nas', health_url: 'http://192.0.2.20:3031/health', ssh_host: '192.0.2.20' },
      ...OVERLAY.services.filter((s) => s.name !== 'mimir'),
    ] };
    const out = load(GRIMNIR, overlay);
    const mimir = out.find((s) => (s.name || '').trim().toLowerCase() === 'mimir');
    assert.ok(mimir, 'mimir still present');
    assert.equal(mimir.ssh_host, '192.0.2.20', 'overlay probe detail applied despite case/space');
    assert.equal(mimir.health_url, 'http://192.0.2.20:3031/health');
    assert.ok(!out.some((s) => s.name === ' Mimir '), 'overlay not appended as a stale duplicate');
  });

  it('monitor:false excludes the intentionally inactive Verdandi component', () => {
    const out = load(GRIMNIR, OVERLAY).map((s) => s.name);
    assert.ok(!out.includes('verdandi'), 'explicitly unmonitored Verdandi is excluded');
    assert.ok(out.includes('heimdall-collect'), 'unrelated derived services remain');
  });

  it('does not leak overlay bookkeeping fields (additive/monitor) into runtime entries', () => {
    const out = load(GRIMNIR, OVERLAY);
    const tallriksvis = out.find((s) => s.name === 'tallriksvis');
    assert.ok(!('additive' in tallriksvis), 'additive flag stripped');
  });
});

describe('config/services fallback (#92)', () => {
  it('returns monitored overlay services when grimnir services.json is unreadable', () => {
    const out = load(null, OVERLAY).map((s) => s.name);
    // Every monitored overlay service is present; nothing is derived.
    assert.ok(out.includes('munin-memory'));
    assert.ok(out.includes('brokkr-maintenance-os'));
    assert.ok(out.includes('tallriksvis'));
    assert.ok(!out.includes('verdandi'), 'monitor:false remains authoritative in fallback mode');
    assert.equal(out.length, OVERLAY.services.filter((s) => s.monitor !== false).length);
  });

  it('fallback still strips bookkeeping fields and honours monitor:false', () => {
    const overlay = { services: [...OVERLAY.services, { name: 'x', host: 'h', monitor: false }] };
    const out = load(null, overlay);
    assert.ok(!out.some((s) => s.name === 'x'), 'monitor:false excluded in fallback too');
    assert.ok(!out.some((s) => 'additive' in s), 'no additive flag leaks');
  });
});

describe('config/services robustness (#92 Codex review)', () => {
  it('tolerates malformed overlay entries (null / non-object / empty name) without crashing', () => {
    const overlay = { services: [null, 'oops', { host: 'h' }, { name: '' }, ...OVERLAY.services] };
    // Must not throw in either the derived path or the fallback path.
    const derived = load(GRIMNIR, overlay).map((s) => s.name);
    assert.ok(derived.includes('munin-memory'), 'valid entries survive');
    assert.ok(!derived.includes(''), 'empty-name entry dropped');
    const fallback = load(null, overlay).map((s) => s.name);
    assert.ok(fallback.includes('munin-memory'));
    assert.ok(!fallback.some((n) => n === '' || n == null));
  });
});

describe('config/services loadServicesWithMeta source (#92 Codex review)', () => {
  it('reports source=grimnir when the single source of truth was read', () => {
    const r = loadServicesWithMeta({ grimnirPath: tmpJson(GRIMNIR), configPath: tmpJson(OVERLAY), logger: quietLogger });
    assert.equal(r.source, 'grimnir');
    assert.ok(r.services.length > 0);
  });

  it('reports source=fallback when grimnir services.json is unreadable', () => {
    const r = loadServicesWithMeta({ grimnirPath: '/no/such/file.json', configPath: tmpJson(OVERLAY), logger: quietLogger });
    assert.equal(r.source, 'fallback');
    assert.ok(r.services.length > 0, 'fallback still returns the overlay list');
  });
});
