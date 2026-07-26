'use strict';

// Public monitoring-agent capability contract. This deliberately describes
// transport/observation only: Brokkr remains authoritative for node topology,
// workload assignment, and lifecycle decisions.
const CONTRACT_VERSION = 1;
const SUPPORTED_CAPABILITIES = Object.freeze([
  'lifecycle-result',
  'node-capability-freshness',
]);
const EVIDENCE_FIELDS = Object.freeze({
  'node-capability-freshness': ['observed_at', 'status'],
  'lifecycle-result': ['observed_at', 'result'],
});

const CAPABILITY_CONTRACT = Object.freeze({
  version: CONTRACT_VERSION,
  supported: SUPPORTED_CAPABILITIES,
  authority: 'observation_only',
  diagnostic: 'Heimdall records monitoring observations; it is not topology or workload authority.',
});

function validateCapabilityContract(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['capability_contract must be an object'] };
  if (raw.version !== CONTRACT_VERSION) return { ok: false, errors: [`capability_contract.version must be ${CONTRACT_VERSION}`] };

  for (const field of ['required', 'optional']) {
    if (raw[field] != null && (!Array.isArray(raw[field]) || raw[field].some((v) => typeof v !== 'string'))) {
      return { ok: false, errors: [`capability_contract.${field} must be an array of strings`] };
    }
  }
  if (raw.evidence != null && (typeof raw.evidence !== 'object' || Array.isArray(raw.evidence))) {
    return { ok: false, errors: ['capability_contract.evidence must be an object'] };
  }

  const evidence = {};
  if (raw.evidence) {
    for (const [capability, observation] of Object.entries(raw.evidence)) {
      if (!Object.hasOwn(EVIDENCE_FIELDS, capability)) {
        return { ok: false, errors: [`capability_contract.evidence.${capability} is not a supported observation`] };
      }
      if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
        return { ok: false, errors: [`capability_contract.evidence.${capability} must be an object`] };
      }
      const allowed = EVIDENCE_FIELDS[capability];
      for (const key of Object.keys(observation)) {
        if (!allowed.includes(key)) return { ok: false, errors: [`capability_contract.evidence.${capability}.${key} is not allowed`] };
      }
      const normalized = {};
      for (const key of allowed) {
        if (observation[key] == null) continue;
        if (typeof observation[key] !== 'string' || observation[key].length > 64) {
          return { ok: false, errors: [`capability_contract.evidence.${capability}.${key} must be a string ≤64 chars`] };
        }
        normalized[key] = observation[key];
      }
      evidence[capability] = normalized;
    }
  }

  const required = [...new Set(raw.required || [])].sort();
  const optional = [...new Set(raw.optional || [])].sort();
  const unsupportedRequired = required.filter((capability) => !SUPPORTED_CAPABILITIES.includes(capability));
  const accepted = [...new Set([...required, ...optional])].filter((capability) => SUPPORTED_CAPABILITIES.includes(capability)).sort();
  return { ok: true, value: { required, optional, accepted, unsupportedRequired, evidence: Object.keys(evidence).length ? evidence : null } };
}

function negotiationResponse(negotiation) {
  return {
    ...CAPABILITY_CONTRACT,
    accepted: negotiation ? negotiation.accepted : [],
    unsupported_required: negotiation ? negotiation.unsupportedRequired : [],
  };
}

module.exports = { CONTRACT_VERSION, SUPPORTED_CAPABILITIES, CAPABILITY_CONTRACT, validateCapabilityContract, negotiationResponse };
