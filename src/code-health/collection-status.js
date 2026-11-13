'use strict';

// Bounded vocabularies for objective collection state. These are the only
// values persisted or exposed for a collection cycle or a rejected run; raw
// error messages and producer-controlled text never leave the collector.

// Stage-based rejection reasons: which collector step refused the candidate.
const REJECTION_REASONS = Object.freeze([
  'transport-provenance-invalid',
  'artifact-download-failed',
  'artifact-size-mismatch',
  'artifact-parse-rejected',
  'admission-rejected',
]);

// One collector-level status per source per cycle, by this precedence.
const CYCLE_STATUS_PRECEDENCE = Object.freeze([
  'unavailable',
  'rejected',
  'incomplete',
  'committed',
  'current',
  'no-artifacts',
]);

module.exports = { REJECTION_REASONS, CYCLE_STATUS_PRECEDENCE };
