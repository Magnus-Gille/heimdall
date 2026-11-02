'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

function resolvedDependency(consumerPackage, dependencyPackage, consumerRoot = null) {
  const consumerPackageJson = consumerRoot
    ? require.resolve(`${consumerPackage}/package.json`, { paths: [consumerRoot] })
    : require.resolve(`${consumerPackage}/package.json`);
  const consumerRequire = createRequire(consumerPackageJson);
  const dependencyPackageJson = consumerRequire.resolve(`${dependencyPackage}/package.json`);
  return {
    packageJson: require(dependencyPackageJson),
    module: consumerRequire(dependencyPackage),
  };
}

function fastUriConsumers() {
  const ajv = resolvedDependency('ajv', 'fast-uri');
  const fastifyPackageJson = require.resolve('fastify/package.json');
  const fastifyRoot = path.dirname(fastifyPackageJson);
  // Fastify's own serializer is a separate consumer from the top-level
  // fast-json-stringify dependency; resolve it from Fastify's package root.
  const serializer = resolvedDependency('fast-json-stringify', 'fast-uri', fastifyRoot);
  return [
    { label: 'AJV', ...ajv },
    { label: 'Fastify serializer', ...serializer },
  ];
}

describe('fast-uri security regressions', () => {
  it('uses patched major-compatible fast-uri releases for AJV and Fastify serializers', () => {
    const consumers = fastUriConsumers();
    assert.equal(consumers[0].packageJson.version.split('.')[0], '3');
    assert.equal(consumers[1].packageJson.version.split('.')[0], '4');
  });

  for (const { label, module: fastUri } of fastUriConsumers()) {
    describe(label, () => {
      it('does not decode percent-encoded schemes into javascript', () => {
        assert.notEqual(fastUri.normalize('%6Aavascript:alert(1)'), 'javascript:alert(1)');
        assert.notEqual(fastUri.normalize('%u006Aavascript:alert(1)'), 'javascript:alert(1)');
      });

      it('does not treat an encoded scheme character as equal to a literal scheme', () => {
        assert.equal(fastUri.equal('%68ttp://a/', 'http://a/'), false);
      });

      it('preserves relative-reference equivalence during normalization', () => {
        const base = 'https://example.test/base/path';
        for (const reference of ['../x', 'a/../b']) {
          assert.equal(
            fastUri.resolve(base, fastUri.normalize(reference)),
            fastUri.resolve(base, reference),
            `normalized ${reference} must resolve to the same resource`,
          );
        }
      });

      it('retains legitimate URI controls', () => {
        assert.equal(fastUri.equal('https://example.test/a', 'https://example.test/a'), true);
        assert.equal(
          fastUri.resolve('https://example.test/base/', 'child'),
          'https://example.test/base/child',
        );
      });
    });
  }
});
