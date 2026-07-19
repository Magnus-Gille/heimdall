'use strict';

/**
 * insights.js — Claude Code usage-insights data layer.
 *
 * Exports:
 *   fetchInsightsRecords({ apiKey }) — async, reads meta/insights-history from Munin
 *   deriveMetrics(record)           — pure, derives per-record metric primitives
 *   computeSis(record)              — pure, Self-Improvement Score 0–100
 *   nextLever(record)               — pure, dominant friction category + directive
 *   buildObjective(records)         — pure, agent-facing objective object
 *   buildTrend(records)             — pure, trend array for chart API
 */

const { muninRpc: muninRpcShared } = require('./munin-rpc');
const { loadApiKey } = require('./munin-projects');

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// --------------------------------------------------------------------------
// Pure metric definitions
// --------------------------------------------------------------------------

/**
 * Derive per-record metric primitives from a raw insights record.
 * All count maps may have missing keys — treated as 0.
 *
 * Returns:
 *   n, achieved, outcomeQuality, frictionTotal, frictionPressure,
 *   satTotal, satisfactionQuality, firstPassCorrectness,
 *   intentAlignment, toolingFrictionRate
 */
function deriveMetrics(record) {
  if (!record) record = {};

  const n = record.facets_analyzed || 0;
  const outcomes  = record.outcomes  || {};
  const friction  = record.friction  || {};
  const satisfaction = record.satisfaction || {};

  // Outcomes — EXCLUDE unclear_from_transcript
  const fully  = outcomes.fully_achieved     || 0;
  const mostly = outcomes.mostly_achieved    || 0;
  const not    = outcomes.not_achieved       || 0;
  const achieved = fully + mostly + not;
  const outcomeQuality = achieved > 0
    ? (1.0 * fully + 0.5 * mostly + 0 * not) / achieved
    : null;

  // Friction
  const buggy_code           = friction.buggy_code            || 0;
  const wrong_approach       = friction.wrong_approach        || 0;
  const misunderstood_request= friction.misunderstood_request || 0;
  const tooling_friction     = friction.tooling_friction      || 0;
  const infrastructure_failure = friction.infrastructure_failure || 0;
  const user_rejected_action = friction.user_rejected_action  || 0;
  const frictionTotal = buggy_code + wrong_approach + misunderstood_request
    + tooling_friction + infrastructure_failure + user_rejected_action;
  const frictionPressure = n > 0 ? Math.min(1, frictionTotal / n) : 0;

  // Satisfaction
  const happy            = satisfaction.happy            || 0;
  const satisfied        = satisfaction.satisfied        || 0;
  const likely_satisfied = satisfaction.likely_satisfied || 0;
  const dissatisfied     = satisfaction.dissatisfied     || 0;
  const satTotal = happy + satisfied + likely_satisfied + dissatisfied;
  const satisfactionQuality = satTotal > 0
    ? (1.0 * happy + 0.8 * satisfied + 0.6 * likely_satisfied + 0 * dissatisfied) / satTotal
    : null;

  // Derived rates
  const firstPassCorrectness = n > 0
    ? clamp01(1 - buggy_code / n)
    : null;
  const intentAlignment = n > 0
    ? clamp01(1 - (misunderstood_request + wrong_approach + user_rejected_action) / n)
    : null;
  const toolingFrictionRate = n > 0
    ? clamp01((tooling_friction + infrastructure_failure) / n)
    : 0;

  return {
    n,
    achieved,
    outcomeQuality,
    frictionTotal,
    frictionPressure,
    satTotal,
    satisfactionQuality,
    firstPassCorrectness,
    intentAlignment,
    toolingFrictionRate,
  };
}

/**
 * Self-Improvement Score, 0–100.
 *
 * Weights: 0.45 outcome quality, 0.35 (1-friction pressure), 0.20 satisfaction quality.
 * If outcomeQuality or satisfactionQuality is null, weights are renormalized over
 * available components so the result is always 0–100.
 */
function computeSis(record) {
  const m = deriveMetrics(record);
  if (m.n === 0) return null;

  const components = [];
  if (m.outcomeQuality !== null) {
    components.push({ weight: 0.45, value: m.outcomeQuality });
  }
  // frictionPressure always has a value (defaults to 0)
  components.push({ weight: 0.35, value: 1 - m.frictionPressure });
  if (m.satisfactionQuality !== null) {
    components.push({ weight: 0.20, value: m.satisfactionQuality });
  }

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;

  const raw = components.reduce((s, c) => s + (c.weight / totalWeight) * c.value, 0);
  return round1(raw * 100);
}

/**
 * Canonical tie-break order for friction categories.
 */
const FRICTION_ORDER = [
  'buggy_code',
  'wrong_approach',
  'misunderstood_request',
  'user_rejected_action',
  'tooling_friction',
  'infrastructure_failure',
];

const LEVER_MAP = {
  buggy_code: {
    metric: 'first_pass_correctness',
    directive: 'Prioritize first-pass correctness: add or extend tests before implementing, and run them before reporting done.',
  },
  wrong_approach: {
    metric: 'intent_alignment',
    directive: 'Confirm the approach and target before building — sketch the plan and check assumptions first.',
  },
  misunderstood_request: {
    metric: 'intent_alignment',
    directive: 'Restate the request and confirm scope/repo before acting.',
  },
  user_rejected_action: {
    metric: 'intent_alignment',
    directive: 'Seek explicit confirmation before outward-facing or irreversible actions.',
  },
  tooling_friction: {
    metric: 'tooling_friction_rate',
    directive: 'Environment friction dominated — harden tooling/setup rather than changing coding behavior.',
  },
  infrastructure_failure: {
    metric: 'tooling_friction_rate',
    directive: 'Environment friction dominated — harden tooling/setup rather than changing coding behavior.',
  },
};

