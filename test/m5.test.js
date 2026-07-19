'use strict';

const assert = require('assert');
const {
  ledgerToMatrix,
  tallyVerdicts,
  deriveRoutingFromLedger,
  generateFindings,
  parseFindingsReply,
  _resetSummaryCache,
  __setSummaryCacheForTest,
  KNOWN_MODELS,
  fetchModels,
  summarizeModels,
  fetchMetrics,
  parseMetrics,
  summarizeUsageMetrics,
} = require('../src/m5');

const SAMPLE_REPORT = [
  { taskType: 'classify', modelId: 'mellum', verdict: 'viable', attempts: 5, passes: 5, successRate: 1.0, frozen: true, avgTokPerSec: 138, recommendation: 'delegate-local' },
  { taskType: 'classify', modelId: 'qwen35-a3b', verdict: 'marginal', attempts: 4, passes: 2, successRate: 0.5, frozen: false, avgTokPerSec: 40, recommendation: 'explore' },
  { taskType: 'sql', modelId: 'mellum', verdict: 'not_viable', attempts: 6, passes: 1, successRate: 0.17, frozen: true, avgTokPerSec: 120, recommendation: 'escalate-frontier' },
  { taskType: 'sql', modelId: 'qwen3-coder-next-80b', verdict: 'not_viable', attempts: 6, passes: 2, successRate: 0.33, frozen: false, avgTokPerSec: 22, recommendation: 'escalate-frontier' },
];

function testLedgerToMatrix() {
  const m = ledgerToMatrix(SAMPLE_REPORT);
  assert.deepStrictEqual(m.taskTypes, ['classify', 'sql']);
  // Known models that appear preserve canonical order; absent ones (gemma4) are dropped.
  assert.deepStrictEqual(m.models, ['mellum', 'qwen3-coder-next-80b', 'qwen35-a3b']);
  assert.strictEqual(m.cells.classify.mellum.verdict, 'viable');
  assert.strictEqual(m.cells.classify.mellum.frozen, true);
  assert.strictEqual(m.cells.sql.mellum.successRate, 0.17);
  assert.strictEqual(m.cells.classify.mellum.tokPerSec, 138);
  console.log('  PASS: ledgerToMatrix builds task×model matrix in canonical model order');
}

function testLedgerToMatrixEmpty() {
  const m = ledgerToMatrix([]);
  assert.deepStrictEqual(m.taskTypes, []);
  // Empty ledger still surfaces the canonical column set so the header renders.
  assert.deepStrictEqual(m.models, KNOWN_MODELS);
  // Safe on garbage input.
  assert.deepStrictEqual(ledgerToMatrix(null).taskTypes, []);
  console.log('  PASS: ledgerToMatrix safe on empty/null, keeps canonical columns');
}

function testTallyVerdicts() {
  const t = tallyVerdicts(SAMPLE_REPORT);
  assert.deepStrictEqual(t, { viable: 1, marginal: 1, not_viable: 2, unknown: 0 });
  assert.deepStrictEqual(tallyVerdicts(null), { viable: 0, marginal: 0, not_viable: 0, unknown: 0 });
  console.log('  PASS: tallyVerdicts counts verdicts, safe on null');
}

function testDeriveRouting() {
  const r = deriveRoutingFromLedger(SAMPLE_REPORT);
  const classify = r.find((x) => x.taskType === 'classify');
  const sql = r.find((x) => x.taskType === 'sql');
  // classify: mellum (1.0) beats qwen35 (0.5)
  assert.strictEqual(classify.model, 'mellum');
  assert.strictEqual(classify.recommendation, 'delegate-local');
  // sql: best is qwen3-coder-next-80b (0.33) over mellum (0.17), still escalates
  assert.strictEqual(sql.model, 'qwen3-coder-next-80b');
  assert.strictEqual(sql.recommendation, 'escalate-frontier');
  console.log('  PASS: deriveRoutingFromLedger picks best model per task by pass rate');
}

function testDeriveRoutingTieBreaksByTokPerSec() {
  const report = [
    { taskType: 'extract', modelId: 'slow', verdict: 'viable', successRate: 0.9, avgTokPerSec: 10 },
    { taskType: 'extract', modelId: 'fast', verdict: 'viable', successRate: 0.9, avgTokPerSec: 200 },
  ];
  const r = deriveRoutingFromLedger(report);
  assert.strictEqual(r[0].model, 'fast', 'equal pass rate breaks toward higher tok/s');
  console.log('  PASS: deriveRoutingFromLedger breaks ties by tok/s');
}

