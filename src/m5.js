'use strict';

/**
 * M5 — "What We've Learned" dashboard data layer.
 *
 * Heimdall runs on the Pi, a DIFFERENT host than the home-server inference repo, so this
 * module prefers LIVE network calls to the M5 gateway over reading local files. It reuses
 * the EXACT same gateway config as src/inference.js:
 *   - HOMESERVER_GATEWAY_URL      (M5 Tailscale URL, e.g. http://192.0.2.30:8080)
 *   - HOMESERVER_GATEWAY_API_KEY  (owner Bearer; sent on /ledger + /v1/chat/completions)
 *
 * Responsibilities:
 *   - fetchLedger()        — live GET /ledger → { report, recent } (or { error })
 *   - ledgerToMatrix()     — pure: report[] → task_type × model matrix for the capability map
 *   - tallyVerdicts()      — pure: report[] → verdict counts, for both the matrix and the summary prompt
 *   - generateFindings()   — POST /v1/chat/completions (model: mellum) → VALIDATED ~3 bullets,
 *                            with in-memory ~1h TTL cache + graceful fallback to static findings
 *   - deriveRoutingFromLedger() — pure: report[] → best-model-per-task hint (panel-4 fallback when
 *                            no M5_ROUTING_JSON_PATH file is present)
 *
 * The contract is documented in `docs/gateway-api-contract.md` in the
 * home-server-inference-evaluation repo.
 */

const GATEWAY_DEFAULT = process.env.HOMESERVER_GATEWAY_URL || 'http://127.0.0.1:8080';
const LEDGER_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 30000; // local generation can be slow on a cold model load

// Canonical model column order for the capability map (RQ5 fleet). Anything the ledger
// reports outside this set is appended after, so a new model never silently disappears.
const KNOWN_MODELS = ['mellum', 'qwen3-coder-next-80b', 'gemma4', 'qwen35-a3b'];

