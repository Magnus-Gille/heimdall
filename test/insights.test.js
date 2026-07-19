'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { deriveMetrics, computeSis, nextLever, buildObjective, buildTrend } = require('../src/insights');
const { insightsPage } = require('../src/render/insights');
const { buildApp } = require('../src/server');
const { openDatabase } = require('../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-insights-'));
  return openDatabase(path.join(dir, 'test.db'));
}

// A realistic record matching real data (58 sessions)
const REALISTIC_RECORD = {
  date: '2026-06-21',
  facets_analyzed: 58,
  headline: { total_sessions: 58, analyzed: 58, messages: 1200, hours: 40, commits: 32 },
  outcomes: { fully_achieved: 40, mostly_achieved: 11, not_achieved: 1, unclear_from_transcript: 6 },
  friction: { buggy_code: 25, wrong_approach: 5, misunderstood_request: 3, tooling_friction: 2, infrastructure_failure: 1, user_rejected_action: 1 },
  satisfaction: { happy: 30, satisfied: 15, likely_satisfied: 7, dissatisfied: 0 },
  helpfulness: { essential: 25, very_helpful: 20, moderately_helpful: 10 },
};

const HIGH_QUALITY_RECORD = {
  date: '2026-06-28',
  facets_analyzed: 20,
  headline: { commits: 12 },
  outcomes: { fully_achieved: 18, mostly_achieved: 2, not_achieved: 0, unclear_from_transcript: 0 },
  friction: { buggy_code: 1, wrong_approach: 0, misunderstood_request: 0, tooling_friction: 0, infrastructure_failure: 0, user_rejected_action: 0 },
  satisfaction: { happy: 16, satisfied: 4, likely_satisfied: 0, dissatisfied: 0 },
  helpfulness: {},
};

const BUGGY_RECORD = {
  date: '2026-06-14',
  facets_analyzed: 20,
  headline: {},
  outcomes: { fully_achieved: 5, mostly_achieved: 5, not_achieved: 10, unclear_from_transcript: 0 },
  friction: { buggy_code: 15, wrong_approach: 2, misunderstood_request: 1, tooling_friction: 0, infrastructure_failure: 0, user_rejected_action: 0 },
  satisfaction: { happy: 3, satisfied: 7, likely_satisfied: 5, dissatisfied: 5 },
  helpfulness: {},
};