// ── parseFindingsReply VALIDATION ──────────────────────────────────────────
function testParseValidBullets() {
  const reply = '- Local handles classify and extract well\n- Escalate SQL to a frontier model\n- Avoid thinking models for short tasks';
  const out = parseFindingsReply(reply);
  assert.ok(Array.isArray(out));
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0], 'Local handles classify and extract well'); // marker stripped
  console.log('  PASS: parseFindingsReply parses 3 clean bullets, strips markers');
}

function testParseNumberedAndExtra() {
  // 4 numbered bullets → take first 3.
  const reply = '1. one takeaway\n2. two takeaway\n3. three takeaway\n4. four takeaway';
  const out = parseFindingsReply(reply);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[2], 'three takeaway');
  console.log('  PASS: parseFindingsReply accepts numbered lists, caps at 3');
}

function testParseRejectsTooLong() {
  const long = 'x'.repeat(121);
  const reply = `- short one\n- ${long}\n- short three`;
  assert.strictEqual(parseFindingsReply(reply), null, 'a >120-char bullet fails validation');
  console.log('  PASS: parseFindingsReply rejects over-length bullets (fallback)');
}

function testParseRejectsGarbage() {
  assert.strictEqual(parseFindingsReply(''), null);
  assert.strictEqual(parseFindingsReply(null), null);
  assert.strictEqual(parseFindingsReply('only one line'), null, 'single bullet is too few');
  assert.strictEqual(parseFindingsReply('a\nb\nc\nd\ne\nf\ng'), null, 'too many lines is rejected');
  console.log('  PASS: parseFindingsReply rejects empty/too-few/too-many (fallback)');
}

// ── generateFindings: success / validation-fallback / error-fallback / cache ──
function makeFetchOk(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

async function testGenerateValidatesAndCaches() {
  _resetSummaryCache();
  let calls = 0;
  const _fetch = async (url, opts) => {
    calls++;
    // assert it targets the gateway chat endpoint with model mellum
    assert.ok(String(url).endsWith('/v1/chat/completions'));
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.model, 'mellum');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '- a\n- b\n- c' } }] }) };
  };
  const first = await generateFindings({ tally: { viable: 1, marginal: 0, not_viable: 1, unknown: 0 }, _fetch });
  assert.ok(first && first.bullets.length === 3);
  assert.strictEqual(first.model, 'mellum');
  assert.ok(first.generatedAt);
  // Second call within TTL must be served from cache (no new fetch).
  const second = await generateFindings({ _fetch });
  assert.strictEqual(calls, 1, 'second call within TTL is cached (no M5 round-trip)');
  assert.deepStrictEqual(second.bullets, first.bullets);
  console.log('  PASS: generateFindings validates, caches (~1h TTL), no per-render M5 call');
}

async function testGenerateFallbackOnInvalid() {
  _resetSummaryCache();
  // Model returns prose, not bullets → validation fails → null (caller shows static findings).
  const out = await generateFindings({ force: true, _fetch: makeFetchOk('Here is a long paragraph with no bullet structure at all that exceeds limits.') });
  assert.strictEqual(out, null);
  console.log('  PASS: generateFindings returns null on invalid reply (static fallback)');
}

async function testGenerateFallbackOnError() {
  _resetSummaryCache();
  const out1 = await generateFindings({ force: true, _fetch: async () => ({ ok: false, json: async () => ({}) }) });
  assert.strictEqual(out1, null, 'non-2xx → null');
  const out2 = await generateFindings({ force: true, _fetch: async () => { throw new Error('network down'); } });
  assert.strictEqual(out2, null, 'thrown error → null');
  console.log('  PASS: generateFindings returns null on HTTP error / network failure (static fallback)');
}

