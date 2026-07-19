'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeVersion } = require('../src/version');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

describe('resolveRuntimeVersion', () => {
  it('prefers the authoritative deploy stamp and renders a short commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-version-'));
    fs.writeFileSync(path.join(root, '.deployed-commit'), '1e26f0580ed2216d6e56e013dc0ad5bd192a6584\n');
    assert.equal(resolveRuntimeVersion(root), '1e26f05');
  });

  it('ignores a malformed deploy stamp instead of displaying arbitrary text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-version-'));
    fs.writeFileSync(path.join(root, '.deployed-commit'), '<script>alert(1)</script>\n');
    assert.equal(resolveRuntimeVersion(root), 'dev');
  });

  it('refreshes the running health endpoint after Grimnir writes the deploy stamp', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-version-'));
    const db = openDatabase(path.join(root, 'test.db'));
    const { app } = buildApp(db, { runtimeRoot: root });
    await app.ready();
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().version, 'dev');
    fs.writeFileSync(path.join(root, '.deployed-commit'), 'abcdef1234567890abcdef1234567890abcdef12\n');
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().version, 'abcdef1');
    await app.close();
    db.close();
  });
});
