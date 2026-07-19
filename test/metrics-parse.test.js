'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSSHOutput, computeCpuBusyPct } = require('../src/metrics');

// Build a minimal SSH output with 19 sections separated by "---\n"
function buildSSHOutput(overrides = {}) {
  const defaults = [
    '45000',                          // 0: CPU temp
    'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n', // 1: meminfo
    '',                                // 2: df
    '0.10 0.05 0.01 1/100 1234',      // 3: loadavg
    '100000.00 200000.00',             // 4: uptime
    '',                                // 5: TM mtime
    '',                                // 6: TM size
    '',                                // 7: munin backup filename
    '0',                               // 8: munin backup count
    '',                                // 9: mimir backup log
    '',                                // 10: mimir sync mtime
    '',                                // 11: CPU freq
    '',                                // 12: throttle
    '',                                // 13: under-voltage
    '',                                // 14: network
    '',                                // 15: disk SD
    '',                                // 16: disk NAS
    '',                                // 17: CPU stat
    '',                                // 18: CPU core count
  ];
  for (const [k, v] of Object.entries(overrides)) defaults[k] = v;
  return defaults.join('\n---\n');
}

describe('parseSSHOutput — backup sections', () => {
  it('parses munin backup filename from section 7', () => {
    const out = buildSSHOutput({ 7: 'memory-2026-03-15-2100.db' });
    const parsed = parseSSHOutput(out);
    assert.deepStrictEqual(parsed.munin_backup_latest, {
      value: null, unit: 'text', metadata: { filename: 'memory-2026-03-15-2100.db' },
    });
  });

  it('omits munin_backup_latest when section 7 is empty', () => {
    const out = buildSSHOutput({ 7: '' });
    const parsed = parseSSHOutput(out);
    assert.strictEqual(parsed.munin_backup_latest, undefined);
  });

  it('omits munin_backup_latest when section 7 is N/A', () => {
    const out = buildSSHOutput({ 7: 'N/A' });
    const parsed = parseSSHOutput(out);
    assert.strictEqual(parsed.munin_backup_latest, undefined);
  });

  it('parses mimir backup log line from section 9', () => {
    const out = buildSSHOutput({ 9: '2026-03-21T09:00:02Z Backup complete' });
    const parsed = parseSSHOutput(out);
    assert.deepStrictEqual(parsed.mimir_backup_last, {
      value: null, unit: 'text', metadata: { line: '2026-03-21T09:00:02Z Backup complete' },
    });
  });

  it('omits mimir_backup_last when section 9 is empty', () => {
    const out = buildSSHOutput({ 9: '' });
    const parsed = parseSSHOutput(out);
    assert.strictEqual(parsed.mimir_backup_last, undefined);
  });

  it('omits mimir_backup_last when section 9 is N/A', () => {
    const out = buildSSHOutput({ 9: 'N/A' });
    const parsed = parseSSHOutput(out);
    assert.strictEqual(parsed.mimir_backup_last, undefined);
  });

  it('parses TM backup mtime from section 5', () => {
    const out = buildSSHOutput({ 5: '1774080835' });
    const parsed = parseSSHOutput(out);
    assert.deepStrictEqual(parsed.tm_last_backup, { value: 1774080835, unit: 'epoch' });
  });

  it('omits tm_last_backup when section 5 is empty or N/A', () => {
    let out = buildSSHOutput({ 5: '' });
    assert.strictEqual(parseSSHOutput(out).tm_last_backup, undefined);
    out = buildSSHOutput({ 5: 'N/A' });
    assert.strictEqual(parseSSHOutput(out).tm_last_backup, undefined);
  });

  it('parses mimir sync mtime from section 10', () => {
    const out = buildSSHOutput({ 10: '1773610310.123' });
    const parsed = parseSSHOutput(out);
    assert.deepStrictEqual(parsed.mimir_sync_latest, { value: 1773610310, unit: 'epoch' });
  });

  it('omits mimir_sync_latest when section 10 is empty', () => {
    const out = buildSSHOutput({ 10: '' });
    assert.strictEqual(parseSSHOutput(out).mimir_sync_latest, undefined);
  });

  it('works with only 11 sections (legacy forced command)', () => {
    // Old forced command only had sections 0-10
    const sections = [
      '45000', 'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n', '',
      '0.10 0.05 0.01 1/100 1234', '100000.00 200000.00',
      '', '', 'memory-2026-03-15-2100.db', '194',
      '2026-03-21T09:00:02Z Backup complete', '1773610310',
    ];
    const out = sections.join('\n---\n');
    const parsed = parseSSHOutput(out);
    assert.ok(parsed.munin_backup_latest);
    assert.ok(parsed.mimir_backup_last);
    assert.ok(parsed.mimir_sync_latest);
    // Missing sections should not cause errors
    assert.strictEqual(parsed.cpu_freq, undefined);
  });
});