// ── FIX 1: cache stampede — coalescing concurrent generateFindings() calls ──
async function testGenerateCoalescesInFlight() {
  _resetSummaryCache();
  let calls = 0;
  // Slow fetch so all 5 callers see the in-flight state before resolution.
  const _fetch = () => new Promise((resolve) => {
    calls++;
    setImmediate(() => resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '- bullet a\n- bullet b\n- bullet c' } }] }),
    }));
  });
  // Fire 5 concurrent calls with a COLD cache.
  const results = await Promise.all([
    generateFindings({ _fetch }),
    generateFindings({ _fetch }),
    generateFindings({ _fetch }),
    generateFindings({ _fetch }),
    generateFindings({ _fetch }),
  ]);
  assert.strictEqual(calls, 1, `expected exactly 1 gateway call but got ${calls}`);
  for (const r of results) {
    assert.ok(r && Array.isArray(r.bullets), 'each caller must get a valid result');
    assert.deepStrictEqual(r.bullets, results[0].bullets, 'all callers share the same bullets');
  }
  console.log('  PASS: generateFindings coalesces concurrent in-flight calls (exactly 1 gateway request)');
}

// ── FIX 2: parseFindingsReply robustness ────────────────────────────────────
function testParseDropsCodeFences() {
  const reply = '```\n- first bullet\n- second bullet\n- third bullet\n```';
  const out = parseFindingsReply(reply);
  assert.ok(Array.isArray(out) && out.length === 3, 'should get 3 bullets after dropping fences');
  assert.deepStrictEqual(out, ['first bullet', 'second bullet', 'third bullet']);
  console.log('  PASS: parseFindingsReply drops markdown code fences');
}

function testParseDropsCodeFenceWithLang() {
  const reply = '```markdown\n- first bullet\n- second bullet\n- third bullet\n```';
  const out = parseFindingsReply(reply);
  assert.ok(Array.isArray(out) && out.length === 3, 'should get 3 bullets after dropping lang fence');
  assert.deepStrictEqual(out, ['first bullet', 'second bullet', 'third bullet']);
  console.log('  PASS: parseFindingsReply drops language-tagged code fences');
}

function testParseSkipsPreambleLine() {
  const reply = 'Here are 3 takeaways:\n- first\n- second\n- third';
  const out = parseFindingsReply(reply);
  assert.ok(Array.isArray(out) && out.length === 3, 'should get 3 bullets after skipping preamble');
  assert.deepStrictEqual(out, ['first', 'second', 'third']);
  console.log('  PASS: parseFindingsReply skips non-bullet preamble line before bullet block');
}

// ── FIX 3: regression tests ─────────────────────────────────────────────────
async function testCacheExpiryRegenerates() {
  _resetSummaryCache();
  let calls = 0;
  const _fetch = () => {
    calls++;
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '- x\n- y\n- z' } }] }),
    });
  };
  // Seed the cache with a stale timestamp (2 hours in the past) via the test hook.
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  __setSummaryCacheForTest({ bullets: ['x', 'y', 'z'], generatedAt: past, model: 'mellum' });
  // With a stale cache, generateFindings must re-generate (make a gateway call).
  await generateFindings({ _fetch });
  assert.strictEqual(calls, 1, 'expired cache must trigger a new gateway call');
  console.log('  PASS: generateFindings regenerates after cache TTL expires');
}

// Regression: ledger taskType/modelId are used as object keys. A row with taskType
// "__proto__" must not pollute a prototype or crash. Old code threw "push is not a
// function" in deriveRoutingFromLedger and did prototype games in ledgerToMatrix.
function testResistsPrototypePollutionKeys() {
  const rows = [
    { taskType: '__proto__', modelId: 'mellum', verdict: 'viable', successRate: 1, avgTokPerSec: 10, attempts: 3 },
    { taskType: 'extract', modelId: 'constructor', verdict: 'viable', successRate: 0.9, attempts: 2 },
    { taskType: 'constructor', modelId: 'qwen', verdict: 'marginal', successRate: 0.4, attempts: 1 },
  ];
  const m = ledgerToMatrix(rows); // must not throw
  assert.ok(m.taskTypes.includes('__proto__') && m.taskTypes.includes('extract'));
  assert.strictEqual(m.cells['__proto__'].mellum.verdict, 'viable', '__proto__ key stored as plain data');
  const r = deriveRoutingFromLedger(rows); // old code threw here on the __proto__ taskType
  assert.ok(Array.isArray(r) && r.length === 3, 'routing derived for all task types, no crash');
  // Non-string keys are rejected, not coerced.
  assert.strictEqual(ledgerToMatrix([{ taskType: 5, modelId: 'm', verdict: 'viable' }]).taskTypes.length, 0);
  // Object.prototype remains pristine.
  assert.strictEqual({}.mellum, undefined, 'Object.prototype not polluted');
  console.log('  PASS: matrix/routing treat __proto__/constructor as plain string keys (no crash, no pollution)');
}