describe('Pure metric tests', () => {
  describe('deriveMetrics', () => {
    it('computes n from facets_analyzed', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      assert.equal(m.n, 58);
    });

    it('achieved excludes unclear_from_transcript', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      // 40 + 11 + 1 = 52 (not 58 which includes unclear=6)
      assert.equal(m.achieved, 52);
    });

    it('outcomeQuality weights fully=1, mostly=0.5, not=0', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      // (1*40 + 0.5*11 + 0*1) / 52 = 45.5/52 = 0.875
      assert.ok(m.outcomeQuality !== null);
      assert.ok(Math.abs(m.outcomeQuality - 0.875) < 0.001, `outcomeQuality=${m.outcomeQuality}`);
    });

    it('frictionTotal sums all friction categories', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      // 25+5+3+2+1+1 = 37
      assert.equal(m.frictionTotal, 37);
    });

    it('frictionPressure is min(1, frictionTotal/n)', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      assert.ok(Math.abs(m.frictionPressure - 37 / 58) < 0.001);
    });

    it('satisfactionQuality weights happy=1, satisfied=0.8, likely=0.6, dissatisfied=0', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      // (30+0.8*15+0.6*7+0)/52 = (30+12+4.2)/52 = 46.2/52
      assert.ok(m.satisfactionQuality !== null);
      assert.ok(Math.abs(m.satisfactionQuality - 46.2 / 52) < 0.001, `satQ=${m.satisfactionQuality}`);
    });

    it('firstPassCorrectness = clamp01(1 - buggy_code/n)', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      assert.ok(Math.abs(m.firstPassCorrectness - (1 - 25 / 58)) < 0.001);
    });

    it('clamps firstPassCorrectness to 0 when buggy_code > n', () => {
      const rec = { ...REALISTIC_RECORD, facets_analyzed: 10, friction: { buggy_code: 20 } };
      const m = deriveMetrics(rec);
      assert.equal(m.firstPassCorrectness, 0);
    });

    it('intentAlignment = clamp01(1 - (misunderstood+wrong+rejected)/n)', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      // (3+5+1)/58 = 9/58
      const expected = 1 - 9 / 58;
      assert.ok(Math.abs(m.intentAlignment - expected) < 0.001);
    });

    it('toolingFrictionRate = (tooling_friction+infrastructure_failure)/n', () => {
      const m = deriveMetrics(REALISTIC_RECORD);
      assert.ok(Math.abs(m.toolingFrictionRate - 3 / 58) < 0.001);
    });

    it('outcomeQuality is null when no outcomes', () => {
      const rec = { date: '2026-01-01', facets_analyzed: 10, outcomes: {}, friction: {}, satisfaction: {}, helpfulness: {} };
      const m = deriveMetrics(rec);
      assert.equal(m.outcomeQuality, null);
    });

    it('satisfactionQuality is null when no satisfaction data', () => {
      const rec = { date: '2026-01-01', facets_analyzed: 10, outcomes: {}, friction: {}, satisfaction: {}, helpfulness: {} };
      const m = deriveMetrics(rec);
      assert.equal(m.satisfactionQuality, null);
    });

    it('handles missing fields gracefully (all zero)', () => {
      const rec = { date: '2026-01-01' };
      const m = deriveMetrics(rec);
      assert.equal(m.n, 0);
      assert.equal(m.frictionPressure, 0);
    });
  });

  describe('computeSis', () => {
    it('returns a number between 0 and 100', () => {
      const sis = computeSis(REALISTIC_RECORD);
      assert.ok(sis >= 0 && sis <= 100, `SIS=${sis} out of range`);
    });

    it('realistic record SIS is exactly 69.8', () => {
      const sis = computeSis(REALISTIC_RECORD);
      assert.ok(Math.abs(sis - 69.8) < 0.05, `SIS=${sis} expected 69.8`);
    });

    it('high-quality record produces higher SIS than buggy record', () => {
      const sisHigh = computeSis(HIGH_QUALITY_RECORD);
      const sisBuggy = computeSis(BUGGY_RECORD);
      assert.ok(sisHigh > sisBuggy, `high=${sisHigh} should > buggy=${sisBuggy}`);
    });

    it('renormalizes weights when satisfactionQuality is null (SIS still 0–100)', () => {
      const rec = {
        date: '2026-01-01',
        facets_analyzed: 10,
        outcomes: { fully_achieved: 8, mostly_achieved: 1, not_achieved: 1 },
        friction: { buggy_code: 2 },
        satisfaction: {}, // satTotal=0 → satisfactionQuality=null
        helpfulness: {},
      };
      const sis = computeSis(rec);
      assert.ok(sis >= 0 && sis <= 100, `SIS=${sis} out of range after renorm`);
      // outcomeQuality=(8+0.5)/10=0.85, frictionPressure=0.2, satQ=null
      // renorm: weights 0.45+0.35=0.80 → renorm_oq=0.45/0.8, renorm_fp=0.35/0.8
      // SIS = (0.5625*0.85 + 0.4375*0.8)*100 = (0.478125+0.35)*100 = 82.8125 → 82.8
      assert.ok(Math.abs(sis - 82.8) < 0.2, `SIS=${sis} expected ~82.8`);
    });

    it('returns null when n=0 (no data to score)', () => {
      const rec = { date: '2026-01-01', facets_analyzed: 0, outcomes: {}, friction: {}, satisfaction: {}, helpfulness: {} };
      const sis = computeSis(rec);
      assert.equal(sis, null);
    });

    it('returns null when called with bare {facets_analyzed:0}', () => {
      assert.equal(computeSis({ facets_analyzed: 0 }), null);
    });

    it('double-null renorm: only friction present → SIS=50', () => {
      // outcomeQuality=null (no outcomes), satisfactionQuality=null (no satisfaction)
      // frictionPressure = 5/10 = 0.5 → (1-fp)=0.5, only component (weight 0.35 renorm'd to 1)
      // raw = 0.5 → SIS = 50
      const sis = computeSis({ facets_analyzed: 10, friction: { buggy_code: 5 } });
      assert.equal(sis, 50);
    });

    it('rounds to 1 decimal place', () => {
      const sis = computeSis(REALISTIC_RECORD);
      // Check it's a 1-decimal number (or integer)
      assert.equal(Math.round(sis * 10), sis * 10);
    });
  });

  describe('nextLever', () => {
    it('returns buggy_code lever when buggy_code dominates', () => {
      const lever = nextLever(REALISTIC_RECORD);
      assert.equal(lever.category, 'buggy_code');
      assert.equal(lever.metric, 'first_pass_correctness');
    });

    it('directive for buggy_code mentions tests', () => {
      const lever = nextLever(REALISTIC_RECORD);
      assert.match(lever.directive, /test/i);
    });

    it('share_of_friction is correct', () => {
      const lever = nextLever(REALISTIC_RECORD);
      // buggy_code=25, frictionTotal=37
      assert.ok(Math.abs(lever.share_of_friction - 25 / 37) < 0.001);
    });

    it('returns first_pass_correctness metric for buggy_code category', () => {
      const lever = nextLever(BUGGY_RECORD);
      assert.equal(lever.category, 'buggy_code');
      assert.equal(lever.metric, 'first_pass_correctness');
    });

    it('returns intent_alignment metric for wrong_approach lever', () => {
      const rec = {
        date: '2026-01-01',
        facets_analyzed: 10,
        outcomes: {},
        friction: { wrong_approach: 5, buggy_code: 3 },
        satisfaction: {},
        helpfulness: {},
      };
      const lever = nextLever(rec);
      assert.equal(lever.category, 'wrong_approach');
      assert.equal(lever.metric, 'intent_alignment');
    });

    it('returns none when no friction', () => {
      const rec = { date: '2026-01-01', facets_analyzed: 10, outcomes: {}, friction: {}, satisfaction: {}, helpfulness: {} };
      const lever = nextLever(rec);
      assert.equal(lever.category, 'none');
      assert.equal(lever.share_of_friction, 0);
    });

    it('tie-breaks in canonical order (buggy_code > wrong_approach)', () => {
      const rec = {
        date: '2026-01-01',
        facets_analyzed: 10,
        outcomes: {},
        friction: { buggy_code: 5, wrong_approach: 5 },
        satisfaction: {},
        helpfulness: {},
      };
      const lever = nextLever(rec);
      assert.equal(lever.category, 'buggy_code');
    });

    it('tooling_friction maps to tooling_friction_rate metric', () => {
      const rec = {
        date: '2026-01-01',
        facets_analyzed: 10,
        outcomes: {},
        friction: { tooling_friction: 8 },
        satisfaction: {},
        helpfulness: {},
      };
      const lever = nextLever(rec);
      assert.equal(lever.metric, 'tooling_friction_rate');
    });
  });

  describe('buildObjective', () => {
    it('returns empty shape when no records', () => {
      const obj = buildObjective([]);
      assert.equal(obj.data_points, 0);
      assert.match(obj.note, /No insights/i);
    });

    it('returns null for no records (alternate check)', () => {
      const obj = buildObjective(null);
      assert.equal(obj.data_points, 0);
    });

    it('populates as_of, sis, and next_lever from last record', () => {
      const obj = buildObjective([REALISTIC_RECORD]);
      assert.equal(obj.as_of, '2026-06-21');
      assert.ok(obj.self_improvement_score >= 0 && obj.self_improvement_score <= 100);
      assert.ok(obj.next_lever);
      assert.ok(obj.next_lever.directive);
    });

    it('delta_vs_prev is null with single record', () => {
      const obj = buildObjective([REALISTIC_RECORD]);
      assert.equal(obj.delta_vs_prev, null);
    });

    it('delta_vs_prev is null when prev record has n=0 (null SIS)', () => {
      const obj = buildObjective([{ date: '2026-01-01', facets_analyzed: 0 }, REALISTIC_RECORD]);
      assert.equal(obj.delta_vs_prev, null);
    });

    it('delta_vs_prev computed when 2+ records', () => {
      const obj = buildObjective([BUGGY_RECORD, REALISTIC_RECORD]);
      assert.notEqual(obj.delta_vs_prev, null);
      const expectedDelta = Math.round((computeSis(REALISTIC_RECORD) - computeSis(BUGGY_RECORD)) * 10) / 10;
      assert.ok(Math.abs(obj.delta_vs_prev - expectedDelta) < 0.05);
    });

    it('components include outcome_quality, first_pass_correctness etc', () => {
      const obj = buildObjective([REALISTIC_RECORD]);
      assert.ok('outcome_quality' in obj.components);
      assert.ok('first_pass_correctness' in obj.components);
      assert.ok('intent_alignment' in obj.components);
      assert.ok('satisfaction_quality' in obj.components);
      assert.ok('friction_pressure' in obj.components);
    });

    it('data_points matches records length', () => {
      const obj = buildObjective([BUGGY_RECORD, REALISTIC_RECORD]);
      assert.equal(obj.data_points, 2);
    });

    it('source is claude-code /insights', () => {
      const obj = buildObjective([REALISTIC_RECORD]);
      assert.equal(obj.source, 'claude-code /insights');
    });
  });

  describe('buildTrend', () => {
    it('returns array of one item per record', () => {
      const trend = buildTrend([BUGGY_RECORD, REALISTIC_RECORD]);
      assert.equal(trend.length, 2);
    });

    it('each item has date and sis', () => {
      const trend = buildTrend([REALISTIC_RECORD]);
      assert.equal(trend[0].date, '2026-06-21');
      assert.ok(trend[0].sis >= 0 && trend[0].sis <= 100);
    });

    it('each item includes outcome/friction/satisfaction/helpfulness', () => {
      const trend = buildTrend([REALISTIC_RECORD]);
      assert.ok(typeof trend[0].outcomes === 'object');
      assert.ok(typeof trend[0].friction === 'object');
      assert.ok(typeof trend[0].satisfaction === 'object');
      assert.ok(typeof trend[0].helpfulness === 'object');
    });

    it('returns empty array for empty input', () => {
      assert.deepEqual(buildTrend([]), []);
      assert.deepEqual(buildTrend(null), []);
    });
  });
});

