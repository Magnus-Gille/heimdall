'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listThermalZones,
  selectCpuTempC,
  readCpuTempC,
  parseTempMillideg,
  buildZoneEnumerateShellSnippet,
  parseZoneEnumerateOutput,
} = require('../src/thermal');
const { CPU_TEMP_ZONE_TYPES } = require('../src/config/thermal-zone-types');
const { collectLocalMetrics } = require('../src/metrics');

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeSysfsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-thermal-'));
}

// zones: array of { index, type, temp } (temp omitted -> no temp file;
// type omitted -> no type file; unreadable: true -> chmod 000 the temp file).
function writeZones(root, zones) {
  for (const z of zones) {
    const dir = path.join(root, `thermal_zone${z.index}`);
    fs.mkdirSync(dir, { recursive: true });
    if (z.type !== undefined) fs.writeFileSync(path.join(dir, 'type'), `${z.type}\n`);
    if (z.temp !== undefined) {
      const tempPath = path.join(dir, 'temp');
      fs.writeFileSync(tempPath, `${z.temp}\n`);
      if (z.unreadable) fs.chmodSync(tempPath, 0o000);
    }
  }
}

function cleanup(root) {
  // Restore permissions before recursive removal (chmod 000 files would
  // otherwise fail an unprivileged rm on some platforms).
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
}

// ─── Representative sysfs layouts ───────────────────────────────────────────

describe('listThermalZones + selectCpuTempC — representative layouts', () => {
  it('Pi-style single cpu-thermal zone', () => {
    const root = makeSysfsRoot();
    try {
      writeZones(root, [{ index: 0, type: 'cpu-thermal', temp: 45678 }]);
      const { missing, zones } = listThermalZones(root);
      assert.equal(missing, false);
      assert.equal(zones.length, 1);
      const result = selectCpuTempC(zones);
      assert.equal(result.status, 'ok');
      assert.equal(result.value, 45.7);
      assert.equal(result.zoneType, 'cpu-thermal');
    } finally {
      cleanup(root);
    }
  });

  it('x86-style multi-zone layout picks the configured package sensor, not the first zone', () => {
    const root = makeSysfsRoot();
    try {
      writeZones(root, [
        { index: 0, type: 'acpitz', temp: 27000 },
        { index: 1, type: 'x86_pkg_temp', temp: 52300 },
        { index: 2, type: 'iwlwifi_1', temp: 40000 },
      ]);
      const result = selectCpuTempC(listThermalZones(root).zones);
      assert.equal(result.status, 'ok');
      assert.equal(result.value, 52.3);
      assert.equal(result.zoneType, 'x86_pkg_temp');
    } finally {
      cleanup(root);
    }
  });

  it('reordered zones (same types, different indices) select the same reading — proves index is never used', () => {
    const rootA = makeSysfsRoot();
    const rootB = makeSysfsRoot();
    try {
      writeZones(rootA, [
        { index: 0, type: 'cpu-thermal', temp: 50000 },
        { index: 1, type: 'gpu-thermal', temp: 41000 },
      ]);
      // Same two zones, boot-reassigned to opposite indices (e.g. after a reboot).
      writeZones(rootB, [
        { index: 0, type: 'gpu-thermal', temp: 41000 },
        { index: 1, type: 'cpu-thermal', temp: 50000 },
      ]);
      const resultA = selectCpuTempC(listThermalZones(rootA).zones);
      const resultB = selectCpuTempC(listThermalZones(rootB).zones);
      assert.equal(resultA.status, 'ok');
      assert.equal(resultB.status, 'ok');
      assert.equal(resultA.value, resultB.value);
      assert.equal(resultA.zoneType, resultB.zoneType);
      assert.equal(resultA.zoneType, 'cpu-thermal');
      // Indices differ — selection tracked type, not position.
      assert.notEqual(resultA.zoneIndex, resultB.zoneIndex);
    } finally {
      cleanup(rootA);
      cleanup(rootB);
    }
  });

  it('missing sysfs tree — no crash, unknown with a distinct reason, never 0', () => {
    const root = path.join(os.tmpdir(), 'heimdall-thermal-does-not-exist-' + Date.now());
    const result = readCpuTempC(root);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'sysfs-missing');
    assert.equal(result.value, null);
  });

  it('unreadable zone (EACCES on temp) — unknown, not a healthy 0', () => {
    const root = makeSysfsRoot();
    try {
      writeZones(root, [{ index: 0, type: 'cpu-thermal', temp: 45000, unreadable: true }]);
      const result = selectCpuTempC(listThermalZones(root).zones);
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, 'zone-unreadable');
      assert.equal(result.value, null);
      assert.equal(result.zoneType, 'cpu-thermal'); // the zone was found, just unreadable
    } finally {
      cleanup(root);
    }
  });

  it('malformed temp value — unknown, not a crash or a coerced number', () => {
    const root = makeSysfsRoot();
    try {
      fs.mkdirSync(path.join(root, 'thermal_zone0'));
      fs.writeFileSync(path.join(root, 'thermal_zone0', 'type'), 'cpu-thermal\n');
      fs.writeFileSync(path.join(root, 'thermal_zone0', 'temp'), 'not-a-number\n');
      const result = selectCpuTempC(listThermalZones(root).zones);
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, 'zone-malformed');
      assert.equal(result.value, null);
    } finally {
      cleanup(root);
    }
  });

  it('no zone matches any configured type — unknown, distinguishable from "no zones at all"', () => {
    const root = makeSysfsRoot();
    try {
      writeZones(root, [{ index: 0, type: 'some-unrelated-sensor', temp: 12345 }]);
      const result = selectCpuTempC(listThermalZones(root).zones);
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, 'no-matching-zone');
      assert.equal(result.value, null);
    } finally {
      cleanup(root);
    }
  });

  it('empty thermal directory (tree exists, zero zones) is reported distinctly from a missing tree', () => {
    const root = makeSysfsRoot();
    try {
      const result = readCpuTempC(root);
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, 'no-zones');
      assert.equal(result.value, null);
    } finally {
      cleanup(root);
    }
  });

  it('configurable priority list — a custom mapping can prefer a type not in the default list', () => {
    const root = makeSysfsRoot();
    try {
      writeZones(root, [{ index: 0, type: 'my-custom-soc-sensor', temp: 55000 }]);
      const zones = listThermalZones(root).zones;
      assert.equal(selectCpuTempC(zones).status, 'unknown'); // not in the default priority list
      const custom = selectCpuTempC(zones, ['my-custom-soc-sensor', ...CPU_TEMP_ZONE_TYPES]);
      assert.equal(custom.status, 'ok');
      assert.equal(custom.value, 55);
    } finally {
      cleanup(root);
    }
  });
});

