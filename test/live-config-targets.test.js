'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeStartupTargets } = require('../src/config/live-config');

describe('live configuration target guard (#27)', () => {
  it('rejects every RFC 5737 documentation range in production', () => {
    for (const target of ['192.0.2.1', '198.51.100.2', '203.0.113.3']) {
      assert.throws(
        () => assertSafeStartupTargets([{ name: 'probe', health_url: `http://${target}/health` }], { NODE_ENV: 'production' }),
        new RegExp(target.replaceAll('.', '\\.'), 'u'),
      );
    }
  });

  it('rejects example host targets in production', () => {
    assert.throws(
      () => assertSafeStartupTargets([{ name: 'probe', health_url: 'https://api.example.com/health' }], { NODE_ENV: 'production' }),
      /api\.example\.com/u,
    );
    assert.throws(
      () => assertSafeStartupTargets([{ name: 'storage', ssh_host: 'nas.example' }], { NODE_ENV: 'production' }),
      /nas\.example/u,
    );
  });

  it('accepts private live targets in production', () => {
    assert.doesNotThrow(() => assertSafeStartupTargets([
      { name: 'service', health_url: 'http://service.internal:3030/health' },
      { name: 'storage', ssh_host: 'storage.internal' },
    ], { NODE_ENV: 'production' }));
  });

  it('permits the committed documentation inventory only in explicit demo/test modes', () => {
    const demoService = [{ name: 'demo', health_url: 'http://192.0.2.1/health' }];
    assert.doesNotThrow(() => assertSafeStartupTargets(demoService, { HEIMDALL_CONFIG_MODE: 'demo' }));
    assert.doesNotThrow(() => assertSafeStartupTargets(demoService, { NODE_ENV: 'test' }));
    assert.throws(
      () => assertSafeStartupTargets(demoService, { NODE_ENV: 'production', HEIMDALL_CONFIG_MODE: 'demo' }),
      /documentation target/u,
    );
  });
});
