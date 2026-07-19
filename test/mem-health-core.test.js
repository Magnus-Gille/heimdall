'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { statusFor, pctState } = require('../src/render/components');
const {
  classifyMemoryHealth,
  classifyMemoryAttention,
  fetchMemoryHealth,
  fetchMemoryAttention,
  unwrapMemoryHealth,
  SUPPORTED_SCHEMA_VERSION,
  _resetMemoryHealthCache,
  consolidationBacklogFromHealth,
} = require('../src/munin-projects');

// Load the golden v2 wire fixture once.
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'memory-health.json');
const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT);

// ─── statusFor ───────────────────────────────────────────────────────────────

describe('statusFor — high-bad direction (default)', () => {
  it('returns crit when value >= crit threshold', () => {
    assert.equal(statusFor(95, { warn: 80, crit: 90 }), 'crit');
  });
  it('returns warn when value >= warn but < crit', () => {
    assert.equal(statusFor(85, { warn: 80, crit: 90 }), 'warn');
  });
  it('returns ok when value < warn', () => {
    assert.equal(statusFor(70, { warn: 80, crit: 90 }), 'ok');
  });
  it('boundary: value == warn → warn', () => {
    assert.equal(statusFor(80, { warn: 80, crit: 90 }), 'warn');
  });
  it('boundary: value == crit → crit', () => {
    assert.equal(statusFor(90, { warn: 80, crit: 90 }), 'crit');
  });
});

describe('statusFor — low-bad direction', () => {
  it('returns ok when value > warn', () => {
    assert.equal(statusFor(70, { warn: 60, crit: 40, dir: 'low-bad' }), 'ok');
  });
  it('returns warn when value <= warn but > crit', () => {
    assert.equal(statusFor(50, { warn: 60, crit: 40, dir: 'low-bad' }), 'warn');
  });
  it('returns crit when value <= crit', () => {
    assert.equal(statusFor(30, { warn: 60, crit: 40, dir: 'low-bad' }), 'crit');
  });
  it('boundary: value == warn → warn', () => {
    assert.equal(statusFor(60, { warn: 60, crit: 40, dir: 'low-bad' }), 'warn');
  });
  it('boundary: value == crit → crit', () => {
    assert.equal(statusFor(40, { warn: 60, crit: 40, dir: 'low-bad' }), 'crit');
  });
});

describe('pctState still behaves as before (delegates to statusFor)', () => {
  it('crit at high utilization', () => assert.equal(pctState(95), 'crit'));
  it('warn at medium utilization', () => assert.equal(pctState(85), 'warn'));
  it('ok at low utilization', () => assert.equal(pctState(70), 'ok'));
  it('stale for null', () => assert.equal(pctState(null), 'stale'));
  it('stale for NaN', () => assert.equal(pctState(NaN), 'stale'));
  it('custom warn/crit thresholds still work', () => {
    assert.equal(pctState(50, 60, 70), 'ok');
    assert.equal(pctState(65, 60, 70), 'warn');
    assert.equal(pctState(75, 60, 70), 'crit');
  });
  it('boundary: value == 80 (default warn) → warn', () => assert.equal(pctState(80), 'warn'));
  it('boundary: value == 92 (default crit) → crit', () => assert.equal(pctState(92), 'crit'));
});

// ─── unwrapMemoryHealth ──────────────────────────────────────────────────────

