'use strict';

// A collection cycle is useful only when it is a new, complete observation of
// the required sources. Keep this contract pure so the collector and its
// regression tests use exactly the same fail-closed rules.
const COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = COLLECTION_INTERVAL_MS;
const DEFAULT_MAX_DURATION_MS = COLLECTION_INTERVAL_MS;

// Local and NAS are the two sources that make a Heimdall collection cycle
// meaningful. Service-specific integrations are intentionally optional: their
// own health is recorded by the collector, but an unavailable optional service
// must not make host telemetry look like a successful full cycle.
const REQUIRED_REMOTE_PROBE_FIELDS = Object.freeze(['mem_used_pct', 'load_1m', 'uptime']);
const REMOTE_PROBE_SECTION_CONTRACT = Object.freeze([
  {
    name: 'thermal-zones',
    expected: 'one or more thermal-zone type<TAB>temperature lines',
    validate: (section) => /^\S+\s+-?\d+(?:\.\d+)?(?:\s*\n\s*\S+\s+-?\d+(?:\.\d+)?)*\s*$/.test(section),
  },
  {
    name: 'memory',
    expected: 'MemTotal and MemAvailable entries in kB',
    validate: (section) => /(?:^|\n)MemTotal:\s+\d+\s+kB/.test(section)
      && /(?:^|\n)MemAvailable:\s+\d+\s+kB/.test(section),
  },
  {
    name: 'filesystems',
    expected: 'df header and at least one /dev filesystem row',
    validate: (section) => /(?:^|\n)Filesystem\s/.test(section)
      && /(?:^|\n)\/dev\/\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+\S+/.test(section),
  },
  {
    name: 'load-average',
    expected: 'three numeric /proc/loadavg values',
    validate: (section) => /^\s*\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?(?:\s|$)/.test(section),
  },
  {
    name: 'uptime',
    expected: 'numeric uptime and idle seconds',
    validate: (section) => /^\s*\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*$/.test(section),
  },
  {
    name: 'time-machine-mtime',
    expected: 'numeric epoch timestamp',
    validate: (section) => /^\s*\d+(?:\.\d+)?\s*$/.test(section),
  },
  {
    name: 'time-machine-size',
    expected: 'numeric byte count and path',
    validate: (section) => /^\s*\d+\s+\S+\s*$/.test(section),
  },
  {
    name: 'munin-backup-latest',
    expected: 'latest backup filename',
    validate: (section) => /^\s*\S.*\S\s*$/.test(section),
  },
  {
    name: 'munin-backup-count',
    expected: 'numeric backup count',
    validate: (section) => /^\s*\d+\s*$/.test(section),
  },
  {
    name: 'mimir-backup-last',
    expected: 'latest backup log line',
    validate: (section) => /^\s*\S.*\S\s*$/.test(section),
  },
  {
    name: 'mimir-sync-latest',
    expected: 'numeric epoch timestamp',
    validate: (section) => /^\s*\d+(?:\.\d+)?\s*$/.test(section),
  },
  {
    name: 'cpu-frequency',
    expected: 'numeric CPU frequency in kHz',
    validate: (section) => /^\s*\d+(?:\.\d+)?\s*$/.test(section),
  },
  {
    name: 'throttle',
    expected: 'vcgencmd throttled=0x... output',
    validate: (section) => /^\s*throttled=0x[0-9a-f]+\s*$/i.test(section),
  },
  {
    name: 'under-voltage',
    expected: 'numeric under-voltage flag',
    validate: (section) => /^\s*[01]\s*$/.test(section),
  },
  {
    name: 'network',
    expected: '/proc/net/dev header and interface counters',
    validate: (section) => /Inter-\|Receive/.test(section)
      && /\S+:\s+\d+(?:\s+\d+){7,}/.test(section),
  },
  {
    name: 'sd-block-stats',
    expected: 'at least seven numeric block-device counters',
    validate: (section) => /^\s*(?:\d+\s+){6,}\d+\s*$/.test(section),
  },
  {
    name: 'nas-block-stats',
    expected: 'at least seven numeric block-device counters',
    validate: (section) => /^\s*(?:\d+\s+){6,}\d+\s*$/.test(section),
  },
  {
    name: 'cpu-ticks',
    expected: 'cpu line with numeric tick counters',
    validate: (section) => /^\s*cpu\s+(?:\d+\s+){4,}\d+\s*$/.test(section),
  },
  {
    name: 'cpu-cores',
    expected: 'positive CPU core count',
    validate: (section) => /^\s*[1-9]\d*\s*$/.test(section),
  },
]);
const REMOTE_PROBE_SECTION_COUNT = REMOTE_PROBE_SECTION_CONTRACT.length;
const REMOTE_PROBE_SECTIONS = Object.freeze(REMOTE_PROBE_SECTION_CONTRACT.map((section) => section.name));

