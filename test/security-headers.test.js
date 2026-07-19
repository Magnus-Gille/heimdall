'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');

// Build a minimal Fastify app with just the security headers hook
function buildApp() {
  const app = Fastify({ logger: false });

  // Security headers — must match src/server.js
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '0');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  // Mock HTML route
  app.get('/html', async (request, reply) => {
    reply.type('text/html').send('<html><body>test</body></html>');
  });

  // Mock JSON API route
  app.get('/api/test', async () => {
    return { status: 'ok' };
  });

  return app;
}

describe('security headers', () => {
  let app;

  before(async () => {
    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('includes CSP header on HTML responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/html' });
    assert.equal(res.statusCode, 200);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header must be present');
    assert.ok(csp.includes("default-src 'self'"), 'CSP must include default-src');
    assert.ok(csp.includes("script-src 'self'"), 'CSP must include script-src');
    assert.ok(csp.includes("style-src 'self'"), 'CSP must include style-src');
    assert.ok(csp.includes("connect-src 'self'"), 'CSP must include connect-src');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP must include frame-ancestors');
  });

  it('includes HSTS header', async () => {
    const res = await app.inject({ method: 'GET', url: '/html' });
    const hsts = res.headers['strict-transport-security'];
    assert.ok(hsts, 'HSTS header must be present');
    assert.ok(hsts.includes('max-age=31536000'), 'HSTS max-age must be 1 year');
    assert.ok(hsts.includes('includeSubDomains'), 'HSTS must include includeSubDomains');
  });

  it('includes security headers on API JSON responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-security-policy'], 'CSP on JSON response');
    assert.ok(res.headers['strict-transport-security'], 'HSTS on JSON response');
    assert.ok(res.headers['x-content-type-options'], 'X-Content-Type-Options on JSON response');
    assert.ok(res.headers['x-frame-options'], 'X-Frame-Options on JSON response');
  });

  it('CSP does not allow unsafe-inline for scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/html' });
    const csp = res.headers['content-security-policy'];
    // Extract script-src directive and verify no unsafe-inline
    const scriptSrc = csp.match(/script-src\s+([^;]+)/);
    assert.ok(scriptSrc, 'script-src directive must exist');
    assert.ok(!scriptSrc[1].includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
    assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval');
  });

  it('CSP includes hardening directives', async () => {
    const res = await app.inject({ method: 'GET', url: '/html' });
    const csp = res.headers['content-security-policy'];
    assert.ok(csp.includes("object-src 'none'"), 'CSP must block object embeds');
    assert.ok(csp.includes("base-uri 'none'"), 'CSP must block base URI manipulation');
  });

  it('X-Content-Type-Options is nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/html' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});
