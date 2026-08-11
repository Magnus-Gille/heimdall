'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildNASProbeCommand, NAS_PROBE_PATHS } = require('../src/metrics');

// Regression guard for Issue: two critical "Backup stale" alerts (Munin DB,
// Mímir Sync) were false positives caused by the NAS probe paths drifting away
// from the real infra. These assertions lock the corrected paths so a future
// relocation is caught at test time instead of silently freezing an alert.
describe('buildNASProbeCommand — probe paths track real infra', () => {
  const cmd = buildNASProbeCommand();

  it('probes the relocated munin backup dir on the external HDD', () => {
    assert.equal(NAS_PROBE_PATHS.muninBackupDir, '/mnt/timemachine/backups/munin-memory/');
    assert.ok(cmd.includes('/mnt/timemachine/backups/munin-memory/'),
      'command must list the current munin backup dir');
  });

  it('no longer references the deleted /home/heimdall/backups/munin-memory path', () => {
    assert.ok(!cmd.includes('/home/heimdall/backups/munin-memory'),
      'stale munin backup path (deleted 2026-04-27) must not appear');
  });

  it('measures mimir sync freshness from the heartbeat stamp, then content mtime', () => {
    assert.ok(cmd.includes('cat /home/heimdall/mimir-sync.stamp'),
      'must prefer the sync heartbeat stamp (run freshness)');
    assert.ok(cmd.includes('find /home/heimdall/mimir/ -type f'),
      'must fall back to newest content mtime in the real sync dir');
  });

  it('no longer references the empty /home/heimdall/artifacts/mgc sync path', () => {
    assert.ok(!cmd.includes('/home/heimdall/artifacts/mgc'),
      'stale mimir sync path must not appear');
  });

  it('keeps the 19-section layout intact (parse indices unchanged)', () => {
    // 18 "---" separators delimit sections 0..18 (18 = CPU core count).
    const separators = cmd.split('\n').filter((l) => l === 'echo "---"').length;
    assert.equal(separators, 18);
  });

  it('uses the exact five-field df output contract consumed by the parser', () => {
    assert.ok(cmd.split('\n').includes(
      'df --output=source,size,used,avail,pcent /dev/mmcblk0p2 /dev/sda1 2>/dev/null || true',
    ));
  });

  it('honours injected paths (pure builder, no hidden globals)', () => {
    const custom = buildNASProbeCommand({
      muninBackupDir: '/x/munin/',
      mimirSyncStamp: '/x/stamp',
      mimirSyncDir: '/x/mimir/',
    });
    assert.ok(custom.includes('/x/munin/'));
    assert.ok(custom.includes('cat /x/stamp'));
    assert.ok(custom.includes('find /x/mimir/ -type f'));
  });
});
