'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_COLLECTOR_PROBES,
  classifyProbePayload,
  classifyRemoteProbePayload,
  REMOTE_PROBE_SECTION_COUNT,
  validateCollectorCycle,
} = require('../src/collector-cycle');

const NOW = Date.parse('2026-08-11T10:05:00.000Z');
const START = NOW - 1_000;

function probe(name, overrides = {}) {
  return {
    name,
    status: 'success',
    observedAt: NOW,
    ...overrides,
  };
}

function cycle(probes = [probe('local'), probe('nas')], overrides = {}) {
  return {
    startedAt: START,
    completedAt: NOW,
    probes,
    ...overrides,
  };
}

function validOptions(overrides = {}) {
  return {
    requiredProbeNames: REQUIRED_COLLECTOR_PROBES,
    now: NOW,
    maxAgeMs: 5_000,
    maxDurationMs: 5_000,
    ...overrides,
  };
}

describe('collector cycle evidence', () => {
  it('accepts a fresh complete cycle', () => {
    const result = validateCollectorCycle(cycle(), validOptions());
    assert.equal(result.valid, true);
    assert.deepEqual(result.reasons, []);
  });

  it('fails closed when a required probe is omitted', () => {
    const result = validateCollectorCycle(cycle([probe('local')]), validOptions());
    assert.equal(result.success, false);
    assert.ok(result.reasons.includes('required probe "nas" missing'));
  });

  for (const status of ['frozen', 'malformed', 'partial', 'failure', 'stale', 'late']) {
    it(`fails closed for a ${status} required probe`, () => {
      const result = validateCollectorCycle(cycle([probe('local'), probe('nas', { status })]), validOptions());
      assert.equal(result.valid, false);
      assert.ok(result.reasons.some((reason) => reason.includes(`probe "nas" is ${status}`)));
    });
  }

  it('fails closed for malformed timestamps and late cycles', () => {
    const malformed = validateCollectorCycle(cycle([probe('local', { observedAt: 'not-a-date' }), probe('nas')]), validOptions());
    assert.equal(malformed.valid, false);
    assert.ok(malformed.reasons.includes('probe "local" timestamp is malformed'));

    const late = validateCollectorCycle(
      cycle([probe('local', { observedAt: NOW - 10_000 }), probe('nas')], { startedAt: NOW - 10_000 }),
      validOptions()
    );
    assert.equal(late.valid, false);
    assert.ok(late.reasons.includes('collector cycle is late: start evidence is stale'));
  });

  it('requires a newer observation before a failed cycle can recover', () => {
    const previous = { local: probe('local'), nas: probe('nas') };
    const frozen = validateCollectorCycle(cycle(), validOptions({ previousProbes: previous }));
    assert.equal(frozen.valid, false);
    assert.ok(frozen.reasons.includes('probe "local" evidence is frozen'));
    assert.ok(frozen.reasons.includes('probe "nas" evidence is frozen'));

    const recovered = validateCollectorCycle(
      cycle([probe('local', { observedAt: NOW + 1 }), probe('nas', { observedAt: NOW + 1 })], {
        completedAt: NOW + 1,
      }),
      validOptions({ now: NOW + 1, previousProbes: previous })
    );
    assert.equal(recovered.valid, true);
  });

  it('rejects a repeated successful payload even when its wrapper timestamp advances', () => {
    const previous = {
      local: probe('local', { observedAt: NOW - 1_000, fingerprint: '[1,2,3]' }),
      nas: probe('nas', { observedAt: NOW - 1_000, fingerprint: '[4,5,6]' }),
    };
    const result = validateCollectorCycle(
      cycle([
        probe('local', { fingerprint: '[1,2,3]' }),
        probe('nas', { fingerprint: '[4,5,6]' }),
      ]),
      validOptions({ previousProbes: previous })
    );
    assert.equal(result.valid, false);
    assert.ok(result.reasons.includes('probe "local" evidence is frozen'));
    assert.ok(result.reasons.includes('probe "nas" evidence is frozen'));
  });
});

describe('probe payload classification', () => {
  it('marks required evidence missing from a partial payload', () => {
    const result = classifyProbePayload({ uptime: { value: 12 } }, ['uptime', 'load_1m'], NOW);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.missing, ['load_1m']);
  });

  it('accepts zero-valued required measurements', () => {
    const result = classifyProbePayload({ uptime: { value: 0 }, load_1m: { value: 0 } }, ['uptime', 'load_1m'], NOW);
    assert.equal(result.status, 'success');
  });

  it('marks non-numeric required measurements as malformed', () => {
    const result = classifyProbePayload({ uptime: { value: 'frozen' }, load_1m: { value: 0 } }, ['uptime', 'load_1m'], NOW);
    assert.equal(result.status, 'malformed');
    assert.deepEqual(result.malformed, ['uptime']);
  });

  it('rejects a partial or malformed sectioned remote response', () => {
    const payload = {
      mem_used_pct: { value: 20 },
      load_1m: { value: 0.2 },
      uptime: { value: 123 },
    };
    const partialRaw = Array(3).fill('section').join('---\n');
    assert.equal(classifyRemoteProbePayload(partialRaw, payload, NOW).status, 'partial');
    assert.equal(classifyRemoteProbePayload(null, payload, NOW).status, 'malformed');

    const completeRaw = Array(REMOTE_PROBE_SECTION_COUNT).fill('section').join('---\n');
    assert.equal(classifyRemoteProbePayload(completeRaw, payload, NOW).status, 'success');
  });
});
