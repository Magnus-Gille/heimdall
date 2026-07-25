'use strict';

/**
 * Reject public documentation targets before a production process can silently
 * monitor them. The committed overlay intentionally contains those targets, so
 * it remains available only when the process explicitly identifies itself as a
 * demo or test run.
 */

const RFC_5737_RANGES = [
  [192, 0, 2],
  [198, 51, 100],
  [203, 0, 113],
];

function isDocumentationIpv4(host) {
  const parts = String(host || '').split('.').map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && RFC_5737_RANGES.some((range) => range.every((part, index) => parts[index] === part));
}

function isExampleHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/\.$/u, '');
  return normalized === 'example.com'
    || normalized.endsWith('.example.com')
    || normalized === 'example'
    || normalized.endsWith('.example');
}

function targetHost(value, isUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!isUrl) return value;
  try { return new URL(value).hostname; } catch { return null; }
}

function isExplicitDemoOrTest(environment) {
  return environment.NODE_ENV === 'test' || environment.HEIMDALL_CONFIG_MODE === 'demo';
}

/** The collector's direct storage probe is not part of the service overlay. */
function storageSshHost(environment = process.env) {
  return environment.HEIMDALL_STORAGE_SSH_HOST || '192.0.2.20';
}

/**
 * Throw before startup if a service target is a documentation address/domain.
 * Production always validates, even if a stale demo-mode variable is present.
 */
function assertSafeStartupTargets(services, environment = process.env) {
  if (environment.NODE_ENV !== 'production' && isExplicitDemoOrTest(environment)) return;

  const unsafe = [];
  for (const service of services || []) {
    for (const [field, isUrl] of [['health_url', true], ['ssh_host', false]]) {
      const host = targetHost(service && service[field], isUrl);
      if (host && (isDocumentationIpv4(host) || isExampleHost(host))) {
        unsafe.push(`${service.name || 'unnamed'}.${field}=${service[field]}`);
      }
    }
  }

  if (unsafe.length) {
    throw new Error(
      `Refusing startup with documentation target(s): ${unsafe.join(', ')}. ` +
      'Use a private live overlay, or identify a non-production demonstration with HEIMDALL_CONFIG_MODE=demo.'
    );
  }
}

module.exports = { assertSafeStartupTargets, isDocumentationIpv4, isExampleHost, storageSshHost };
