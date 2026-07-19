'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { muninRpc } = require('../src/munin-rpc');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(overrides = {}) {
  const defaults = {
    ok: true,
    status: 200,
    text: async () => '',
  };
  const resp = Object.assign({}, defaults, overrides);
  return async (_url, _opts) => resp;
}

function sseBody(result) {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('muninRpc shared util', () => {
  let originalFetch;
  let warnCalls;
  let originalWarn;

  before(() => {
    originalFetch = global.fetch;
    originalWarn = console.warn;
  });

  after(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  });

  it('no apiKey => returns null without calling fetch', async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return {}; };

    const result = await muninRpc('memory_read', {}, { apiKey: null });
    assert.strictEqual(result, null);
    assert.strictEqual(fetchCalled, false);
  });

  it('no apiKey (absent opts) => returns null', async () => {
    global.fetch = async () => { throw new Error('should not be called'); };
    const result = await muninRpc('memory_read', {});
    assert.strictEqual(result, null);
  });

  it('SSE response => returns rpc.result', async () => {
    global.fetch = makeFetch({ text: async () => sseBody({ ok: true }) });
    const result = await muninRpc('memory_read', { namespace: 'x', key: 'y' }, { apiKey: 'tok', timeoutMs: 8000 });
    assert.deepStrictEqual(result, { ok: true });
  });

  it('plain-JSON response (no data: line) => returns result', async () => {
    global.fetch = makeFetch({ text: async () => JSON.stringify({ result: { x: 1 } }) });
    const result = await muninRpc('memory_read', {}, { apiKey: 'tok' });
    assert.deepStrictEqual(result, { x: 1 });
  });

  it('res.ok=false => returns null', async () => {
    global.fetch = makeFetch({ ok: false, status: 503, text: async () => 'service unavailable' });
    const result = await muninRpc('memory_read', {}, { apiKey: 'tok' });
    assert.strictEqual(result, null);
  });

  it('rpc.error in SSE => returns null', async () => {
    const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })}\n`;
    global.fetch = makeFetch({ text: async () => body });
    const result = await muninRpc('memory_read', {}, { apiKey: 'tok' });
    assert.strictEqual(result, null);
  });

  it('rpc.error in plain-JSON (no data: line) => returns null', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } });
    global.fetch = makeFetch({ text: async () => body });
    const result = await muninRpc('memory_read', {}, { apiKey: 'tok' });
    assert.strictEqual(result, null);
  });

  it('fetch throws => returns null, does not rethrow', async () => {
    global.fetch = async () => { throw new Error('network gone'); };
    const result = await muninRpc('memory_read', {}, { apiKey: 'tok', timeoutMs: 5000 });
    assert.strictEqual(result, null);
  });

  it('label provided + failure => console.warn called with label prefix', async () => {
    global.fetch = makeFetch({ ok: false, status: 500, text: async () => 'err' });
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));

    await muninRpc('memory_read', {}, { apiKey: 'tok', label: 'test-label' });
    assert.ok(warned.length > 0, 'expected console.warn to be called');
    assert.ok(warned[0].startsWith('  test-label:'), `warn prefix wrong: ${warned[0]}`);
  });

  it('label absent + failure => console.warn NOT called', async () => {
    global.fetch = makeFetch({ ok: false, status: 500, text: async () => 'err' });
    let warnCalled = false;
    console.warn = () => { warnCalled = true; };

    await muninRpc('memory_read', {}, { apiKey: 'tok' });
    assert.strictEqual(warnCalled, false);
  });
});