// ── fetchModels: success and error paths ──────────────────────────────────────
const SAMPLE_MODELS = [
  { key: 'mellum', displayName: 'Mellum', type: 'llm', sizeBytes: 4_000_000_000, quantization: 'Q4_K_M', maxContextLength: 32768, loaded: true },
  { key: 'qwen3-coder-next-80b', displayName: 'Qwen3 Coder 80B', type: 'llm', sizeBytes: 45_000_000_000, quantization: 'Q4_K_M', maxContextLength: 131072, loaded: false },
  { key: 'whisper', displayName: 'Whisper', type: 'stt', sizeBytes: 1_500_000_000, loaded: false },
];

async function testFetchModelsSuccess() {
  const _fetch = async (url, opts) => {
    assert.ok(String(url).endsWith('/models'), `expected /models endpoint, got ${url}`);
    // Verify auth header is forwarded.
    assert.ok(opts.headers && opts.headers.Authorization, 'auth header must be sent');
    return {
      ok: true,
      json: async () => ({ models: SAMPLE_MODELS }),
    };
  };
  const result = await fetchModels('http://test.local:8080', 'test-key', { _fetch });
  assert.ok(Array.isArray(result.models), 'success: models must be an array');
  assert.strictEqual(result.models.length, 3);
  assert.strictEqual(result.models[0].key, 'mellum');
  assert.strictEqual(result.error, undefined, 'no error on success');
  console.log('  PASS: fetchModels returns { models } on success');
}

async function testFetchModelsNonArrayBody() {
  // Server returns models as an object instead of an array — defensive guard.
  const _fetch = async () => ({
    ok: true,
    json: async () => ({ models: { broken: true } }),
  });
  const result = await fetchModels('http://test.local:8080', null, { _fetch });
  assert.deepStrictEqual(result, { models: [] }, 'non-array body → empty models array');
  console.log('  PASS: fetchModels returns { models: [] } when body.models is not an array');
}

async function testFetchModelsHttpError() {
  const _fetch = async () => ({ ok: false, status: 403 });
  const result = await fetchModels('http://test.local:8080', null, { _fetch });
  assert.ok(result.error, 'HTTP error must set error key');
  assert.ok(result.error.includes('403'), `error should mention status 403, got: ${result.error}`);
  assert.strictEqual(result.models, undefined, 'no models on error');
  console.log('  PASS: fetchModels returns { error: "models HTTP 403" } on non-2xx');
}

async function testFetchModelsNetworkFailure() {
  const _fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await fetchModels('http://test.local:8080', null, { _fetch });
  assert.ok(result.error, 'network failure must set error key');
  assert.ok(result.error.includes('ECONNREFUSED'), `error message should propagate, got: ${result.error}`);
  console.log('  PASS: fetchModels returns { error } on network failure, never throws');
}

// ── Fix 1 regression: fetchModels(url, key, null) MUST resolve, never reject ──
// opts=null currently makes the function reject (TypeError accessing null._fetch)
// before even entering the try block. Contract: NEVER throws.
async function testFetchModelsNullOpts() {
  // No _fetch injection — but we expect a resolve({ error: ... }), not a rejection.
  // We don't have a real network here, so we verify the SHAPE of the promise resolution.
  // The function should resolve to { error } whether the fetch fails or opts is null.
  let rejected = false;
  let resolved = null;
  try {
    // Pass null explicitly — previously this threw before the try block.
    resolved = await fetchModels('http://127.0.0.1:1', null, null);
  } catch {
    rejected = true;
  }
  assert.strictEqual(rejected, false, 'fetchModels(url, key, null) must NOT reject');
  assert.ok(resolved && typeof resolved.error === 'string', 'must resolve to { error: string }');
  console.log('  PASS: fetchModels(url, key, null) resolves to { error } instead of rejecting');
}

// ── summarizeModels: pure logic ──────────────────────────────────────────────
function testSummarizeModelsBasic() {
  const s = summarizeModels(SAMPLE_MODELS);
  assert.strictEqual(s.counts.downloaded, 3, 'all 3 entries are downloaded');
  assert.strictEqual(s.counts.loaded, 1, 'only mellum is loaded');
  assert.strictEqual(s.loaded.length, 1);
  assert.strictEqual(s.loaded[0].key, 'mellum');
  assert.strictEqual(s.downloaded.length, 3, 'downloaded is ALL models');
  // Loaded models should appear first in the sorted list.
  assert.strictEqual(s.downloaded[0].key, 'mellum', 'loaded model first');
  console.log('  PASS: summarizeModels counts downloaded vs loaded; loaded-first ordering');
}

