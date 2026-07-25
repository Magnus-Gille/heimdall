'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBackupDefinitions, validateBackupDefinitions } = require('../src/backup-config');

const valid = {
  'Daily backup': {
    description: 'Database backup',
    schedule: 'daily',
    expected_interval_hours: 24,
    warning_after_intervals: 1.25,
    critical_after_intervals: 2,
  },
};

describe('backup freshness configuration', () => {
  it('rejects a source without an expected cadence', () => {
    const invalid = { 'Daily backup': { ...valid['Daily backup'] } };
    delete invalid['Daily backup'].expected_interval_hours;
    assert.throws(() => validateBackupDefinitions(invalid), /expected_interval_hours/);
  });

  it('rejects thresholds that cannot progress from warning to critical', () => {
    const invalid = { 'Daily backup': { ...valid['Daily backup'] } };
    invalid['Daily backup'].critical_after_intervals = 1;
    assert.throws(() => validateBackupDefinitions(invalid), /critical_after_intervals.*greater/);
  });

  it('fails loudly when the selected config omits backup declarations', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-config-')), 'heimdall.config.json');
    fs.writeFileSync(file, JSON.stringify({ services: [] }));
    assert.throws(() => loadBackupDefinitions(file), /backups must be a non-empty object/);
  });
});