describe('parseTempMillideg', () => {
  it('converts millidegrees to Celsius rounded to 1 decimal', () => {
    assert.equal(parseTempMillideg('45678'), 45.7);
    assert.equal(parseTempMillideg('45678\n'), 45.7);
  });

  it('handles negative temperatures', () => {
    assert.equal(parseTempMillideg('-5000'), -5);
  });

  it('returns null for non-numeric or empty content', () => {
    assert.equal(parseTempMillideg(''), null);
    assert.equal(parseTempMillideg('not-a-number'), null);
    assert.equal(parseTempMillideg('45.678'), null); // sysfs temp is always a bare integer
    assert.equal(parseTempMillideg(undefined), null);
  });
});

// ─── Remote (SSH) enumeration parsing ───────────────────────────────────────

describe('buildZoneEnumerateShellSnippet + parseZoneEnumerateOutput (NAS/SSH path)', () => {
  it('round-trips a realistic multi-zone remote payload', () => {
    const output = 'cpu-thermal\t50000\ngpu-thermal\t41000\n';
    const zones = parseZoneEnumerateOutput(output);
    assert.equal(zones.length, 2);
    const result = selectCpuTempC(zones);
    assert.equal(result.status, 'ok');
    assert.equal(result.value, 50);
    assert.equal(result.zoneType, 'cpu-thermal');
  });

  it('empty output (missing tree or zero zones on the remote host) selects unknown, not 0', () => {
    const result = selectCpuTempC(parseZoneEnumerateOutput(''));
    assert.equal(result.status, 'unknown');
    assert.equal(result.value, null);
  });

  it('a line with an unreadable temp (empty second field) is unknown for that type, not 0', () => {
    const result = selectCpuTempC(parseZoneEnumerateOutput('cpu-thermal\t\n'));
    assert.equal(result.status, 'unknown');
    assert.equal(result.value, null);
    assert.equal(result.zoneType, 'cpu-thermal');
  });

  it('the emitted snippet globs thermal_zone* and never references a specific index', () => {
    const snippet = buildZoneEnumerateShellSnippet();
    assert.ok(snippet.includes('thermal_zone*/'));
    assert.ok(!/thermal_zone\d/.test(snippet), 'must not hard-code a zone index');
  });
});

describe('collectLocalMetrics — cpu_temp integration', () => {
  it('always returns a { value, unit } shape and never throws, even without a real thermal tree (dev/CI host)', () => {
    const metrics = collectLocalMetrics().metrics;
    assert.ok('cpu_temp' in metrics);
    assert.equal(metrics.cpu_temp.unit, 'celsius');
    assert.ok(metrics.cpu_temp.value === null || typeof metrics.cpu_temp.value === 'number');
  });
});