// This is the required-probe inventory. Collection code records the expected
// contract, observed timestamp, and deadline for every entry; the validator
// never has to infer mandatory sources from whichever metrics happened to be
// written by a partial cycle.
const COLLECTOR_PROBE_CONTRACT = Object.freeze([
  {
    name: 'local',
    required: true,
    expected: Object.freeze(['mem_used_pct', 'load_1m', 'uptime']),
    deadlineMs: DEFAULT_MAX_DURATION_MS,
  },
  {
    name: 'nas',
    required: true,
    expected: Object.freeze([...REQUIRED_REMOTE_PROBE_FIELDS]),
    expectedSections: REMOTE_PROBE_SECTIONS,
    deadlineMs: DEFAULT_MAX_DURATION_MS,
  },
]);
const REQUIRED_COLLECTOR_PROBES = Object.freeze(
  COLLECTOR_PROBE_CONTRACT.filter((contract) => contract.required !== false).map((contract) => contract.name)
);
const VALID_STATUSES = new Set([
  'success', 'failure', 'missing', 'frozen', 'malformed', 'partial', 'stale', 'late',
]);

function asTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cycleField(evidence, ...names) {
  for (const name of names) {
    if (evidence && evidence[name] !== undefined) return evidence[name];
  }
  return undefined;
}

function probeField(probe, ...names) {
  for (const name of names) {
    if (probe && probe[name] !== undefined) return probe[name];
  }
  return undefined;
}

function listRequired(options) {
  const configured = options.requiredProbeNames || options.requiredProbes
    || (Array.isArray(options.probeContract)
      ? options.probeContract.filter((p) => p && p.required !== false).map((p) => p.name)
      : REQUIRED_COLLECTOR_PROBES);
  if (!Array.isArray(configured)) return null;
  return [...new Set(configured)];
}

function previousProbe(previousProbes, name) {
  if (!previousProbes) return null;
  if (previousProbes instanceof Map) return previousProbes.get(name) || null;
  if (Array.isArray(previousProbes)) return previousProbes.find((p) => p?.name === name) || null;
  if (typeof previousProbes === 'object') return previousProbes[name] || null;
  return null;
}

function probeContract(contracts, name) {
  if (!Array.isArray(contracts)) return null;
  return contracts.find((contract) => contract && contract.name === name) || null;
}

/**
 * Validate one collector cycle. A successful result requires every required
 * probe to be present, explicitly successful, complete, and fresh. The
 * optional `previousProbes` map lets callers reject evidence that reuses the
 * previous cycle's observation timestamp (a frozen recovery).
 *
 * `reasons` deliberately contains all observed failures, not just the first;
 * this keeps the persisted collector error useful when more than one source is
 * unavailable.
 */