describe('insightsPage renderer', () => {
  it('renders inside the v2 shell with the Insights nav active', () => {
    const html = insightsPage('v', {});
    assert.match(html, /class="nav"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /href="\/insights".*aria-current="page"|aria-current="page".*href="\/insights"/s);
  });

  it('includes the insights.css link', () => {
    const html = insightsPage('v', {});
    assert.match(html, /\/css\/insights\.css/);
  });

  it('includes Chart.js script tags (charts: true)', () => {
    const html = insightsPage('v', {});
    assert.match(html, /chart\.umd\.min\.js/);
  });

  it('renders Self-Improvement Score heading', () => {
    const html = insightsPage('v', {});
    assert.match(html, /Self-Improvement/);
  });

  it('renders Insights page title', () => {
    const html = insightsPage('v', {});
    assert.match(html, /Insights/);
  });

  it('renders agent objective card with machine endpoint text', () => {
    const html = insightsPage('v', { objective: { self_improvement_score: 70, next_lever: { directive: 'test directive' }, data_points: 1, as_of: '2026-06-28' }, trend: [REALISTIC_RECORD] });
    assert.match(html, /\/api\/insights\/objective/);
  });

  it('renders emptyState when trend has fewer than 2 entries', () => {
    const html = insightsPage('v', { trend: [REALISTIC_RECORD], objective: buildObjective([REALISTIC_RECORD]) });
    assert.match(html, /one data point|Trend builds/i);
  });

  it('renders chart canvases when trend has 2+ entries', () => {
    const html = insightsPage('v', { trend: [BUGGY_RECORD, REALISTIC_RECORD], objective: buildObjective([BUGGY_RECORD, REALISTIC_RECORD]) });
    assert.match(html, /insights-sis-chart/);
  });

  it('renders — (dash) not "null" in KPI row when latest record has n=0', () => {
    const zeroRecord = { date: '2026-01-01', facets_analyzed: 0 };
    const html = insightsPage('v', { records: [zeroRecord], objective: buildObjective([zeroRecord]) });
    assert.ok(!html.includes('>null<'), 'literal "null" must not appear in KPI row');
    assert.match(html, /—/);
  });

  it('renders — (dash) in objective card when SIS is null', () => {
    const zeroRecord = { date: '2026-01-01', facets_analyzed: 0 };
    const objective = buildObjective([zeroRecord]);
    // buildObjective returns a full object even for n=0 records (data_points=1, sis=null)
    // so renderObjectiveCard should not crash and should show — not "null"
    const html = insightsPage('v', { records: [zeroRecord], objective });
    assert.ok(!html.includes('>null<'), 'literal "null" must not appear in objective card');
  });
});

describe('GET /insights routes', () => {
  let app;
  let db;

  before(async () => {
    db = freshDb();
    ({ app } = buildApp(db));
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('serves /insights (200, text/html, contains Self-Improvement and Insights)', async () => {
    const res = await app.inject({ method: 'GET', url: '/insights' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.match(res.body, /Self-Improvement/);
    assert.match(res.body, /Insights/);
  });

  it('/api/insights/objective returns empty-Munin shape when Munin unreachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/insights/objective' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Munin not reachable in tests → must return the canonical empty shape
    assert.equal(body.data_points, 0);
    assert.equal(typeof body.note, 'string');
    assert.ok(!('self_improvement_score' in body), 'self_improvement_score must not be present in empty shape');
  });

  it('/api/insights/trend returns 200 with a JSON array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/insights/trend' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  it('serves /css/insights.css (200, text/css)', async () => {
    const res = await app.inject({ method: 'GET', url: '/css/insights.css' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('css'));
  });
});
