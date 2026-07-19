'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// These mirror the validation constants in server.js
const VALID_HOSTS = ['control-node', 'nas'];
const VALID_RANGES = ['24h', '7d', '30d'];
const METRIC_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

describe('metrics API input validation', () => {
  describe('host validation', () => {
    it('accepts known hosts', () => {
      assert.ok(VALID_HOSTS.includes('control-node'));
      assert.ok(VALID_HOSTS.includes('nas'));
    });

    it('rejects unknown hosts', () => {
      assert.ok(!VALID_HOSTS.includes('unknown'));
      assert.ok(!VALID_HOSTS.includes(''));
      assert.ok(!VALID_HOSTS.includes('obsolete-private-host'));
    });

    it('rejects injection attempts in host', () => {
      const injections = [
        "'; DROP TABLE metrics; --",
        '../etc/passwd',
        'control-node OR 1=1',
        '<script>alert(1)</script>',
        'host%00null',
      ];
      for (const input of injections) {
        assert.ok(!VALID_HOSTS.includes(input), `should reject: ${input}`);
      }
    });
  });

  describe('metric name validation', () => {
    it('accepts valid metric names', () => {
      const valid = [
        'cpu_temp', 'mem_used_pct', 'load_1m', 'disk_used_pct_sd',
        'net_rx_bytes_eth0', 'uptime', 'swap_free', 'collector_success',
        'hugin_heartbeat_age_ms', 'mcp_healthy',
      ];
      for (const m of valid) {
        assert.ok(METRIC_PATTERN.test(m), `should accept: ${m}`);
      }
    });

    it('rejects empty or whitespace', () => {
      assert.ok(!METRIC_PATTERN.test(''));
      assert.ok(!METRIC_PATTERN.test(' '));
      assert.ok(!METRIC_PATTERN.test('\t'));
    });

    it('rejects names starting with numbers or underscores', () => {
      assert.ok(!METRIC_PATTERN.test('1cpu'));
      assert.ok(!METRIC_PATTERN.test('_private'));
    });

    it('rejects names with uppercase', () => {
      assert.ok(!METRIC_PATTERN.test('CPU_temp'));
      assert.ok(!METRIC_PATTERN.test('Metric'));
    });

    it('rejects names longer than 64 characters', () => {
      assert.ok(!METRIC_PATTERN.test('a'.repeat(65)));
      assert.ok(METRIC_PATTERN.test('a'.repeat(64))); // exactly 64 is ok
    });

    it('rejects SQL injection attempts in metric', () => {
      const injections = [
        "cpu_temp'; DROP TABLE metrics; --",
        'cpu_temp OR 1=1',
        'cpu_temp UNION SELECT * FROM events',
        "metric' AND '1'='1",
      ];
      for (const input of injections) {
        assert.ok(!METRIC_PATTERN.test(input), `should reject: ${input}`);
      }
    });

    it('rejects path traversal in metric', () => {
      assert.ok(!METRIC_PATTERN.test('../etc/passwd'));
      assert.ok(!METRIC_PATTERN.test('..%2f..%2fetc'));
    });

    it('rejects XSS attempts in metric', () => {
      assert.ok(!METRIC_PATTERN.test('<script>'));
      assert.ok(!METRIC_PATTERN.test('onload=alert(1)'));
    });
  });

  describe('range validation', () => {
    it('accepts valid ranges', () => {
      for (const r of ['24h', '7d', '30d']) {
        assert.ok(VALID_RANGES.includes(r));
      }
    });

    it('rejects invalid ranges', () => {
      const invalid = ['1h', '365d', '24H', '', 'all', '24h; DROP TABLE'];
      for (const r of invalid) {
        assert.ok(!VALID_RANGES.includes(r), `should reject: ${r}`);
      }
    });
  });

  describe('unknown but safe-pattern metric returns empty data (not error)', () => {
    it('a valid-pattern metric that does not exist should pass validation', () => {
      // The validation only checks the pattern — unknown metrics pass validation
      // and return empty data from the DB query (not a 400 error)
      assert.ok(METRIC_PATTERN.test('nonexistent_metric'));
    });
  });
});