describe('unwrapMemoryHealth — wire → canonical consumer shape', () => {
  it('sections hoisted to top level', () => {
    const u = unwrapMemoryHealth(FIXTURE);
    assert.ok(u.embedding, 'embedding present at top level');
    assert.ok(u.consolidation, 'consolidation present at top level');
    assert.ok(u.security_events, 'security_events present at top level');
  });
  it('sections key absent from unwrapped shape', () => {
    const u = unwrapMemoryHealth(FIXTURE);
    assert.equal(u.sections, undefined);
  });
  it('top-level metadata preserved', () => {
    const u = unwrapMemoryHealth(FIXTURE);
    assert.equal(u.schema_version, FIXTURE.schema_version);
    assert.equal(u.generated_at, FIXTURE.generated_at);
    assert.equal(u.partial, FIXTURE.partial);
  });
  it('an additive section cannot shadow envelope metadata (Codex #81 F3)', () => {
    const wire = { schema_version: 2, generated_at: 'real', partial: false,
      sections: { embedding: { ok: true }, schema_version: 999, generated_at: 'spoof' } };
    const u = unwrapMemoryHealth(wire);
    assert.equal(u.schema_version, 2);
    assert.equal(u.generated_at, 'real');
  });
});

// ─── classifyMemoryHealth ────────────────────────────────────────────────────

describe('classifyMemoryHealth — golden fixture validates correctly', () => {
  it('golden fixture has schema_version 2', () => {
    assert.equal(FIXTURE.schema_version, SUPPORTED_SCHEMA_VERSION);
  });

  it('classifies the golden fixture as ok with unwrapped payload', () => {
    const result = classifyMemoryHealth(FIXTURE_TEXT);
    assert.equal(result.status, 'ok');
    assert.ok(result.payload, 'payload present');
    assert.equal(result.generatedAt, FIXTURE.generated_at);
    // Payload must be the UNWRAPPED canonical shape
    assert.ok(result.payload.embedding, 'embedding at top level of payload');
    assert.equal(result.payload.consolidation.worker, 'disabled');
    assert.equal(result.payload.sections, undefined);
  });
});

describe('classifyMemoryHealth — null (transport_error)', () => {
  it('null rawText → transport_error', () => {
    const result = classifyMemoryHealth(null);
    assert.equal(result.status, 'transport_error');
    assert.equal(result.payload, undefined);
  });
});

describe('classifyMemoryHealth — non-JSON (invalid_schema/parse)', () => {
  it('unparseable text → invalid_schema with reason=parse', () => {
    const result = classifyMemoryHealth('not valid JSON {{{');
    assert.equal(result.status, 'invalid_schema');
    assert.equal(result.reason, 'parse');
  });
});

describe('classifyMemoryHealth — structurally invalid payload', () => {
  it('missing sections.consolidation → invalid_schema', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    delete bad.sections.consolidation;
    const result = classifyMemoryHealth(JSON.stringify(bad));
    assert.equal(result.status, 'invalid_schema');
    assert.ok(result.reason, 'reason present');
  });

  it('missing sections.embedding.counts → invalid_schema', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    delete bad.sections.embedding.counts;
    const result = classifyMemoryHealth(JSON.stringify(bad));
    assert.equal(result.status, 'invalid_schema');
  });

  it('sections set to non-object → invalid_schema', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    bad.sections = 'not-an-object';
    const result = classifyMemoryHealth(JSON.stringify(bad));
    assert.equal(result.status, 'invalid_schema');
  });

  it('missing retrieval latency percentiles → invalid_schema', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    delete bad.sections.retrieval.latency_p50_ms;
    const result = classifyMemoryHealth(JSON.stringify(bad));
    assert.equal(result.status, 'invalid_schema');
  });

  it('missing classification access-denial count → invalid_schema', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    delete bad.sections.classification.access_denied_7d;
    const result = classifyMemoryHealth(JSON.stringify(bad));
    assert.equal(result.status, 'invalid_schema');
  });
});