/**
 * Pick the dominant friction category and return a corrective directive.
 * Tie-break: canonical FRICTION_ORDER (first listed wins on equal count).
 *
 * Returns { category, metric, directive, share_of_friction }
 */
function nextLever(record) {
  if (!record) record = {};
  const friction = record.friction || {};

  const frictionTotal = FRICTION_ORDER.reduce((s, k) => s + (friction[k] || 0), 0);

  if (frictionTotal === 0) {
    return {
      category: 'none',
      metric: null,
      directive: 'No material friction recorded — maintain current approach.',
      share_of_friction: 0,
    };
  }

  let maxCategory = null;
  let maxCount = -1;
  for (const k of FRICTION_ORDER) {
    const count = friction[k] || 0;
    if (count > maxCount) {
      maxCount = count;
      maxCategory = k;
    }
  }

  const lever = LEVER_MAP[maxCategory];
  return {
    category: maxCategory,
    metric: lever.metric,
    directive: lever.directive,
    share_of_friction: maxCount / frictionTotal,
  };
}

/**
 * Build the agent-facing objective object from an array of records.
 * Uses the last record for latest state, penultimate for delta.
 */
function buildObjective(records) {
  if (!records || records.length === 0) {
    return { data_points: 0, note: 'No insights data yet.' };
  }

  const last = records[records.length - 1];
  const m = deriveMetrics(last);
  const sisLast = computeSis(last);
  const sisPrev = records.length > 1 ? computeSis(records[records.length - 2]) : null;
  const delta = (sisLast != null && sisPrev != null) ? round1(sisLast - sisPrev) : null;

  return {
    as_of: last.date,
    self_improvement_score: sisLast,
    delta_vs_prev: delta,
    components: {
      outcome_quality:        m.outcomeQuality        !== null ? round3(m.outcomeQuality)        : null,
      first_pass_correctness: m.firstPassCorrectness  !== null ? round3(m.firstPassCorrectness)  : null,
      intent_alignment:       m.intentAlignment       !== null ? round3(m.intentAlignment)        : null,
      satisfaction_quality:   m.satisfactionQuality   !== null ? round3(m.satisfactionQuality)    : null,
      friction_pressure:      round3(m.frictionPressure),
    },
    next_lever: nextLever(last),
    data_points: records.length,
    source: 'claude-code /insights',
    note: 'Maximize self_improvement_score; act on next_lever.directive.',
  };
}

/**
 * Build the trend array (one entry per record, ascending by date).
 */
function buildTrend(records) {
  if (!records) return [];
  return records.map(record => {
    const m = deriveMetrics(record);
    return {
      date:                   record.date,
      sis:                    computeSis(record),
      outcome_quality:        m.outcomeQuality,
      first_pass_correctness: m.firstPassCorrectness,
      intent_alignment:       m.intentAlignment,
      satisfaction_quality:   m.satisfactionQuality,
      friction_pressure:      m.frictionPressure,
      outcomes:               record.outcomes    || {},
      friction:               record.friction    || {},
      satisfaction:           record.satisfaction || {},
      helpfulness:            record.helpfulness || {},
      headline:               record.headline    || {},
    };
  });
}

// --------------------------------------------------------------------------
// Data fetching (async, never throws — Heimdall pages degrade gracefully)
// --------------------------------------------------------------------------

/**
 * Fetch all insights records from Munin namespace `meta/insights-history`.
 * Returns records sorted ascending by date, or [] on any failure.
 *
 * @param {{ apiKey?: string }} opts
 */
async function fetchInsightsRecords({ apiKey } = {}) {
  const key = apiKey || loadApiKey();
  if (!key) return [];

  try {
    // 1. Enumerate entries
    const queryResult = await muninRpcShared(
      'memory_query',
      { namespace: 'meta/insights-history', limit: 52 },
      { apiKey: key, timeoutMs: 10000 },
    );
    if (!queryResult) return [];

    const queryText = queryResult.content?.[0]?.text;
    if (!queryText) return [];

    let parsed;
    try {
      parsed = JSON.parse(queryText);
    } catch {
      return [];
    }
    const results = parsed.results || parsed.entries || [];
    if (!Array.isArray(results) || results.length === 0) return [];

    // 2. Fetch full content for each entry (memory_query gives truncated preview)
    const records = [];
    for (const item of results) {
      const id = item.id;
      if (!id) continue;

      const getResult = await muninRpcShared(
        'memory_get',
        { id },
        { apiKey: key, timeoutMs: 8000 },
      );
      if (!getResult) continue;

      const getText = getResult.content?.[0]?.text;
      if (!getText) continue;

      let getData;
      try {
        getData = JSON.parse(getText);
      } catch {
        continue;
      }
      if (getData.found === false) continue;

      const content = getData.content || '';
      if (!content || typeof content !== 'string') continue;

      // 3. Parse content: try pure JSON, then fenced ```json … ``` block
      let rec = null;
      try {
        rec = JSON.parse(content.trim());
      } catch {
        const fenceMatch = content.match(/```json\s*([\s\S]*?)```/);
        if (fenceMatch) {
          try {
            rec = JSON.parse(fenceMatch[1].trim());
          } catch { /* skip */ }
        }
      }

      if (rec && rec.date) records.push(rec);
    }

    // Sort ascending by date string (ISO dates sort correctly as strings)
    records.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    return records;
  } catch {
    return [];
  }
}

module.exports = {
  fetchInsightsRecords,
  deriveMetrics,
  computeSis,
  nextLever,
  buildObjective,
  buildTrend,
};
