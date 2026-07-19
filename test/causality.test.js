'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectCausalityHint } = require('../src/causality');

describe('detectCausalityHint', () => {
  it('returns null when no patterns match', () => {
    const result = detectCausalityHint({ cpu_temp: 40, load_1m: 0.5 }, { state: 'healthy' }, []);
    assert.strictEqual(result, null);
  });

  it('returns null for empty inputs', () => {
    assert.strictEqual(detectCausalityHint(null, null, null), null);
    assert.strictEqual(detectCausalityHint({}, null, []), null);
  });

  it('detects NAS down + stale backups', () => {
    const result = detectCausalityHint(
      {},
      { state: 'unreachable' },
      [{ category: 'backup', severity: 'warning' }]
    );
    assert.ok(result);
    assert.ok(result.hint.includes('NAS'));
  });

  it('detects NAS ssh_broken + stale backups', () => {
    const result = detectCausalityHint(
      {},
      { state: 'ssh_broken' },
      [{ category: 'backup', severity: 'critical' }]
    );
    assert.ok(result);
    assert.ok(result.hint.includes('NAS'));
  });

  it('does not fire NAS rule when NAS is healthy', () => {
    const result = detectCausalityHint(
      {},
      { state: 'healthy' },
      [{ category: 'backup', severity: 'warning' }]
    );
    // Should not match NAS rule — may match another or return null
    if (result) assert.ok(!result.hint.includes('NAS connectivity'));
  });

  it('detects thermal throttling', () => {
    const result = detectCausalityHint(
      { cpu_temp: 80, cpu_throttled: 0x4, load_1m: 3 },
      { state: 'healthy' },
      []
    );
    assert.ok(result);
    assert.ok(result.hint.includes('Thermal'));
  });

  it('detects memory pressure', () => {
    const result = detectCausalityHint(
      { mem_used_pct: 92, swap_used_pct: 30, load_1m: 3 },
      { state: 'healthy' },
      []
    );
    assert.ok(result);
    assert.ok(result.hint.includes('Memory'));
  });

  it('detects disk I/O bottleneck', () => {
    const result = detectCausalityHint(
      { load_1m: 3, iowait_pct: 25, disk_used_pct_sd: 85 },
      { state: 'healthy' },
      []
    );
    assert.ok(result);
    assert.ok(result.hint.includes('Disk'));
  });

  it('detects collector failure', () => {
    const result = detectCausalityHint(
      { collector_success: 0 },
      { state: 'healthy' },
      []
    );
    assert.ok(result);
    assert.ok(result.hint.includes('Collector'));
  });

  it('detects deployment instability with restarts + drift', () => {
    const result = detectCausalityHint(
      {},
      { state: 'healthy' },
      [],
      { totalRestarts: 5, hasDrift: true }
    );
    assert.ok(result);
    assert.ok(result.hint.includes('deployment'));
  });

  it('detects service flapping without drift', () => {
    const result = detectCausalityHint(
      {},
      { state: 'healthy' },
      [],
      { totalRestarts: 5, hasDrift: false }
    );
    assert.ok(result);
    assert.ok(result.hint.includes('flapping'));
  });

  it('does not fire restart rules with low restart count', () => {
    const result = detectCausalityHint(
      {},
      { state: 'healthy' },
      [],
      { totalRestarts: 2, hasDrift: true }
    );
    assert.strictEqual(result, null);
  });

  it('most specific rule wins (NAS > thermal)', () => {
    const result = detectCausalityHint(
      { cpu_temp: 80, cpu_throttled: 0x4, load_1m: 3 },
      { state: 'unreachable' },
      [{ category: 'backup', severity: 'warning' }]
    );
    // NAS rule should win because it's checked first
    assert.ok(result);
    assert.ok(result.hint.includes('NAS'));
  });
});