function testSummarizeModelsEmpty() {
  const s = summarizeModels([]);
  assert.deepStrictEqual(s.counts, { downloaded: 0, loaded: 0 });
  assert.deepStrictEqual(s.loaded, []);
  assert.deepStrictEqual(s.downloaded, []);
  console.log('  PASS: summarizeModels handles empty input');
}

function testSummarizeModelsNull() {
  const s = summarizeModels(null);
  assert.deepStrictEqual(s.counts, { downloaded: 0, loaded: 0 });
  assert.deepStrictEqual(s.loaded, []);
  assert.deepStrictEqual(s.downloaded, []);
  console.log('  PASS: summarizeModels handles null input');
}

function testSummarizeModelsMissingFields() {
  // Models with minimal data — only key is required to render something useful.
  const minimal = [
    { key: 'foo', loaded: true },
    { loaded: false }, // no key — should still be included safely
  ];
  const s = summarizeModels(minimal);
  assert.strictEqual(s.counts.downloaded, 2);
  assert.strictEqual(s.counts.loaded, 1);
  console.log('  PASS: summarizeModels is defensive about missing fields');
}

// ── /metrics parsing + usage summary ──────────────────────────────────────────────────────

// A representative Prometheus 0.0.4 exposition matching the gateway's metrics.ts output.
const SAMPLE_METRICS = `# HELP homeserver_requests_total Total gateway requests by model, outcome, and tier
# TYPE homeserver_requests_total counter
homeserver_requests_total{model="mellum",outcome="ok",tier="owner"} 40
homeserver_requests_total{model="mellum",outcome="error",tier="guest"} 2
homeserver_requests_total{model="qwen3-coder-next-80b",outcome="ok",tier="owner"} 10

# HELP homeserver_tokens_total Total tokens processed by model and direction (prompt|completion)
# TYPE homeserver_tokens_total counter
homeserver_tokens_total{model="mellum",direction="prompt"} 1000
homeserver_tokens_total{model="mellum",direction="completion"} 3000
homeserver_tokens_total{model="qwen3-coder-next-80b",direction="prompt"} 500
homeserver_tokens_total{model="qwen3-coder-next-80b",direction="completion"} 1500

# HELP homeserver_credits_consumed_total Lifetime credits consumed by tier
# TYPE homeserver_credits_consumed_total counter
homeserver_credits_consumed_total{tier="owner"} 5500
homeserver_credits_consumed_total{tier="guest"} 200

# HELP homeserver_admission_rejections_total Total admission rejections (503) by lane
# TYPE homeserver_admission_rejections_total counter
homeserver_admission_rejections_total{lane="guest"} 3

# HELP homeserver_rate_limited_total Total rate-limit rejections (429) by surface
# TYPE homeserver_rate_limited_total counter
homeserver_rate_limited_total{surface="quota"} 4
homeserver_rate_limited_total{surface="redeem"} 1

# HELP homeserver_request_duration_seconds Gateway request duration in seconds
# TYPE homeserver_request_duration_seconds histogram
homeserver_request_duration_seconds_bucket{model="mellum",le="0.5"} 30
homeserver_request_duration_seconds_bucket{model="mellum",le="+Inf"} 42
homeserver_request_duration_seconds_sum{model="mellum"} 21
homeserver_request_duration_seconds_count{model="mellum"} 42

# HELP homeserver_ttft_seconds Time to first token in seconds (streaming requests)
# TYPE homeserver_ttft_seconds histogram
homeserver_ttft_seconds_sum{model="mellum"} 8.4
homeserver_ttft_seconds_count{model="mellum"} 42

# HELP homeserver_inflight_requests Current in-flight inference requests
# TYPE homeserver_inflight_requests gauge
homeserver_inflight_requests 1
`;