describe('classifyMemoryHealth — unsupported schema version', () => {
  it('schema_version: 1 → unsupported_version (version gated before ajv, §1.3)', () => {
    // An older version must read as unsupported_version ("upgrade heimdall / rollback munin"),
    // NOT invalid_schema — the schema pins schema_version to const:2 which would reject v1
    // as invalid first. classifyMemoryHealth checks the numeric version before running ajv.
    const old = JSON.parse(FIXTURE_TEXT);
    old.schema_version = 1;
    const result = classifyMemoryHealth(JSON.stringify(old));
    assert.equal(result.status, 'unsupported_version');
  });

  it('schema_version: 3 → unsupported_version (future version)', () => {
    const bumped = JSON.parse(FIXTURE_TEXT);
    bumped.schema_version = 3;
    const result = classifyMemoryHealth(JSON.stringify(bumped));
    assert.equal(result.status, 'unsupported_version');
  });

  it('missing schema_version → invalid_schema (not unsupported_version)', () => {
    // A non-numeric / absent version is a malformed payload, not a version mismatch —
    // it falls through to ajv (schema_version is required).
    const noVer = JSON.parse(FIXTURE_TEXT);
    delete noVer.schema_version;
    const result = classifyMemoryHealth(JSON.stringify(noVer));
    assert.equal(result.status, 'invalid_schema');
  });

  it('non-integer schema_version (1.5) → invalid_schema (not unsupported_version)', () => {
    const frac = JSON.parse(FIXTURE_TEXT);
    frac.schema_version = 1.5;
    const result = classifyMemoryHealth(JSON.stringify(frac));
    assert.equal(result.status, 'invalid_schema');
  });
});

// ─── fetchMemoryHealth — cache behaviour ─────────────────────────────────────

describe('fetchMemoryHealth — typed result from injected rpcFn', () => {
  beforeEach(() => _resetMemoryHealthCache());

  it('good RPC → status ok with payload', async () => {
    const rpcFn = async () => ({ content: [{ text: FIXTURE_TEXT }] });
    const result = await fetchMemoryHealth(rpcFn);
    assert.equal(result.status, 'ok');
    assert.ok(result.payload);
    assert.equal(result.generatedAt, FIXTURE.generated_at);
  });

  it('null RPC result → transport_error', async () => {
    const rpcFn = async () => null;
    const result = await fetchMemoryHealth(rpcFn);
    assert.equal(result.status, 'transport_error');
    assert.equal(result.payload, undefined);
  });

  it('non-JSON RPC result → invalid_schema', async () => {
    const rpcFn = async () => ({ content: [{ text: 'garbage' }] });
    const result = await fetchMemoryHealth(rpcFn);
    assert.equal(result.status, 'invalid_schema');
  });

  it('good then failing → servedFromCache:true with unwrapped last-good payload', async () => {
    // Seed the cache with a good call
    const goodFn = async () => ({ content: [{ text: FIXTURE_TEXT }] });
    const first = await fetchMemoryHealth(goodFn);
    assert.equal(first.status, 'ok');
    // Cached payload is unwrapped
    assert.ok(first.payload.embedding, 'unwrapped payload has embedding');
    assert.equal(first.payload.sections, undefined);

    // Now fail
    const badFn = async () => null;
    const second = await fetchMemoryHealth(badFn);
    assert.equal(second.status, 'transport_error');
    assert.equal(second.servedFromCache, true);
    assert.ok(second.payload, 'cached payload present');
    assert.deepEqual(second.payload, first.payload);
  });

  it('no cache + transport_error → no payload field', async () => {
    const rpcFn = async () => null;
    const result = await fetchMemoryHealth(rpcFn);
    assert.equal(result.status, 'transport_error');
    assert.equal(result.payload, undefined);
  });
});

