'use strict';

/**
 * insight-thresholds.js — Named threshold constants for the /insights KPI row.
 *
 * These are the RUNTIME source of truth for insight status bands (issue #6:
 * every user-facing status must carry explicit threshold provenance instead of
 * card-local magic numbers). docs/metrics.md is the human-readable mirror —
 * keep them in sync when changing values here. Never import docs/metrics.md;
 * import this module.
 *
 * Ownership: these bands are owned by this file (and reviewed with it); the
 * renderer must not embed its own comparisons.
 *
 * All insight metrics are high-good: value >= ok is 'ok', value >= warn is
 * 'warn', below warn is 'crit'. A missing value is 'stale' — unknown or
 * calibrating is NEVER rendered as good.
 */

// ─── Self-Improvement Score (0–100, from computeSis) ─────────────────────────
const SIS_OK_MIN = 75;
const SIS_WARN_MIN = 55;

// ─── Outcome success (0–1 fraction, from deriveMetrics().outcomeQuality) ─────
const OUTCOME_QUALITY_OK_MIN = 0.80;
const OUTCOME_QUALITY_WARN_MIN = 0.60;

// ─── First-pass correctness (0–1 fraction, deriveMetrics().firstPassCorrectness)
const FIRST_PASS_OK_MIN = 0.70;
const FIRST_PASS_WARN_MIN = 0.50;

/**
 * Classify a high-good metric against a band. Returns 'ok' | 'warn' | 'crit',
 * or 'stale' when the value is null/undefined/not a finite number (unknown or
 * calibrating — deliberately distinct from 'ok').
 */
function bandStatus(value, { okMin, warnMin }) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return 'stale';
  if (n >= okMin) return 'ok';
  if (n >= warnMin) return 'warn';
  return 'crit';
}

/**
 * Human-readable provenance string for a band, used as the KPI tooltip so the
 * UI explains what is good, degraded, or bad. `fmt` renders a bound for
 * display (e.g. fractions as percentages).
 */
function bandTitle({ okMin, warnMin }, fmt = (v) => String(v)) {
  return `good ≥ ${fmt(okMin)} · degraded ≥ ${fmt(warnMin)} · bad < ${fmt(warnMin)} · missing data shows as stale`;
}

const SIS_BAND = { okMin: SIS_OK_MIN, warnMin: SIS_WARN_MIN };
const OUTCOME_QUALITY_BAND = { okMin: OUTCOME_QUALITY_OK_MIN, warnMin: OUTCOME_QUALITY_WARN_MIN };
const FIRST_PASS_BAND = { okMin: FIRST_PASS_OK_MIN, warnMin: FIRST_PASS_WARN_MIN };

module.exports = {
  SIS_OK_MIN,
  SIS_WARN_MIN,
  OUTCOME_QUALITY_OK_MIN,
  OUTCOME_QUALITY_WARN_MIN,
  FIRST_PASS_OK_MIN,
  FIRST_PASS_WARN_MIN,
  SIS_BAND,
  OUTCOME_QUALITY_BAND,
  FIRST_PASS_BAND,
  bandStatus,
  bandTitle,
};