function testParseMetricsBasic() {
  const { samples, errors } = parseMetrics(SAMPLE_METRICS);
  assert.ok(Array.isArray(samples), 'samples is an array');
  assert.ok(Array.isArray(errors), 'errors is an array');
  assert.strictEqual(errors.length, 0, 'valid metrics have no errors');
  // Comment/blank lines skipped; only sample lines parsed.
  const reqOk = samples.find((s) => s.name === 'homeserver_requests_total' && s.labels.model === 'mellum' && s.labels.outcome === 'ok');
  assert.ok(reqOk, 'parsed the mellum ok request counter');
  assert.strictEqual(reqOk.value, 40);
  assert.strictEqual(reqOk.labels.tier, 'owner');
  const gauge = samples.find((s) => s.name === 'homeserver_inflight_requests');
  assert.strictEqual(gauge.value, 1);
  assert.deepStrictEqual(gauge.labels, {}, 'an unlabelled gauge parses with empty labels');
  console.log('  PASS: parseMetrics returns { samples, errors } for valid exposition');
}

function testParseMetricsEmptyAndJunk() {
  // Empty/null/undefined → { samples: [], errors: [] } (not an array)
  const empty1 = parseMetrics('');
  assert.deepStrictEqual(empty1, { samples: [], errors: [] });
  const empty2 = parseMetrics(null);
  assert.deepStrictEqual(empty2, { samples: [], errors: [] });
  const empty3 = parseMetrics(undefined);
  assert.deepStrictEqual(empty3, { samples: [], errors: [] });
  // Comment-only → { samples: [], errors: [] } (genuine empty, NOT an error)
  const commentOnly = parseMetrics('# HELP foo bar\n# TYPE foo counter\n');
  assert.deepStrictEqual(commentOnly, { samples: [], errors: [] }, 'comment-only is genuine empty, not error');
  // A line with a non-numeric value is skipped and recorded as an error.
  const { samples, errors } = parseMetrics('foo_total{a="b"} not-a-number\nbar_total 7');
  assert.strictEqual(samples.length, 1, 'valid line is parsed');
  assert.strictEqual(samples[0].name, 'bar_total');
  assert.strictEqual(samples[0].value, 7);
  assert.strictEqual(errors.length, 1, 'unparseable line is recorded as error');
  assert.ok(errors[0].includes('not-a-number'), 'error entry contains the offending line');
  console.log('  PASS: parseMetrics returns { samples: [], errors: [] } for empty; errors for bad lines');
}

function testParseMetricsMalformedBody() {
  // (a) HTML error body (200 OK but not Prometheus text) → errors, no samples
  const htmlBody = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';
  const { samples: s1, errors: e1 } = parseMetrics(htmlBody);
  assert.ok(e1.length > 0, 'HTML body must produce parse errors');
  assert.strictEqual(s1.length, 0, 'HTML body must produce no valid samples');
  console.log('  PASS: parseMetrics HTML error body → { samples: [], errors: [non-empty] }');

  // (b) Body with one bad line mixed with valid lines → errors recorded, valid samples kept
  const mixed = 'homeserver_requests_total{model="mellum",outcome="ok",tier="owner"} 5\nthis is garbage\nhomeserver_inflight_requests 1';
  const { samples: s2, errors: e2 } = parseMetrics(mixed);
  assert.strictEqual(s2.length, 2, 'two valid samples parsed from mixed body');
  assert.strictEqual(e2.length, 1, 'one garbage line recorded as error');
  console.log('  PASS: parseMetrics mixed body → valid samples + error list');

  // (c) Comment-only / blank body → genuine empty (no errors)
  const blank = '\n\n# HELP foo bar\n# TYPE foo gauge\n\n';
  const { samples: s3, errors: e3 } = parseMetrics(blank);
  assert.deepStrictEqual(s3, [], 'blank/comment-only has no samples');
  assert.deepStrictEqual(e3, [], 'blank/comment-only has NO errors (genuine empty)');
  console.log('  PASS: parseMetrics blank/comment-only → genuine empty (no errors)');
}

function testParseMetricsTabSeparated() {
  // Finding 2a: unlabelled sample with tab separator between name and value
  const { samples, errors } = parseMetrics('homeserver_inflight_requests\t3');
  assert.strictEqual(samples.length, 1, 'tab-separated unlabelled gauge must parse');
  assert.strictEqual(samples[0].value, 3);
  assert.strictEqual(errors.length, 0);
  console.log('  PASS: parseMetrics accepts tab-separated unlabelled gauge');
}