describe('fetchMemoryAttention — item-level operator queue', () => {
  it('accepts the structured memory_attention result', async () => {
    const payload = {
      ok: true,
      action: 'attention',
      generated_at: '2026-07-10T12:00:00.000Z',
      summary: { high: 0, medium: 2, low: 0, total: 2 },
      items: [
        { namespace: 'projects/old', category: 'active_but_stale', severity: 'medium', updated_at: '2026-01-01T00:00:00.000Z', preview: 'Old project', reason: 'Active status looks stale.', suggested_action: 'Review.' },
        { namespace: 'projects/missing', category: 'missing_status', severity: 'medium', updated_at: '2026-02-01T00:00:00.000Z', preview: 'No status', reason: 'Missing status.', suggested_action: 'Create one.' },
      ],
    };
    const result = await fetchMemoryAttention(async () => ({ content: [{ text: JSON.stringify(payload) }] }));
    assert.equal(result.status, 'ok');
    assert.equal(result.payload.items.length, 2);
  });

  it('rejects malformed attention payloads instead of rendering guessed data', () => {
    assert.equal(classifyMemoryAttention('{"ok":true,"action":"attention","items":"many"}').status, 'invalid_schema');
    assert.equal(classifyMemoryAttention('not json').status, 'invalid_schema');
  });

  it('returns transport_error when the RPC is unavailable', async () => {
    const result = await fetchMemoryAttention(async () => null);
    assert.equal(result.status, 'transport_error');
  });
});

describe('consolidationBacklogFromHealth', () => {
  it('uses the complete structured memory_health backlog', () => {
    const result = classifyMemoryHealth(FIXTURE_TEXT);
    assert.deepEqual(consolidationBacklogFromHealth(result), [
      { namespace: 'projects/demo', count: 5 },
    ]);
  });

  it('does not reuse cached or invalid data as current backlog', () => {
    assert.deepEqual(consolidationBacklogFromHealth({ status: 'transport_error' }), []);
  });
});

// --- Regression: Codex PR #79 review findings ---

describe('classifyMemoryHealth — non-object JSON never throws (F2)', () => {
  for (const raw of ['null', '42', '"a string"', '[]', 'true']) {
    it(`${raw} → invalid_schema (not a throw)`, () => {
      let result;
      assert.doesNotThrow(() => { result = classifyMemoryHealth(raw); });
      assert.equal(result.status, 'invalid_schema');
    });
  }
});

describe('classifyMemoryHealth — freshness gate (F1, stale_payload)', () => {
  const genMs = Date.parse(FIXTURE.generated_at);
  it('fresh within maxAgeMs → ok', () => {
    const r = classifyMemoryHealth(FIXTURE_TEXT, { nowMs: genMs + 1000, maxAgeMs: 60000 });
    assert.equal(r.status, 'ok');
  });
  it('older than maxAgeMs → stale_payload, unwrapped payload still carried', () => {
    const r = classifyMemoryHealth(FIXTURE_TEXT, { nowMs: genMs + 120000, maxAgeMs: 60000 });
    assert.equal(r.status, 'stale_payload');
    assert.equal(r.reason, 'expired');
    assert.ok(r.payload, 'stale payload rides along for dimmed render');
    // Payload must be unwrapped even on stale_payload
    assert.ok(r.payload.embedding, 'unwrapped stale payload has embedding');
  });
  it('unparsable generated_at + maxAgeMs → stale_payload', () => {
    const bad = JSON.parse(FIXTURE_TEXT);
    bad.generated_at = 'not-a-date';
    // schema requires date-time format but ajv treats it as no-op, so this is
    // schema-valid as a string and the freshness gate catches it.
    const r = classifyMemoryHealth(JSON.stringify(bad), { nowMs: genMs, maxAgeMs: 60000 });
    assert.equal(r.status, 'stale_payload');
    assert.equal(r.reason, 'unparsable-generated_at');
  });
  it('no maxAgeMs → freshness check skipped (ok)', () => {
    assert.equal(classifyMemoryHealth(FIXTURE_TEXT, {}).status, 'ok');
  });
});

describe('statusFor — non-finite inputs → stale (F4)', () => {
  for (const v of [undefined, null, NaN]) {
    it(`${String(v)} → stale (not healthy)`, () => {
      assert.equal(statusFor(v, { warn: 80, crit: 90 }), 'stale');
      assert.equal(statusFor(v, { warn: 80, crit: 90, dir: 'low-bad' }), 'stale');
    });
  }
});
