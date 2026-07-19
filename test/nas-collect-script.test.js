'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { NAS_PROBE_PATHS } = require('../src/metrics');

// The NAS probe runs as an SSH forced-command (scripts/nas-collect.sh deployed
// to /home/heimdall/heimdall-collect.sh), which OVERRIDES the command string in
// src/metrics.js. The two must stay in lockstep or production silently drifts —
// which is exactly what produced the false "Backup stale" criticals. These
// assertions lock the canonical script to the parser's expectations and to the
// path constants in metrics.js.
const script = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'nas-collect.sh'),
  'utf8'
);

describe('scripts/nas-collect.sh — canonical NAS probe', () => {
  it('emits exactly 18 section separators (19 sections, parse layout)', () => {
    const seps = script.split('\n').filter((l) => l.trim() === 'echo ---').length;
    assert.equal(seps, 18);
  });

  it('ends with the CPU core-count probe (section 18, for load normalization)', () => {
    const sections = script.split(/^echo ---$/m).map((s) => s.trim());
    assert.ok(sections[18] && sections[18].includes('nproc'),
      'section 18 must be the nproc core-count probe');
  });

  it('probes the relocated munin backup dir, not the deleted one', () => {
    assert.ok(script.includes(`ls ${NAS_PROBE_PATHS.muninBackupDir}`),
      'must list the current munin backup dir from NAS_PROBE_PATHS');
    assert.ok(!script.includes('/home/heimdall/backups/munin-memory'),
      'stale munin path (deleted 2026-04-27) must not appear');
  });

  it('measures mimir sync from the heartbeat stamp, then content mtime', () => {
    assert.ok(script.includes(`cat ${NAS_PROBE_PATHS.mimirSyncStamp}`),
      'must prefer the heartbeat stamp');
    assert.ok(script.includes(`find ${NAS_PROBE_PATHS.mimirSyncDir} -type f`),
      'must fall back to newest content mtime in the real sync dir');
    assert.ok(!script.includes('/home/heimdall/artifacts/mgc'),
      'stale mimir sync path must not appear');
  });

  it('keeps section order aligned with parseSSHOutput (munin=§7, mimir=§10)', () => {
    // Split on the separator and check the probe lands in the expected section.
    const sections = script
      .split(/^echo ---$/m)
      .map((s) => s.trim());
    assert.ok(sections[7].includes(NAS_PROBE_PATHS.muninBackupDir),
      'section 7 must be the munin backup filename probe');
    assert.ok(sections[10].includes(NAS_PROBE_PATHS.mimirSyncStamp),
      'section 10 must be the mimir sync freshness probe');
  });
});