function testParseMetricsNonFiniteValues() {
  // Finding 2b: Prometheus spec permits NaN, +Inf, -Inf as valid numeric tokens
  const text = [
    'go_goroutines NaN',
    'go_mem_heap_idle_bytes +Inf',
    'go_mem_heap_sys_bytes -Inf',
    'homeserver_requests_total{model="mellum",outcome="ok",tier="owner"} 1e2',
  ].join('\n');
  const { samples, errors } = parseMetrics(text);
  assert.strictEqual(errors.length, 0, 'NaN/+Inf/-Inf/exponent must not be errors');
  assert.strictEqual(samples.length, 4, 'all 4 lines must parse as samples');
  assert.ok(Number.isNaN(samples[0].value), 'NaN parsed as JS NaN');
  assert.strictEqual(samples[1].value, Infinity, '+Inf parsed as Infinity');
  assert.strictEqual(samples[2].value, -Infinity, '-Inf parsed as -Infinity');
  assert.strictEqual(samples[3].value, 100, 'exponent notation parses');
  console.log('  PASS: parseMetrics accepts NaN/+Inf/-Inf/exponent numeric tokens');
}

function testParseMetricsLabelValueWithComma() {
  // Label values may legitimately contain a comma inside quotes (e.g. a weird model id).
  const { samples } = parseMetrics('homeserver_tokens_total{model="a,b",direction="prompt"} 5');
  assert.strictEqual(samples.length, 1);
  assert.strictEqual(samples[0].labels.model, 'a,b');
  assert.strictEqual(samples[0].labels.direction, 'prompt');
  assert.strictEqual(samples[0].value, 5);
  console.log('  PASS: parseMetrics handles label values with embedded commas');
}

function testSummarizeUsageMetricsIgnoresNonFinite() {
  // NaN/Inf values from parseMetrics should be ignored in counters/gauges (not crash/NaN-render)
  const { samples } = parseMetrics('homeserver_requests_total{model="mellum",outcome="ok",tier="owner"} NaN');
  // NaN is treated as 0 in the accumulator (Number(NaN) || 0 is used implicitly via v = NaN)
  // The real requirement: summarizeUsageMetrics must not produce NaN in totals
  const u = summarizeUsageMetrics(samples);
  assert.ok(!Number.isNaN(u.totals.requests), 'totals.requests must not be NaN');
  console.log('  PASS: summarizeUsageMetrics ignores NaN values in counters');
}

function testSummarizeUsageMetrics() {
  const { samples } = parseMetrics(SAMPLE_METRICS);
  const u = summarizeUsageMetrics(samples);

  // Aggregate totals.
  assert.strictEqual(u.totals.requests, 52);          // 40 + 2 + 10
  assert.strictEqual(u.totals.promptTokens, 1500);    // 1000 + 500
  assert.strictEqual(u.totals.completionTokens, 4500);// 3000 + 1500
  assert.strictEqual(u.totals.totalTokens, 6000);
  assert.strictEqual(u.totals.credits, 5700);         // 5500 + 200

  // Per-model, sorted by requests desc → mellum (42) first.
  assert.strictEqual(u.models[0].model, 'mellum');
  assert.strictEqual(u.models[0].requests, 42);
  assert.strictEqual(u.models[0].totalTokens, 4000);
  // avg duration = sum/count = 21/42 = 0.5s
  assert.ok(Math.abs(u.models[0].avgDurationSec - 0.5) < 1e-9);
  // avg ttft = 8.4/42 = 0.2s
  assert.ok(Math.abs(u.models[0].avgTtftSec - 0.2) < 1e-9);
  assert.strictEqual(u.models[1].model, 'qwen3-coder-next-80b');
  assert.strictEqual(u.models[1].requests, 10);
  // Model with no histogram samples → null averages (not 0/NaN).
  assert.strictEqual(u.models[1].avgDurationSec, null);
  assert.strictEqual(u.models[1].avgTtftSec, null);

  // Outcomes aggregated, ok first.
  assert.deepStrictEqual(u.outcomes, [{ outcome: 'ok', count: 50 }, { outcome: 'error', count: 2 }]);

  // Admission rejections summed across lanes; rate-limited split by surface.
  assert.strictEqual(u.admissionRejections, 3);
  assert.deepStrictEqual(u.rateLimited, [{ surface: 'quota', count: 4 }, { surface: 'redeem', count: 1 }]);

  // In-flight gauge.
  assert.strictEqual(u.inflight, 1);
  console.log('  PASS: summarizeUsageMetrics produces correct totals, per-model, outcomes, rejections');
}

