'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRestartMetricRows } = require('../src/restart-evidence');

test('restart evidence rows exclude remote services until host-correct evidence exists', () => {
  const seenUnits = [];
  const rows = buildRestartMetricRows({
    timestamp: '2026-08-01T12:00:00Z',
    services: [
      { name: 'hugin', host: 'control-node', systemd_unit: 'hugin' },
      { name: 'mimir', host: 'nas', systemd_unit: 'mimir' },
    ],
    getRestartCount(unit) {
      seenUnits.push(unit);
      return unit === 'hugin' ? 2 : 9;
    },
  });

  assert.deepEqual(seenUnits, ['hugin']);
  assert.deepEqual(rows, [{
    timestamp: '2026-08-01T12:00:00Z',
    host: 'control-node',
    metric: 'service_restarts_24h_hugin',
    value: 2,
    unit: 'count',
    metadata: null,
  }]);
});