// Hand-curated headline findings (verified, M5-generated over the RQ5 battery). These are the
// stable "what we learned" conclusions; they render even when the gateway is unreachable.
const STATIC_FINDINGS = [
  'Thinking models are <strong>worse</strong> for delegated sub-tasks — qwen35-a3b &amp; gemma4 burn their token/time budget on reasoning_content and return empty content on short tasks.',
  'Mellum is the fast workhorse (138 tok/s) for classify / extract / code / summarize — non-thinking, high throughput, the default for short delegated work.',
  'SQL is the universal gap — every local model scores ≤50%, so SQL always escalates to a frontier model.',
  'qwen3-coder-next-80b is the strongest local model and the escalation target for hard local work before reaching for a frontier model.',
  'Meta-finding: local STT (whisper) works great, but local PR-review does not — the 80B spirals on review-style tasks.',
];

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Live GET /healthz. Health is intentionally independent of usage-history availability. */
async function fetchHealth(baseUrl = GATEWAY_DEFAULT, opts = {}) {
  const safeOpts = opts !== null && typeof opts === 'object' ? opts : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LEDGER_TIMEOUT_MS);
  try {
    const fetchImpl = safeOpts._fetch || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { error: 'fetch unavailable' };
    const base = String(baseUrl).replace(/\/$/, '');
    const res = await fetchImpl(`${base}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return { error: `health HTTP ${res.status}` };
    const body = await res.json();
    return body && body.ok === true ? { ok: true } : { error: 'health response malformed' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live GET /ops/summary. The gateway response is content-blind, but is still treated as
 * untrusted input: validate its small bounded shape before it reaches the renderer.
 */
async function fetchOperations(
  baseUrl = GATEWAY_DEFAULT,
  apiKey = process.env.HOMESERVER_GATEWAY_API_KEY,
  opts = {},
) {
  const safeOpts = opts !== null && typeof opts === 'object' ? opts : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LEDGER_TIMEOUT_MS);
  try {
    const fetchImpl = safeOpts._fetch || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { error: 'fetch unavailable' };
    const base = String(baseUrl).replace(/\/$/, '');
    const res = await fetchImpl(`${base}/ops/summary`, {
      headers: authHeaders(apiKey),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `usage HTTP ${res.status}` };
    const body = await res.json();
    const last24 = body && body.last24Hours;
    const last7 = body && body.last7Days;
    const daily = body && body.daily;
    if (
      !body || typeof body.generatedAt !== 'string'
      || nonNegativeNumber(body.activeRequests) === null
      || !last24 || nonNegativeNumber(last24.requests) === null || nonNegativeNumber(last24.requestTimeMs) === null
      || !last7 || nonNegativeNumber(last7.requests) === null || nonNegativeNumber(last7.requestTimeMs) === null
      || !Array.isArray(daily) || daily.length > 31
      || !(body.lastUsedAt === null || typeof body.lastUsedAt === 'string')
    ) return { error: 'usage response malformed' };

    const normalizedDays = [];
    for (const day of daily) {
      if (
        !day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
        || nonNegativeNumber(day.requests) === null || nonNegativeNumber(day.requestTimeMs) === null
      ) return { error: 'usage response malformed' };
      normalizedDays.push({ date: day.date, requests: day.requests, requestTimeMs: day.requestTimeMs });
    }

    return {
      summary: {
        generatedAt: body.generatedAt,
        activeRequests: body.activeRequests,
        lastUsedAt: body.lastUsedAt,
        last24Hours: { requests: last24.requests, requestTimeMs: last24.requestTimeMs },
        last7Days: { requests: last7.requests, requestTimeMs: last7.requestTimeMs },
        daily: normalizedDays,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live GET /ledger. Best-effort: returns { report, recent } on success, or { error } on any
 * failure (unreachable / non-2xx / unparseable). NEVER throws — the card renders a clean note.
 */
async function fetchLedger(baseUrl = GATEWAY_DEFAULT, apiKey = process.env.HOMESERVER_GATEWAY_API_KEY) {
  const base = String(baseUrl).replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LEDGER_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/ledger`, { headers: authHeaders(apiKey), signal: ctrl.signal });
    if (!res.ok) return { error: `ledger HTTP ${res.status}` };
    const body = await res.json();
    return {
      report: Array.isArray(body && body.report) ? body.report : [],
      recent: Array.isArray(body && body.recent) ? body.recent : [],
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live GET /models. Best-effort: returns { models: ModelInfo[] } on success, or { error } on any
 * failure (unreachable / non-2xx / unparseable). NEVER throws — the card renders a clean note.
 *
 * Each ModelInfo has at minimum: key (string), displayName (string), type (string), loaded (boolean).
 * Optional fields: sizeBytes, quantization, maxContextLength, architecture, paramsString, vision, toolUse.
 *
 * @param {string} [baseUrl]
 * @param {string|null} [apiKey]
 * @param {object} [opts]
 * @param {function} [opts._fetch]  injectable fetch (tests)
 */
async function fetchModels(
  baseUrl = GATEWAY_DEFAULT,
  apiKey = process.env.HOMESERVER_GATEWAY_API_KEY,
  opts = {},
) {
  // Guard opts: treat null/non-object as {} so callers that pass null don't reject before try.
  const safeOpts = (opts !== null && typeof opts === 'object') ? opts : {};
  // Resolve the fetch impl inside the try block so ANY setup error resolves to { error }.
  let _fetch;
  let base;
  let ctrl;
  let timer;
  try {
    _fetch = safeOpts._fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    if (!_fetch) return { error: 'fetch unavailable' };
    base = String(baseUrl).replace(/\/$/, '');
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), LEDGER_TIMEOUT_MS);
    const res = await _fetch(`${base}/models`, { headers: authHeaders(apiKey), signal: ctrl.signal });
    if (!res.ok) return { error: `models HTTP ${res.status}` };
    const body = await res.json();
    // Guard against non-array / prototype-polluting values from the server.
    return { models: Array.isArray(body && body.models) ? body.models : [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    // timer may be undefined if setup failed before setTimeout; clearTimeout(undefined) is safe.
    clearTimeout(timer);
  }
}

/**
 * Pure: summarize a ModelInfo[] (from fetchModels) into a render-friendly structure.
 *
 * Returns:
 *   {
 *     downloaded: ModelInfo[],  // all models, loaded-first then alphabetically by key
 *     loaded: ModelInfo[],      // only models with loaded === true
 *     counts: { downloaded: number, loaded: number },
 *   }
 *
 * Defensive: handles null/non-array input, missing fields.
 */
function summarizeModels(models) {
  const list = Array.isArray(models) ? models : [];
  const loaded = list.filter((m) => m && m.loaded === true);
  const notLoaded = list.filter((m) => !m || m.loaded !== true);

  // Sort loaded-first, then by key alphabetically within each group.
  const sortByKey = (a, b) => String(a && a.key || '').localeCompare(String(b && b.key || ''));
  const downloaded = [...loaded.slice().sort(sortByKey), ...notLoaded.slice().sort(sortByKey)];

  return {
    downloaded,
    loaded,
    counts: { downloaded: list.length, loaded: loaded.length },
  };
}

/**
 * Pure: collapse report[] into a task_type × model matrix.
 * @returns {{ taskTypes: string[], models: string[], cells: Object<string,Object<string,Cell>> }}
 *   cells[taskType][modelId] = { verdict, successRate, tokPerSec, frozen, attempts }
 */
function ledgerToMatrix(report) {
  const rows = Array.isArray(report) ? report : [];
  const taskTypeSet = new Set();
  const modelSet = new Set();
  // Null-prototype maps: ledger-supplied taskType/modelId are used as keys, so a row with
  // taskType "__proto__" must not touch any prototype. Keys are also validated as strings.
  const cells = Object.create(null);

  for (const r of rows) {
    if (!r || typeof r.taskType !== 'string' || typeof r.modelId !== 'string' || !r.taskType || !r.modelId) continue;
    taskTypeSet.add(r.taskType);
    modelSet.add(r.modelId);
    if (!cells[r.taskType]) cells[r.taskType] = Object.create(null);
    cells[r.taskType][r.modelId] = {
      verdict: r.verdict || 'unknown',
      successRate: typeof r.successRate === 'number' ? r.successRate : null,
      tokPerSec: typeof r.avgTokPerSec === 'number' ? r.avgTokPerSec : null,
      frozen: !!r.frozen,
      attempts: r.attempts || 0,
    };
  }

  // Column order: known models first (stable), then any extras the ledger surfaces.
  const models = [
    ...KNOWN_MODELS.filter((m) => modelSet.has(m)),
    ...[...modelSet].filter((m) => !KNOWN_MODELS.includes(m)).sort(),
  ];
  // If the ledger is empty we still want the canonical columns visible.
  const cols = models.length ? models : KNOWN_MODELS.slice();
  const taskTypes = [...taskTypeSet].sort();

  return { taskTypes, models: cols, cells };
}

/**
 * Pure: count verdicts across report[]. Used by the matrix legend and the summary prompt.
 */
function tallyVerdicts(report) {
  const tally = { viable: 0, marginal: 0, not_viable: 0, unknown: 0 };
  for (const r of Array.isArray(report) ? report : []) {
    if (r && Object.prototype.hasOwnProperty.call(tally, r.verdict)) tally[r.verdict]++;
  }
  return tally;
}

/**
 * Pure: derive a lightweight routing hint from live ledger data — the best local model per
 * task type by success rate (ties broken by tok/s). Used as the panel-4 fallback when there is
 * no M5_ROUTING_JSON_PATH snapshot on disk.
 * @returns {Array<{ taskType, model, successRate, tokPerSec, verdict, recommendation }>}
 */
function deriveRoutingFromLedger(report) {
  // Null-prototype map (see ledgerToMatrix): guards against a taskType of "__proto__",
  // which on a plain object would resolve to Object.prototype and throw on .push().
  const byTask = Object.create(null);
  for (const r of Array.isArray(report) ? report : []) {
    if (!r || typeof r.taskType !== 'string' || typeof r.modelId !== 'string' || !r.taskType || !r.modelId) continue;
    (byTask[r.taskType] = byTask[r.taskType] || []).push(r);
  }
  const out = [];
  for (const taskType of Object.keys(byTask).sort()) {
    const candidates = byTask[taskType].slice().sort((a, b) => {
      const sa = typeof a.successRate === 'number' ? a.successRate : -1;
      const sb = typeof b.successRate === 'number' ? b.successRate : -1;
      if (sb !== sa) return sb - sa;
      return (b.avgTokPerSec || 0) - (a.avgTokPerSec || 0);
    });
    const best = candidates[0];
    // If even the best local model isn't viable, the routing hint is "escalate".
    const recommendation =
      best.recommendation ||
      (best.verdict === 'viable' ? 'delegate-local' : best.verdict === 'unknown' ? 'explore' : 'escalate-frontier');
    out.push({
      taskType,
      model: best.modelId,
      successRate: typeof best.successRate === 'number' ? best.successRate : null,
      tokPerSec: typeof best.avgTokPerSec === 'number' ? best.avgTokPerSec : null,
      verdict: best.verdict || 'unknown',
      recommendation,
    });
  }
  return out;
}

// ── M5-generated summary: generate → VALIDATE → cache (in-memory ~1h TTL) ──────────────────

const SUMMARY_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_BULLET_LEN = 120;
let _summaryCache = null; // { bullets: string[], generatedAt: ISO, model: string }
let _summaryInFlight = null; // Promise<result> while a generation is in progress

/** Test/maintenance hook: drop the cache (and any in-flight reference). */
function _resetSummaryCache() { _summaryCache = null; _summaryInFlight = null; }

/** Test-only hook: seed the cache with a specific value (e.g. to simulate expiry). */
function __setSummaryCacheForTest(value) { _summaryCache = value; }

/**
 * Parse + VALIDATE the model's reply into ~3 short bullet strings.
 * Accepts a raw assistant message string. Returns string[] on success or null on validation
 * failure — the caller treats null as "fall back to static findings".
 */
function parseFindingsReply(content) {
  if (typeof content !== 'string' || !content.trim()) return null;

  const lines = content.split('\n');

  // (a) Drop pure markdown code-fence lines (``` optionally followed by a language tag).
  const noFences = lines.filter((l) => !/^\s*```\w*\s*$/.test(l));

  // Strip bullet/numbered markers and trim each remaining line.
  const stripped = noFences
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);

  // (b) If the first content line looks like a non-bullet preamble AND the remaining lines
  // are all bullet-like (started with a marker before stripping), skip the preamble line.
  let bullets = stripped;
  if (stripped.length >= 2) {
    // Classify each non-empty, non-fence original line as having a bullet marker or not.
    const contentLines = noFences.filter((l) => l.trim().length > 0);
    const firstHasMarker = /^\s*(?:[-*•]|\d+[.)])\s/.test(contentLines[0] || '');
    const restAllHaveMarker = contentLines.slice(1).length > 0 &&
      contentLines.slice(1).every((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l));
    if (!firstHasMarker && restAllHaveMarker) {
      const rest = stripped.slice(1);
      if (rest.length >= 2) {
        bullets = rest;
      }
    }
  }

  // Expect "~3" bullets: tolerate 2..6, then take the first 3.
  if (bullets.length < 2 || bullets.length > 6) return null;
  const trimmed = bullets.slice(0, 3);
  // Each must be a short, single-line takeaway within the length bound.
  for (const b of trimmed) {
    if (b.length === 0 || b.length > MAX_BULLET_LEN) return null;
  }
  return trimmed;
}

/**
 * Generate a FRESH "what we learned" summary on the M5 itself (model: mellum), feeding it the
 * live verdict tallies. VALIDATES the reply, CACHES it (~1h TTL), and falls back gracefully.
 *
 * @returns {Promise<{ bullets: string[], generatedAt: string, model: string } | null>}
 *   null → generation failed/invalid/timed out; caller shows static findings only.
 *
 * @param {object} [opts]
 * @param {object} [opts.tally]   verdict tally to feed the prompt (from tallyVerdicts)
 * @param {boolean} [opts.force]  bypass the TTL cache (tests)
 * @param {function} [opts._fetch] injectable fetch (tests)
 */
async function generateFindings(opts = {}) {
  const { tally, force, _fetch = fetch } = opts;
  const baseUrl = opts.baseUrl || GATEWAY_DEFAULT;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.HOMESERVER_GATEWAY_API_KEY;

  // Serve from cache unless expired or forced — do NOT call the M5 on every page render.
  if (!force && _summaryCache && Date.now() - new Date(_summaryCache.generatedAt).getTime() < SUMMARY_TTL_MS) {
    return _summaryCache;
  }

  // Coalesce: if a generation is already in flight, return the same promise to all concurrent
  // callers rather than firing N parallel gateway requests.  force:true bypasses coalescing.
  if (!force && _summaryInFlight) {
    return _summaryInFlight;
  }

  const t = tally || { viable: 0, marginal: 0, not_viable: 0, unknown: 0 };
  const tallyLine = `viable=${t.viable}, marginal=${t.marginal}, not_viable=${t.not_viable}, unknown=${t.unknown}`;
  const userPrompt =
    `Capability ledger verdict tallies across local models (task_type × model pairs): ${tallyLine}. ` +
    `Write exactly 3 short bullet takeaways (each 120 characters or fewer) on which task types ` +
    `suit local models versus which need escalation to a frontier model. ` +
    `Return ONLY the 3 bullets, one per line, no preamble.`;

  const base = String(baseUrl).replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);

  const doFetch = async () => {
    try {
      const res = await _fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: 'mellum',
          messages: [
            { role: 'system', content: 'You are a terse data analyst. Output only the requested bullets.' },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 256,
          temperature: 0.2,
          stream: false,
        }),
      });
      if (!res.ok) return null; // any non-2xx → fall back
      const body = await res.json();
      const content = body && body.choices && body.choices[0] && body.choices[0].message
        ? body.choices[0].message.content
        : null;
      const bullets = parseFindingsReply(content);
      if (!bullets) return null; // VALIDATION failed → fall back to static findings
      _summaryCache = { bullets, generatedAt: new Date().toISOString(), model: 'mellum' };
      return _summaryCache;
    } catch {
      return null; // timeout / network / parse error → fall back
    } finally {
      clearTimeout(timer);
    }
  };

  _summaryInFlight = doFetch().finally(() => { _summaryInFlight = null; });
  return _summaryInFlight;
}

// ── Usage metrics: live authed GET /metrics (Prometheus text) → parse → summarize ──────────
//
// CONTENT-BLIND by construction: the gateway's /metrics surface exposes ONLY aggregate counters,
// histograms, and coarse labels (model, outcome, tier, direction, lane, surface). There is no
// per-user / per-key / content dimension to leak. We parse it into per-model + aggregate views
// for the owner-only Heimdall dashboard. /metrics is AUTHED — the same Bearer key already used
// for /ledger (a read-only monitor key suffices).

/**
 * Live GET /metrics (Prometheus 0.0.4 text). Best-effort: returns { text } on success or { error }
 * on any failure (unreachable / non-2xx / unparseable). NEVER throws.
 *
 * @param {string} [baseUrl]
 * @param {string|null} [apiKey]
 * @param {object} [opts]
 * @param {function} [opts._fetch]  injectable fetch (tests)
 */
async function fetchMetrics(
  baseUrl = GATEWAY_DEFAULT,
  apiKey = process.env.HOMESERVER_GATEWAY_API_KEY,
  opts = {},
) {
  const safeOpts = (opts !== null && typeof opts === 'object') ? opts : {};
  let _fetch;
  let base;
  let ctrl;
  let timer;
  try {
    _fetch = safeOpts._fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    if (!_fetch) return { error: 'fetch unavailable' };
    base = String(baseUrl).replace(/\/$/, '');
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), LEDGER_TIMEOUT_MS);
    const res = await _fetch(`${base}/metrics`, { headers: authHeaders(apiKey), signal: ctrl.signal });
    if (!res.ok) return { error: `metrics HTTP ${res.status}` };
    const text = await res.text();
    return { text: typeof text === 'string' ? text : '' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a Prometheus numeric token. The spec allows NaN, +Inf, -Inf in addition to
 * decimal/exponent notation. `Number()` already handles all of these correctly in V8:
 *   Number('NaN') === NaN, Number('+Inf') === Infinity, Number('-Inf') === -Infinity.
 * We treat any value where `Number(token)` produces a finite number OR one of the
 * special Prometheus tokens (NaN / ±Infinity) as valid; anything else is malformed.
 *
 * @param {string} token
 * @returns {{ ok: true, value: number } | { ok: false }}
 */
function _parsePrometheusNumber(token) {
  const t = token.trim();
  // Fast-path the three special tokens (case-sensitive per Prometheus spec).
  if (t === 'NaN') return { ok: true, value: NaN };
  if (t === '+Inf') return { ok: true, value: Infinity };
  if (t === '-Inf') return { ok: true, value: -Infinity };
  const n = Number(t);
  if (Number.isFinite(n)) return { ok: true, value: n };
  return { ok: false };
}

/**
 * Pure: parse a Prometheus 0.0.4 text exposition.
 * Comment (`# HELP` / `# TYPE`) and blank lines are skipped. Each sample is
 * `{ name, labels: {k:v}, value }`. Robust to label values containing `,` or `=` (we split on
 * the first `=` per pair and tolerate quoted values).
 *
 * Unlike the old signature (which returned a flat array and silently dropped bad lines), this
 * version returns `{ samples, errors }` so callers can distinguish:
 *   - genuine empty: `{ samples: [], errors: [] }` — comment-only or blank body; zero requests is correct.
 *   - malformed: `{ samples: [], errors: ['...'] }` — non-comment lines that failed to parse (e.g. an
 *     HTML error body returned by an intermediate proxy on a 200).
 *
 * @param {string} text
 * @returns {{ samples: Array<{name:string, labels:Object<string,string>, value:number}>, errors: string[] }}
 */
function parseMetrics(text) {
  const samples = [];
  const errors = [];
  if (typeof text !== 'string' || !text) return { samples, errors };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Match: name{labels} value   OR   name value  (spaces OR tabs between name/value)
    const braceIdx = line.indexOf('{');
    let name;
    let labelStr = '';
    let rest;
    if (braceIdx !== -1) {
      name = line.slice(0, braceIdx);
      const closeIdx = line.indexOf('}', braceIdx);
      if (closeIdx === -1) { errors.push(line); continue; }
      labelStr = line.slice(braceIdx + 1, closeIdx);
      rest = line.slice(closeIdx + 1).trim();
    } else {
      // Accept whitespace (space or tab) as the separator between name and value.
      const sp = line.search(/[\s]/);
      if (sp === -1) { errors.push(line); continue; }
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }
    // The value field may be followed by an optional timestamp; take only the first token.
    const valueToken = rest.split(/\s+/)[0];
    const parsed = _parsePrometheusNumber(valueToken);
    if (!name || !parsed.ok) { errors.push(line); continue; }
    const labels = {};
    if (labelStr) {
      // Split label pairs on commas NOT inside quotes.
      const pairs = labelStr.match(/[^,]+="(?:[^"\\]|\\.)*"|[^,]+=[^,]*/g) || [];
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq === -1) continue;
        const k = p.slice(0, eq).trim();
        let v = p.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) {
          v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
        }
        if (k) labels[k] = v;
      }
    }
    samples.push({ name, labels, value: parsed.value });
  }
  return { samples, errors };
}

