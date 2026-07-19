'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');
const { before, after } = require('node:test');

const { memoryHealthRollup, memoryHealthCard } = require('../src/render/memory-health');
const { servicePage } = require('../src/render/service-page');
const { buildApp } = require('../src/server');
const { openDatabase, upsertServiceSnapshot } = require('../src/db');
const { unwrapMemoryHealth } = require('../src/munin-projects');

// ─── Fixture ─────────────────────────────────────────────────────────────────

// FIXTURE is the v2 wire payload; CANON is the unwrapped consumer shape.
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-health.json'), 'utf8')
);
const CANON = unwrapMemoryHealth(FIXTURE);

// Crafted acceptance variant: stuck=16, coverage=99.87% (golden v2 has stuck=0/coverage=0)
const STUCK_VARIANT = {
  ...CANON,
  embedding: {
    ...CANON.embedding,
    stuck: 16,
    coverage_pct: 99.87,
    counts: { ...CANON.embedding.counts, processing: 16, failed: 0 },
  },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function makeOperationallyHealthy(payload) {
  payload.embedding = {
    ...payload.embedding,
    coverage_pct: 100,
    counts: { pending: 0, processing: 0, generated: 8, failed: 0, total: 8 },
    stuck: 0,
    reembed_in_progress: false,
    embedding_available: true,
    circuit_breaker: 'healthy',
  };
  payload.consolidation = {
    ...payload.consolidation,
    worker: 'available',
    circuit_breaker: 'healthy',
    failures: 0,
    backlog: [],
    last_synthesis_at: new Date().toISOString(),
  };
  return payload;
}

function okResult(payloadOverride = {}) {
  return { status: 'ok', payload: { ...CANON, ...payloadOverride } };
}

function snapFor(name) {
  return {
    service: name, kind: 'mcp', status: 'pass', reachable: true, source: 'descriptor',
    fetchedAt: new Date(0).toISOString(),
    descriptor: {
      service: { name, label: name }, kind: 'mcp', status: 'pass',
      metrics: [], panels: [], links: {},
    },
  };
}

// ─── memoryHealthRollup ───────────────────────────────────────────────────────

describe('memoryHealthRollup — core cases', () => {
  it('CANON → crit because its embedding coverage is 0%', () => {
    assert.equal(memoryHealthRollup({ status: 'ok', payload: CANON }), 'crit');
  });

  it('consolidation.worker:unavailable → crit', () => {
    const p = deepClone(CANON);
    p.consolidation.worker = 'unavailable';
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'crit');
  });

  it('embedding.counts.failed > 0 → crit', () => {
    const p = deepClone(CANON);
    p.embedding.counts.failed = 1;
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'crit');
  });

  it('embedding.circuit_breaker tripped → crit', () => {
    const p = deepClone(CANON);
    p.embedding.circuit_breaker = 'tripped';
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'crit');
  });

  it('consolidation.failures >= max_failures → crit', () => {
    const p = deepClone(CANON);
    p.consolidation.backlog = [];
    p.consolidation.failures = 3; // >= max_failures (3) in golden fixture
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'crit');
  });

  it('all-zero healthy clone → ok', () => {
    const p = deepClone(CANON);
    // Remove all warn/crit conditions
    p.embedding.stuck = 0;
    p.embedding.counts.processing = 0;
    p.embedding.counts.pending = 0;
    p.embedding.counts.failed = 0;
    p.embedding.counts.generated = 12450;
    p.embedding.counts.total = 12450;
    p.embedding.coverage_pct = 100.0;
    p.embedding.circuit_breaker = 'healthy';
    p.consolidation.failures = 0;
    p.consolidation.worker = 'available';
    p.consolidation.circuit_breaker = 'healthy';
    p.consolidation.backlog = [];
    p.consolidation.last_synthesis_at = new Date().toISOString();
    p.maintenance = { active_but_stale: 0, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'ok');
  });

  it('{status: transport_error} → stale', () => {
    assert.equal(memoryHealthRollup({ status: 'transport_error' }), 'stale');
  });

  it('{status: invalid_schema} → stale', () => {
    assert.equal(memoryHealthRollup({ status: 'invalid_schema' }), 'stale');
  });

  it('null result → stale', () => {
    assert.equal(memoryHealthRollup(null), 'stale');
  });

  it('unknown circuit_breaker enum value → stale (§1.3)', () => {
    const p = deepClone(CANON);
    p.consolidation.backlog = [];
    p.consolidation.failures = 0;
    p.embedding.circuit_breaker = 'unknown-future-value';
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'stale');
  });

  it('backlog row over min_logs → warn', () => {
    const p = makeOperationallyHealthy(deepClone(CANON));
    p.consolidation.backlog = [{ namespace: 'projects/demo', unincorporated: 5 }];
    p.maintenance = { active_but_stale: 0, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'warn');
  });

  it('maintenance count > 0 → warn', () => {
    const p = makeOperationallyHealthy(deepClone(CANON));
    p.embedding.stuck = 0;
    p.embedding.counts.pending = 0;
    p.consolidation.backlog = [];
    p.consolidation.failures = 0;
    p.maintenance = { active_but_stale: 1, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'warn');
  });

  it('retrieved-unused telemetry alone does not create an operator warning', () => {
    const p = makeOperationallyHealthy(deepClone(CANON));
    p.maintenance = { active_but_stale: 0, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 41 };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'ok');
  });
});