describe('parseSSHOutput — CPU core count (section 18)', () => {
  it('parses nproc into cpu_cores', () => {
    const parsed = parseSSHOutput(buildSSHOutput({ 18: '4' }));
    assert.strictEqual(parsed.cpu_cores.value, 4);
    assert.strictEqual(parsed.cpu_cores.unit, 'count');
  });

  it('omits cpu_cores when section is empty', () => {
    const parsed = parseSSHOutput(buildSSHOutput({ 18: '' }));
    assert.strictEqual(parsed.cpu_cores, undefined);
  });

  it('omits cpu_cores on a zero/garbage value', () => {
    assert.strictEqual(parseSSHOutput(buildSSHOutput({ 18: '0' })).cpu_cores, undefined);
    assert.strictEqual(parseSSHOutput(buildSSHOutput({ 18: 'xyz' })).cpu_cores, undefined);
  });
});

describe('parseSSHOutput — df section parses SD bytes (section 2)', () => {
  const df = [
    'Filesystem     1K-blocks     Used Available Use%',
    '/dev/mmcblk0p2  60293000  6432000  53861000  11%',
    '/dev/sda1     1921800000 1451900000 469900000  73%',
  ].join('\n');

  it('extracts total/used/avail for the SD device, not just the percentage', () => {
    const parsed = parseSSHOutput(buildSSHOutput({ 2: df }));
    assert.strictEqual(parsed.disk_used_pct_sd.value, 11);
    assert.strictEqual(parsed.disk_total_sd.value, 60293000 * 1024);
    assert.strictEqual(parsed.disk_avail_sd.value, 53861000 * 1024);
    assert.strictEqual(parsed.disk_used_sd.value, 6432000 * 1024);
  });

  it('still extracts the NAS (sda) volume bytes', () => {
    const parsed = parseSSHOutput(buildSSHOutput({ 2: df }));
    assert.strictEqual(parsed.disk_used_pct_nas.value, 73);
    assert.strictEqual(parsed.disk_total_nas.value, 1921800000 * 1024);
    assert.strictEqual(parsed.disk_avail_nas.value, 469900000 * 1024);
  });
});

describe('computeCpuBusyPct', () => {
  const ticks = (user, nice, system, idle, iowait) => ({
    cpu_user_ticks: user, cpu_nice_ticks: nice, cpu_system_ticks: system,
    cpu_idle_ticks: idle, cpu_iowait_ticks: iowait,
  });

  it('returns busy % = (user+nice+system) / total over the interval', () => {
    // delta: user+10, nice+0, system+10, idle+80, iowait+0 → total 100, busy 20
    const prev = ticks(100, 0, 100, 1000, 0);
    const cur = ticks(110, 0, 110, 1080, 0);
    assert.strictEqual(computeCpuBusyPct(prev, cur), 20);
  });

  it('counts iowait as not-busy (idle-waiting)', () => {
    // delta: user+10, system+0, idle+0, iowait+90 → total 100, busy 10
    const prev = ticks(100, 0, 100, 1000, 0);
    const cur = ticks(110, 0, 100, 1000, 90);
    assert.strictEqual(computeCpuBusyPct(prev, cur), 10);
  });

  it('returns null when no time elapsed (zero total delta)', () => {
    const same = ticks(100, 0, 100, 1000, 0);
    assert.strictEqual(computeCpuBusyPct(same, same), null);
  });

  it('returns null on a counter reset that leaves total positive but busy negative (reboot across a skipped cycle)', () => {
    // After reboot the busy fields collapse while idle/iowait have re-accumulated
    // past their pre-reboot values → total>0 but busy delta<0. Must not store a negative %.
    const prev = ticks(500000, 0, 200000, 100, 50000);
    const cur = ticks(1200, 0, 800, 9000000, 200);
    assert.strictEqual(computeCpuBusyPct(prev, cur), null);
  });

  it('returns null on a partial counter reset that would otherwise exceed 100%', () => {
    // idle+iowait dropped (reset) while busy rose → would compute 125% without the guard.
    const prev = ticks(0, 0, 0, 5000, 5000);
    const cur = ticks(700, 0, 300, 4900, 4900);
    assert.strictEqual(computeCpuBusyPct(prev, cur), null);
  });

  it('returns null on incomplete snapshots', () => {
    assert.strictEqual(computeCpuBusyPct(null, ticks(1, 1, 1, 1, 1)), null);
    const partial = { cpu_user_ticks: 1 };
    assert.strictEqual(computeCpuBusyPct(partial, ticks(2, 2, 2, 2, 2)), null);
  });
});
