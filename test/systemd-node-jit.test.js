'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SYSTEMD_DIR = path.join(__dirname, '..', 'systemd');

function isNodeUnit(source) {
  return /^ExecStart=.*\bnode\b/m.test(source);
}

function enablesMemoryDenyWriteExecute(source) {
  return /^MemoryDenyWriteExecute\s*=\s*yes\s*$/mi.test(source);
}

describe('Node systemd units', () => {
  const units = fs.readdirSync(SYSTEMD_DIR).filter((name) => name.endsWith('.service'));

  for (const unit of units) {
    const source = fs.readFileSync(path.join(SYSTEMD_DIR, unit), 'utf8');
    if (!isNodeUnit(source)) continue;

    it(`${unit} leaves executable memory available for Node's JIT`, () => {
      assert.equal(
        enablesMemoryDenyWriteExecute(source),
        false,
        `${unit} runs Node, whose JIT requires executable memory; do not set MemoryDenyWriteExecute=yes`
      );
    });
  }
});
