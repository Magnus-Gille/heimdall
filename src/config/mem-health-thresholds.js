'use strict';

/**
 * mem-health-thresholds.js — Named threshold constants for the Memory Health panel.
 *
 * These are the RUNTIME source of truth (§3.1, §3.3 of docs/memory-health-spec.md).
 * docs/metrics.md is the human-readable mirror — keep them in sync when changing values here.
 * Never import docs/metrics.md; import this module.
 */

// ─── Embedding ───────────────────────────────────────────────────────────────

/** Coverage % at or below which the tile turns warn (low-bad direction). */
const EMBEDDING_COVERAGE_WARN_PCT = 99;

/** Coverage % at or below which the tile turns crit (low-bad direction). */
const EMBEDDING_COVERAGE_CRIT_PCT = 95;

// ─── Consolidation failures ───────────────────────────────────────────────────

// Note: failure thresholds are relative to `max_failures` (a producer field),
// so there is no fixed constant here — callers compare against payload.consolidation.max_failures.

// ─── Last synthesis age ───────────────────────────────────────────────────────

/** Age of last_synthesis_at (ms) above which the tile turns warn. */
const LAST_SYNTHESIS_AGE_WARN_MS = 24 * 60 * 60 * 1000;   // 24 hours

/** Age of last_synthesis_at (ms) above which the tile turns crit. */
const LAST_SYNTHESIS_AGE_CRIT_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

module.exports = {
  EMBEDDING_COVERAGE_WARN_PCT,
  EMBEDDING_COVERAGE_CRIT_PCT,
  LAST_SYNTHESIS_AGE_WARN_MS,
  LAST_SYNTHESIS_AGE_CRIT_MS,
};