function validateCollectorCycle(evidence, options = {}) {
  const reasons = [];
  const required = listRequired(options);
  const now = asTimestamp(options.now === undefined ? Date.now() : options.now);
  const maxAgeMs = options.maxAgeMs ?? options.freshnessWindowMs ?? DEFAULT_MAX_AGE_MS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  if (!required || required.length === 0
    || required.some((name) => typeof name !== 'string' || name.trim() === '')) {
    reasons.push('collector cycle required probes are malformed');
  }
  if (!Number.isFinite(now)) reasons.push('collector cycle clock is malformed');
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) reasons.push('collector cycle freshness window is malformed');
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) reasons.push('collector cycle duration window is malformed');

  const startedAt = asTimestamp(cycleField(evidence, 'startedAt', 'cycleStart', 'start'));
  const completedAt = asTimestamp(cycleField(evidence, 'completedAt', 'cycleEnd', 'end'));
  if (startedAt == null) reasons.push('collector cycle start timestamp is malformed');
  if (completedAt == null) reasons.push('collector cycle completion timestamp is malformed');
  if (startedAt != null && completedAt != null && now != null) {
    if (completedAt < startedAt) reasons.push('collector cycle timestamps are out of order');
    if (startedAt > now || completedAt > now) reasons.push('collector cycle timestamp is in the future');
    if (now - startedAt > maxAgeMs) reasons.push('collector cycle is late: start evidence is stale');
    if (completedAt - startedAt > maxDurationMs) reasons.push('collector cycle is late: duration exceeded the allowed window');
  }

  const probes = cycleField(evidence, 'probes', 'probeEvidence');
  if (!Array.isArray(probes)) {
    reasons.push('collector cycle probes are malformed');
    return { valid: false, success: false, ok: false, reasons };
  }

  const byName = new Map();
  for (const probe of probes) {
    const name = probeField(probe, 'name', 'probe');
    if (typeof name !== 'string' || name.trim() === '') {
      reasons.push('collector cycle contains a probe with no name');
      continue;
    }
    if (byName.has(name)) {
      reasons.push(`probe "${name}" is duplicated`);
      continue;
    }
    byName.set(name, probe);
  }

  for (const name of required || []) {
    const probe = byName.get(name);
    if (!probe) {
      reasons.push(`required probe "${name}" missing`);
      continue;
    }

    const contract = probeContract(options.probeContract, name);
    if (options.probeContract && !contract) {
      reasons.push(`required probe "${name}" has no contract`);
    } else if (contract) {
      if (!Array.isArray(contract.expected) || contract.expected.length === 0) {
        reasons.push(`required probe "${name}" contract is malformed`);
      }
      if (!Array.isArray(probe.expected)
        || JSON.stringify(probe.expected) !== JSON.stringify(contract.expected)) {
        reasons.push(`probe "${name}" expected evidence is incomplete`);
      }
      if (contract.expectedSections
        && (!Array.isArray(probe.expectedSections)
          || JSON.stringify(probe.expectedSections) !== JSON.stringify(contract.expectedSections))) {
        reasons.push(`probe "${name}" expected sections are incomplete`);
      }
      const deadlineAt = asTimestamp(probe.deadlineAt);
      if (deadlineAt == null) reasons.push(`probe "${name}" deadline is malformed`);
      else if (now != null && deadlineAt < now) reasons.push(`probe "${name}" deadline expired`);
    }

    const status = probeField(probe, 'status', 'state');
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      reasons.push(`probe "${name}" is malformed`);
    } else if (status !== 'success') {
      reasons.push(`probe "${name}" is ${status}`);
    }

    if (probe.complete === false || probe.partial === true) {
      reasons.push(`probe "${name}" is partial`);
    }
    if (probe.fresh === false || probe.stale === true) {
      reasons.push(`probe "${name}" is stale`);
    }
    if (probe.late === true) reasons.push(`probe "${name}" is late`);

    const observedAt = asTimestamp(probeField(probe, 'observedAt', 'observed_at', 'timestamp', 'collectedAt'));
    if (observedAt == null) {
      reasons.push(`probe "${name}" timestamp is malformed`);
      continue;
    }
    if (now != null && observedAt > now) reasons.push(`probe "${name}" timestamp is in the future`);
    if (startedAt != null && observedAt < startedAt) reasons.push(`probe "${name}" evidence predates the cycle`);
    if (now != null && now - observedAt > maxAgeMs) reasons.push(`probe "${name}" evidence is stale`);

    const previous = previousProbe(options.previousProbes, name);
    const previousObservedAt = previous && asTimestamp(probeField(previous, 'observedAt', 'observed_at', 'timestamp', 'collectedAt'));
    if (previousObservedAt != null && observedAt <= previousObservedAt) {
      reasons.push(`probe "${name}" evidence is frozen`);
    }
    if (previous?.fingerprint && probe.fingerprint && previous.fingerprint === probe.fingerprint) {
      reasons.push(`probe "${name}" evidence is frozen`);
    }
  }

  const valid = reasons.length === 0;
  return { valid, success: valid, ok: valid, reasons };
}