function testSummarizeUsageMetricsEmpty() {
  const u = summarizeUsageMetrics([]);
  assert.deepStrictEqual(u.models, []);
  assert.deepStrictEqual(u.totals, { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, credits: 0 });
  assert.deepStrictEqual(u.outcomes, []);
  assert.strictEqual(u.admissionRejections, 0);
  assert.deepStrictEqual(u.rateLimited, []);
  assert.strictEqual(u.inflight, null);
  // Defensive against non-array input.
  assert.strictEqual(summarizeUsageMetrics(null).totals.requests, 0);
  console.log('  PASS: summarizeUsageMetrics handles empty/null input');
}

function testSummarizeUsageMetricsResistsPrototypePollution() {
  // A malicious model label of "__proto__" must not touch Object.prototype.
  const { samples: s } = parseMetrics('homeserver_requests_total{model="__proto__",outcome="ok",tier="guest"} 1');
  const u = summarizeUsageMetrics(s);
  assert.strictEqual(u.models.length, 1);
  assert.strictEqual(u.models[0].model, '__proto__');
  // Object.prototype is untouched.
  assert.strictEqual({}.requests, undefined);
  console.log('  PASS: summarizeUsageMetrics resists prototype pollution from model labels');
}

async function testFetchMetricsSuccess() {
  const fakeFetch = async () => ({ ok: true, text: async () => SAMPLE_METRICS });
  const r = await fetchMetrics('http://x', 'k', { _fetch: fakeFetch });
  assert.ok(r.text.includes('homeserver_requests_total'));
  assert.strictEqual(r.error, undefined);
  console.log('  PASS: fetchMetrics returns { text } on success');
}

async function testFetchMetricsHttpError() {
  const fakeFetch = async () => ({ ok: false, status: 401 });
  const r = await fetchMetrics('http://x', 'k', { _fetch: fakeFetch });
  assert.strictEqual(r.error, 'metrics HTTP 401');
  console.log('  PASS: fetchMetrics returns { error } on HTTP 401');
}

async function testFetchMetricsNetworkFailure() {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await fetchMetrics('http://x', 'k', { _fetch: fakeFetch });
  assert.strictEqual(r.error, 'ECONNREFUSED');
  console.log('  PASS: fetchMetrics returns { error } on network failure');
}

async function main() {
  console.log('M5 dashboard data-layer tests:');
  testResistsPrototypePollutionKeys();
  testLedgerToMatrix();
  testLedgerToMatrixEmpty();
  testTallyVerdicts();
  testDeriveRouting();
  testDeriveRoutingTieBreaksByTokPerSec();
  testParseValidBullets();
  testParseNumberedAndExtra();
  testParseRejectsTooLong();
  testParseRejectsGarbage();
  await testGenerateValidatesAndCaches();
  await testGenerateFallbackOnInvalid();
  await testGenerateFallbackOnError();
  // New regression tests (Fixes 1–3):
  await testGenerateCoalescesInFlight();
  testParseDropsCodeFences();
  testParseDropsCodeFenceWithLang();
  testParseSkipsPreambleLine();
  await testCacheExpiryRegenerates();
  // fetchModels + summarizeModels tests:
  await testFetchModelsSuccess();
  await testFetchModelsNonArrayBody();
  await testFetchModelsHttpError();
  await testFetchModelsNetworkFailure();
  testSummarizeModelsBasic();
  testSummarizeModelsEmpty();
  testSummarizeModelsNull();
  testSummarizeModelsMissingFields();
  await testFetchModelsNullOpts();
  // /metrics parsing + usage summary tests:
  testParseMetricsBasic();
  testParseMetricsEmptyAndJunk();
  testParseMetricsMalformedBody();
  testParseMetricsTabSeparated();
  testParseMetricsNonFiniteValues();
  testParseMetricsLabelValueWithComma();
  testSummarizeUsageMetrics();
  testSummarizeUsageMetricsEmpty();
  testSummarizeUsageMetricsIgnoresNonFinite();
  testSummarizeUsageMetricsResistsPrototypePollution();
  await testFetchMetricsSuccess();
  await testFetchMetricsHttpError();
  await testFetchMetricsNetworkFailure();
  console.log('\nAll M5 dashboard tests passed.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
