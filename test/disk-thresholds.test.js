'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDiskThresholds, validateDiskThresholds } = require('../src/config/disk-thresholds');

function tmpConfig(config) {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-disk-config-')), 'config.json');
  fs.writeFileSync(filename, JSON.stringify(config));
  return filename;
}

describe('disk-volume configuration (#29)', () => {
  it('derives thresholds from retained quota reserve rather than a global 80%', () => {
    const volumes = validateDiskThresholds({
      tm: {
        purpose: 'quota_backup', total_bytes: 1_800, quota_bytes: 1_500,
        warning_reserve_fraction: 0.5, critical_reserve_fraction: 0.25,
      },
    });
    assert.equal(volumes.tm.warning, 91.66666666666666);
    assert.equal(volumes.tm.critical, 95.83333333333334);
  });

  it('inherits the public volume policy when a private overlay omits it', () => {
    const volumes = loadDiskThresholds(tmpConfig({ fleet: {} }));
    assert.equal(volumes.disk_used_pct_nas.purpose, 'quota_backup');
    assert.equal(volumes.disk_used_pct_m5.purpose, 'quota_backup');
  });

  it('rejects an explicit malformed private volume policy instead of falling back silently', () => {
    assert.throws(
      () => loadDiskThresholds(tmpConfig({ disk_volumes: { disk: { purpose: 'general', warning_pct: 90, critical_pct: 80 } } })),
      /critical_pct.*greater than warning_pct/u,
    );
  });
});