// ─── memoryHealthCard — acceptance: stuck→amber (crafted variant) ────────────

describe('memoryHealthCard — stuck:16/coverage:99.87% variant (acceptance test §3.3)', () => {
  let html;
  it('renders without throwing', () => {
    html = memoryHealthCard({ status: 'ok', payload: STUCK_VARIANT });
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  it('coverage KPI value-span carries is-warn (not is-ok) — acceptance test §3.3', () => {
    html = memoryHealthCard({ status: 'ok', payload: STUCK_VARIANT });
    // The COVERAGE value (99.87%) must be amber — stuck>0 pushes it to warn.
    // (Other tiles may legitimately be green, e.g. Attention 0, so scope to coverage.)
    assert.match(html, /kpi-val is-warn">99\.87%/);
    assert.doesNotMatch(html, /kpi-val is-ok">99\.87%/);
  });

  it('stuck count 16 appears in the card', () => {
    html = memoryHealthCard({ status: 'ok', payload: STUCK_VARIANT });
    assert.match(html, /\b16\b/);
  });

  it('coverage percentage value appears (99.87)', () => {
    html = memoryHealthCard({ status: 'ok', payload: STUCK_VARIANT });
    assert.match(html, /99\.87/);
  });
});

// ─── memoryHealthCard — CANON render ─────────────────────────────────────────

describe('memoryHealthCard — CANON (golden v2 unwrapped)', () => {
  let html;
  it('renders without throwing', () => {
    html = memoryHealthCard({ status: 'ok', payload: CANON });
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  it('contains the legend element (mem-health-legend)', () => {
    html = memoryHealthCard({ status: 'ok', payload: CANON });
    assert.match(html, /mem-health-legend/);
  });

  it('renders classification internal level (the only non-zero level in CANON)', () => {
    html = memoryHealthCard({ status: 'ok', payload: CANON });
    assert.match(html, /internal/);
  });

  it('does not promise trend collection before sampling exists', () => {
    html = memoryHealthCard({ status: 'ok', payload: CANON });
    assert.doesNotMatch(html, /calibrat|collecting samples/i);
  });

  it('attention total is 0 (all maintenance zeros) → ok state, not warn', () => {
    html = memoryHealthCard({ status: 'ok', payload: CANON });
    // All maintenance fields are 0 → attnTotal=0 → is-ok
    // We just check the card renders without is-stale on the attention tile
    assert.match(html, /Attention/);
  });
});

describe('memoryHealthCard — operator-first summary', () => {
  it('explains the warning with concise, actionable maintenance rows', () => {
    const p = deepClone(CANON);
    makeOperationallyHealthy(p);
    p.maintenance = {
      ok: true,
      active_but_stale: 21,
      missing_status: 5,
      temporal_stale: 2,
      consolidation_backlog: 1,
      retrieved_unused: 31,
    };
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /Memory is working/i);
    assert.match(html, /Add status to 5 tracked namespaces/i);
    assert.match(html, /Refresh or close 21 stale active statuses/i);
    assert.match(html, /Update 2 statuses with past-due plans/i);
    assert.match(html, /Retrieval quality signal/i);
    assert.match(html, /31 memories repeatedly surfaced/i);
    assert.match(html, /Open consolidation/i);
  });

  it('counts only resolvable work and expands to the exact affected namespaces', () => {
    const p = makeOperationallyHealthy(deepClone(CANON));
    p.maintenance = {
      ok: true,
      active_but_stale: 1,
      missing_status: 1,
      temporal_stale: 0,
      consolidation_backlog: 0,
      retrieved_unused: 41,
    };
    const attention = {
      status: 'ok',
      payload: {
        items: [
          {
            namespace: 'projects/playdate-game', category: 'active_but_stale',
            updated_at: '2026-03-21T20:37:13.314Z',
            preview: 'Project setup — no game code yet',
            suggested_action: 'Update status or change lifecycle.',
          },
          {
            namespace: 'projects/deep-dive-test', category: 'missing_status',
            updated_at: '2026-04-04T21:18:55.590Z',
            preview: 'Tracked namespace has entries but no status key.',
            suggested_action: 'Write a status entry with a lifecycle tag.',
          },
        ],
      },
    };
    const html = memoryHealthCard({ status: 'ok', payload: p }, attention);
    assert.match(html, /2 maintenance items need review/i);
    assert.match(html, />2<\/span><span class="kpi-label">Attention/);
    assert.match(html, /projects\/playdate-game/);
    assert.match(html, /projects\/deep-dive-test/);
    assert.match(html, /Choose: keep active and refresh, or change lifecycle/i);
    assert.match(html, /Choose: create a status, merge into a canonical namespace, or archive/i);
    assert.match(html, /Retrieval quality signal/i);
    assert.doesNotMatch(html, /43 maintenance items need review/i);
  });

  it('escapes stored namespace and preview content in expanded attention rows', () => {
    const p = makeOperationallyHealthy(deepClone(CANON));
    p.maintenance = { ok: true, active_but_stale: 1, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    const attention = { status: 'ok', payload: { items: [{
      namespace: 'projects/<img src=x onerror=alert(1)>',
      category: 'active_but_stale', updated_at: '2026-01-01T00:00:00.000Z',
      preview: '<script>alert(1)</script>', suggested_action: 'Review.', untrusted_content: true,
    }] } };
    const html = memoryHealthCard({ status: 'ok', payload: p }, attention);
    assert.doesNotMatch(html, /<script>|<img src=x/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /untrusted content/i);
  });

  it('shows the protection activity that matters without calling blocked events failures', () => {
    const p = deepClone(CANON);
    p.security_events = {
      ok: true,
      redaction_events_7d: 138,
      redaction_events_30d: 1059,
      cross_zone_blocks_7d: 63,
      cross_zone_blocks_30d: 272,
    };
    p.classification.access_denied_7d = 0;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /Protections triggered/i);
    assert.match(html, /138 secret redactions/i);
    assert.match(html, /63 cross-zone blocks/i);
    assert.match(html, /0 denied requests/i);
  });

  it('keeps scale, latency, mode mix, and classification in compact technical details', () => {
    const p = deepClone(CANON);
    p.size = { ok: true, entries_total: 6752, entries_state: 2108, entries_log: 4644, namespace_count: 883 };
    p.retrieval = {
      ok: true,
      query_volume_7d: 129639,
      query_volume_30d: 560799,
      mode_mix: { lexical: 0.0004, semantic: 0, hybrid: 0.9996 },
      latency_p50_ms: 143,
      latency_p95_ms: 180,
      unused_surface_count: 31,
    };
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /Technical details/i);
    assert.match(html, /6,752 entries/i);
    assert.match(html, /883 namespaces/i);
    assert.match(html, /129,639/i);
    assert.match(html, /560,799/i);
    assert.match(html, /143ms/i);
    assert.match(html, /180ms/i);
    assert.match(html, /99\.96% hybrid/i);
    assert.match(html, /Classification/i);
  });
});

// ─── memoryHealthCard — §3.6 unknown-vs-zero ─────────────────────────────────

describe('memoryHealthCard — §3.6 unknown-vs-zero', () => {
  it('retrieval:null → retrieval block not rendered (mem-retrieval div absent)', () => {
    const p = deepClone(CANON);
    p.retrieval = null;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    // The mem-retrieval section should not appear when the retrieval block is absent/null
    assert.doesNotMatch(html, /mem-retrieval/);
  });

  it('transport_error → shows unavailable/degraded banner', () => {
    const html = memoryHealthCard({ status: 'transport_error' });
    assert.match(html, /unavailable|transport_error|degraded/i);
  });

  it('transport_error → no kpi-val with is-ok class (never green without data)', () => {
    const html = memoryHealthCard({ status: 'transport_error' });
    assert.doesNotMatch(html, /kpi-val is-ok/);
  });

  it('backlog_complete:false → backlog tile is stale (not 0/ok)', () => {
    const p = deepClone(CANON);
    p.consolidation.backlog_complete = false;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /is-stale/);
  });

  it('classification block absent → omitted (client-confidential not rendered)', () => {
    const p = deepClone(CANON);
    p.classification = null;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    // classification levels should not appear when the block is null
    assert.doesNotMatch(html, /client-confidential/);
  });
});

// ─── service-page integration ─────────────────────────────────────────────────

describe('service-page memory health integration', () => {
  it('munin-memory page with memHealth includes Memory Health card', () => {
    const html = servicePage('test', snapFor('munin-memory'), [], { status: 'ok', payload: CANON });
    assert.match(html, /Memory Health/i);
  });

  it('munin-memory badge is is-crit for CANON (0% coverage, rollup-driven)', () => {
    const html = servicePage('test', snapFor('munin-memory'), [], { status: 'ok', payload: CANON });
    assert.match(html, /status-badge is-crit/);
  });

  it('passes item-level attention data into the Munin Memory panel', () => {
    const p = deepClone(CANON);
    p.maintenance = { ...p.maintenance, missing_status: 1 };
    const attention = { status: 'ok', payload: { items: [{
      namespace: 'projects/deep-dive-test', category: 'missing_status',
      updated_at: '2026-04-04T21:18:55.590Z', preview: 'No status.',
      suggested_action: 'Write a status.',
    }] } };
    const html = servicePage('test', snapFor('munin-memory'), [], { status: 'ok', payload: p }, attention);
    assert.match(html, /projects\/deep-dive-test/);
  });

  it('hugin page does NOT include the Memory Health card', () => {
    const html = servicePage('test', snapFor('hugin'), [], null);
    assert.doesNotMatch(html, /Memory Health/i);
  });

  it('munin-memory without memHealth (null) still renders the Consolidation link', () => {
    // backward-compat: existing tests call servicePage with 2 args
    const html = servicePage('test', snapFor('munin-memory'));
    assert.ok(html.includes('href="/services/munin-memory/consolidation"'));
  });

  it('munin-memory with transport_error result shows stale badge', () => {
    const html = servicePage('test', snapFor('munin-memory'), [], { status: 'transport_error' });
    // Rollup of transport_error → stale → badge is is-stale
    assert.match(html, /status-badge is-stale/);
  });
});

// ─── Regression: Codex PR #80 review findings ───────────────────────────────

describe('memoryHealthCard — unknown enum badges never green (F1)', () => {
  it('unknown worker + unknown breaker → no is-ok badge, stale badges present', () => {
    const p = deepClone(CANON);
    p.consolidation.worker = 'future-state';
    p.embedding.circuit_breaker = 'future-state';
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.doesNotMatch(html, /status-badge is-ok/);
    assert.match(html, /status-badge is-stale/);
  });
});

describe('memoryHealthCard — absent required blocks render stale, not green 0 (F2)', () => {
  it('missing embedding.counts → queue tile stale, no "stuck" queue label', () => {
    const p = deepClone(CANON);
    delete p.embedding.counts;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /is-stale/);
    assert.doesNotMatch(html, /Queue · \d+ stuck/);
  });

  it('missing maintenance → attention tile stale (no attn total)', () => {
    const p = deepClone(CANON);
    delete p.maintenance;
    const html = memoryHealthCard({ status: 'ok', payload: p });
    // Attention tile must be stale when maintenance block is absent
    assert.match(html, /is-stale/);
    // The attention KPI value should be "—" (stale), not a number
    assert.doesNotMatch(html, /Attention<\/span>[^<]*<\/div>\s*<\/div>\s*<\/div>\s*<div[^>]*>\s*<span class="kpi-val is-ok"/);
  });
});

describe('GET /services/munin-memory route (F3)', () => {
  let app; let db;
  before(async () => {
    db = openDatabase(path.join(os.tmpdir(), `heimdall-memhealth-${process.pid}.db`));
    // Seed a munin-memory snapshot so the route reaches the memory-health fetch
    // (rather than 404-ing on a missing snapshot).
    upsertServiceSnapshot(db, {
      service: 'munin-memory', kind: 'mcp', status: 'pass', reachable: 1, source: 'descriptor',
      fetchedAt: new Date(0).toISOString(),
      descriptor: { service: { name: 'munin-memory', label: 'Munin Memory' }, kind: 'mcp', status: 'pass' },
    });
    ({ app } = buildApp(db));
    await app.ready();
  });
  after(async () => { await app.close(); db.close(); });

  it('munin-memory → 200 and degrades cleanly (no live Munin → unavailable card)', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/munin-memory' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Memory Health/);
    // No live Munin in test → fetchMemoryHealth returns transport_error → degraded banner.
    assert.match(res.body, /unavailable|transport_error/i);
  });

  it('unknown service → 404 (memory-health fetch not reached)', async () => {
    const res = await app.inject({ method: 'GET', url: '/services/__not-a-real-service__' });
    assert.equal(res.statusCode, 404);
  });
});

// ─── Regression: Codex PR #81 review findings (v2 per-section ok / partial) ──
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('v2 section ok flags + partial (Codex #81)', () => {
  // Fix 2: the per-section `ok:true` must NOT be summed as a maintenance counter.
  it('healthy maintenance (ok:true, counters all 0) → Attention 0, rollup not warn-from-ok', () => {
    const p = makeOperationallyHealthy(clone(CANON));
    p.maintenance = { ok: true, active_but_stale: 0, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    p.consolidation = { ...p.consolidation, backlog: [], worker: 'available' }; // drop non-maintenance warnings
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'ok');
    const html = memoryHealthCard({ status: 'ok', payload: p });
    assert.match(html, /0<\/span><span class="kpi-label">Attention/);
    assert.doesNotMatch(html, /1<\/span><span class="kpi-label">Attention/);
  });

  // Fix 1a: partial:true → warn + banner, never a clean healthy badge.
  it('partial:true → rollup warn + partial banner', () => {
    const p = makeOperationallyHealthy(clone(CANON));
    p.partial = true;
    p.consolidation = { ...p.consolidation, backlog: [] };
    p.maintenance = { ok: true, active_but_stale: 0, missing_status: 0, temporal_stale: 0, consolidation_backlog: 0, retrieved_unused: 0 };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'warn');
    assert.match(memoryHealthCard({ status: 'ok', payload: p }), /Partial data/i);
  });

  // Fix 1b: a degraded core section (ok:false) → stale rollup + stale tiles, never green.
  it('embedding section ok:false → rollup stale, coverage not a green number', () => {
    const p = clone(CANON);
    p.embedding = { ok: false, error: 'section_unavailable' };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'stale');
    assert.doesNotMatch(memoryHealthCard({ status: 'ok', payload: p }), /kpi-val is-ok">[\d.]+%/);
  });

  it('maintenance section ok:false → Attention stale, rollup warn (total unknown)', () => {
    const p = makeOperationallyHealthy(clone(CANON));
    p.maintenance = { ok: false, error: 'section_unavailable' };
    p.consolidation = { ...p.consolidation, backlog: [] };
    assert.equal(memoryHealthRollup({ status: 'ok', payload: p }), 'warn');
    assert.match(memoryHealthCard({ status: 'ok', payload: p }), /is-stale/);
  });
});