/**
 * Pure: collapse parsed /metrics samples into a render-friendly usage summary.
 *
 * Returns:
 *   {
 *     models: Array<{ model, requests, promptTokens, completionTokens, totalTokens,
 *                     avgDurationSec, avgTtftSec }>,   // per-model, sorted by requests desc
 *     totals: { requests, promptTokens, completionTokens, totalTokens, credits },
 *     outcomes: Array<{ outcome, count }>,             // aggregate by outcome, count desc
 *     admissionRejections: number,                      // homeserver_admission_rejections_total (all lanes)
 *     rateLimited: Array<{ surface, count }>,           // by surface
 *     inflight: number|null,                            // current in-flight gauge (null if absent)
 *   }
 *
 * All numeric only — NO per-user / per-key / content dimension exists in the source.
 *
 * @param {Array} samples  output of parseMetrics()
 */
function summarizeUsageMetrics(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  // Null-prototype maps: model/outcome/surface labels are gateway-supplied strings used as keys.
  const byModel = Object.create(null);
  const outcomeCounts = Object.create(null);
  const surfaceCounts = Object.create(null);
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, credits: 0 };
  let admissionRejections = 0;
  let inflight = null;

  function model(m) {
    const key = (typeof m === 'string' && m) ? m : 'none';
    if (!byModel[key]) {
      byModel[key] = {
        model: key, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        _durSum: 0, _durCount: 0, _ttftSum: 0, _ttftCount: 0,
      };
    }
    return byModel[key];
  }

  for (const s of rows) {
    if (!s || typeof s.name !== 'string') continue;
    const L = s.labels || {};
    // Non-finite values (NaN, ±Inf) are valid Prometheus tokens but meaningless for the
    // integer counters/gauges this UI renders. Treat them as 0 rather than propagating NaN.
    const v = (typeof s.value === 'number' && Number.isFinite(s.value)) ? s.value : 0;
    switch (s.name) {
      case 'homeserver_requests_total': {
        model(L.model).requests += v;
        totals.requests += v;
        const oc = (typeof L.outcome === 'string' && L.outcome) ? L.outcome : 'unknown';
        outcomeCounts[oc] = (outcomeCounts[oc] || 0) + v;
        break;
      }
      case 'homeserver_tokens_total': {
        const mm = model(L.model);
        if (L.direction === 'prompt') { mm.promptTokens += v; totals.promptTokens += v; }
        else if (L.direction === 'completion') { mm.completionTokens += v; totals.completionTokens += v; }
        mm.totalTokens += v;
        totals.totalTokens += v;
        break;
      }
      case 'homeserver_credits_consumed_total':
        totals.credits += v;
        break;
      case 'homeserver_admission_rejections_total':
        admissionRejections += v;
        break;
      case 'homeserver_rate_limited_total': {
        const sf = (typeof L.surface === 'string' && L.surface) ? L.surface : 'unknown';
        surfaceCounts[sf] = (surfaceCounts[sf] || 0) + v;
        break;
      }
      case 'homeserver_request_duration_seconds_sum':
        model(L.model)._durSum += v;
        break;
      case 'homeserver_request_duration_seconds_count':
        model(L.model)._durCount += v;
        break;
      case 'homeserver_ttft_seconds_sum':
        model(L.model)._ttftSum += v;
        break;
      case 'homeserver_ttft_seconds_count':
        model(L.model)._ttftCount += v;
        break;
      case 'homeserver_inflight_requests':
        inflight = v;
        break;
      default:
        break;
    }
  }

  const models = Object.values(byModel)
    .map((m) => ({
      model: m.model,
      requests: m.requests,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.totalTokens,
      avgDurationSec: m._durCount > 0 ? m._durSum / m._durCount : null,
      avgTtftSec: m._ttftCount > 0 ? m._ttftSum / m._ttftCount : null,
    }))
    .sort((a, b) => (b.requests - a.requests) || a.model.localeCompare(b.model));

  const outcomes = Object.entries(outcomeCounts)
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => (b.count - a.count) || a.outcome.localeCompare(b.outcome));

  const rateLimited = Object.entries(surfaceCounts)
    .map(([surface, count]) => ({ surface, count }))
    .sort((a, b) => (b.count - a.count) || a.surface.localeCompare(b.surface));

  return { models, totals, outcomes, admissionRejections, rateLimited, inflight };
}

module.exports = {
  KNOWN_MODELS,
  STATIC_FINDINGS,
  fetchHealth,
  fetchOperations,
  fetchLedger,
  fetchModels,
  fetchMetrics,
  summarizeModels,
  parseMetrics,
  summarizeUsageMetrics,
  ledgerToMatrix,
  tallyVerdicts,
  deriveRoutingFromLedger,
  generateFindings,
  parseFindingsReply,
  _resetSummaryCache,
  __setSummaryCacheForTest,
};