/**
 * Classify a structured probe payload before it is persisted. Required fields
 * are deliberately explicit because many optional metrics legitimately have a
 * null value on hosts without that hardware.
 */
function classifyProbePayload(payload, requiredFields, observedAt) {
  const timestamp = asTimestamp(observedAt);
  if (timestamp == null) return { status: 'malformed', observedAt: null };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'malformed', observedAt: timestamp };
  }
  const missing = [];
  const malformed = [];
  for (const field of requiredFields || []) {
    const entry = payload[field];
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    if (value == null) missing.push(field);
    else if (typeof value !== 'number' || !Number.isFinite(value)) malformed.push(field);
  }
  if (malformed.length > 0) return { status: 'malformed', observedAt: timestamp, malformed };
  if (missing.length > 0) {
    return { status: 'partial', observedAt: timestamp, missing };
  }
  const fingerprint = JSON.stringify((requiredFields || []).map((field) => {
    const entry = payload[field];
    return entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  }));
  return { status: 'success', observedAt: timestamp, fingerprint };
}

function classifyRemoteProbePayload(rawOutput, payload, observedAt) {
  const evidence = classifyProbePayload(payload, REQUIRED_REMOTE_PROBE_FIELDS, observedAt);
  const sectionCount = typeof rawOutput === 'string' ? rawOutput.split('---\n').length : 0;
  if (sectionCount !== REMOTE_PROBE_SECTION_COUNT) {
    const structuralStatus = sectionCount > 1 ? 'partial' : 'malformed';
    if (evidence.status === 'success' || structuralStatus === 'malformed') {
      evidence.status = structuralStatus;
    }
    evidence.missing = [`remote sections (${sectionCount}/${REMOTE_PROBE_SECTION_COUNT})`];
  } else {
    const sections = rawOutput.split('---\n');
    const missing = sections.reduce((result, section, index) => {
      if (section.trim() === '') result.push(`section ${index} (${REMOTE_PROBE_SECTIONS[index]})`);
      return result;
    }, []);
    const malformed = sections.reduce((result, section, index) => {
      const contract = REMOTE_PROBE_SECTION_CONTRACT[index];
      if (contract && section.trim() !== '' && !contract.validate(section)) {
        result.push(`section ${index} (${contract.name}): expected ${contract.expected}`);
      }
      return result;
    }, []);
    if (missing.length > 0) {
      evidence.status = 'partial';
      evidence.missing = missing;
    } else if (malformed.length > 0) {
      evidence.status = 'malformed';
      evidence.malformed = malformed;
    }
  }
  return evidence;
}

module.exports = {
  COLLECTION_INTERVAL_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_DURATION_MS,
  REQUIRED_COLLECTOR_PROBES,
  COLLECTOR_PROBE_CONTRACT,
  REMOTE_PROBE_SECTION_CONTRACT,
  REMOTE_PROBE_SECTIONS,
  REQUIRED_REMOTE_PROBE_FIELDS,
  REMOTE_PROBE_SECTION_COUNT,
  asTimestamp,
  classifyProbePayload,
  classifyRemoteProbePayload,
  validateCollectorCycle,
};
