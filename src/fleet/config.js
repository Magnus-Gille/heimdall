'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalHost, loadHostAliases, normalizeHostKey } = require('../host-identity');

const REPOSITORY_CONFIG_PATH = path.join(__dirname, '..', '..', 'heimdall.config.json');
const CONFIG_PATH = process.env.HEIMDALL_CONFIG_PATH || REPOSITORY_CONFIG_PATH;

const DEFAULT_THRESHOLDS = { staleAfterS: 90, offlineAfterS: 600, sleepAfterS: 1800 };

/** Candidate locations for Grimnir's canonical services/node registry. */
function grimnirCandidates() {
  const out = [];
  if (process.env.GRIMNIR_SERVICES_JSON) out.push(process.env.GRIMNIR_SERVICES_JSON);
  out.push('/opt/grimnir/services.json');
  out.push(path.join(__dirname, '..', '..', '..', 'grimnir', 'services.json'));
  return out;
}

function readOverlay(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** First readable Grimnir candidate wins; invalid content fails closed. */
function loadGrimnirNodeRegistry(candidates = grimnirCandidates()) {
  for (const candidate of candidates) {
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }

    let registry;
    try {
      registry = JSON.parse(text);
    } catch {
      return { status: 'malformed', registry: null, path: candidate };
    }
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return { status: 'malformed', registry: null, path: candidate };
    }
    if (!Array.isArray(registry.nodes)) {
      return { status: 'nodes-missing', registry: null, path: candidate };
    }
    const invalid = registry.nodes.some((node) => !node || typeof node !== 'object'
      || typeof node.name !== 'string' || normalizeHostKey(node.name) === '');
    if (invalid) return { status: 'malformed', registry: null, path: candidate };
    return { status: 'loaded', registry, path: candidate };
  }
  return { status: 'unavailable', registry: null, path: null };
}

function addRegistryAlias(aliases, alias, canonical) {
  const key = normalizeHostKey(alias);
  if (typeof key !== 'string' || key === '' || key === canonical) return;
  // Preserve the first registry declaration if two nodes claim one alias. The
  // registry validator owns that data-quality error; Heimdall stays stable.
  if (!Object.hasOwn(aliases, key)) aliases[key] = canonical;
}

/** Deterministically project active Grimnir nodes into Heimdall's fleet model. */
function deriveFleetProjection(registry, overlay = {}, historyAliases = {}) {
  const hosts = [];
  const aliases = {};
  const canonicalNames = new Set();
  const canonicalByNodeId = new Map();

  for (const node of registry.nodes) {
    if (node.status !== 'active') continue;
    const canonical = normalizeHostKey(node.name);
    if (canonicalNames.has(canonical)) continue;
    canonicalNames.add(canonical);
    if (typeof node.node_id === 'string' && node.node_id) {
      canonicalByNodeId.set(node.node_id, canonical);
    }
    hosts.push({
      hostname: canonical,
      label: node.name,
      role: typeof node.role === 'string' && node.role ? node.role : null,
      // Grimnir's `monitor` flag is alert policy, not an observation. Missing
      // or false is deliberately informational and cannot turn Overview red.
      always_on: node.monitor === true,
    });
    for (const alias of [node.hostname, node.ssh_alias, node.node_id]) {
      if (typeof alias === 'string') addRegistryAlias(aliases, alias, canonical);
    }
  }

  // Heimdall's local collector writes its app-local host id (`control-node` by
  // default). Resolve that reporter name through Grimnir's authoritative
  // Heimdall workload placement instead of hard-coding the physical node.
  const heimdall = Array.isArray(registry.components)
    ? registry.components.find((component) => component && component.name === 'heimdall')
    : null;
  const localTarget = heimdall && canonicalByNodeId.get(heimdall.target_node_id);
  if (localTarget) {
    addRegistryAlias(
      aliases,
      process.env.HEIMDALL_LOCAL_HOST_ID || 'control-node',
      localTarget,
    );
  }

  // Heimdall may know reporter/history names that Grimnir does not model (for
  // example `orin-nano`). They are identity reconciliation only: accept them
  // when their target resolves to a registry node, and never let them remap a
  // registry canonical name away from itself.
  const overlayAliases = { ...historyAliases, ...loadHostAliases(overlay) };
  for (const [alias, target] of Object.entries(overlayAliases)) {
    const key = normalizeHostKey(alias);
    const resolved = canonicalHost(target, aliases);
    if (!canonicalNames.has(resolved)) continue;
    if (key === resolved) continue;
    if (canonicalNames.has(key) && key !== resolved) continue;
    aliases[key] = resolved;
  }

  return { hosts, hostAliases: aliases };
}

/**
 * Load fleet membership from Grimnir's canonical node registry. Heimdall's
 * overlay owns only thresholds and extra reporter/history aliases; a duplicated
 * `fleet.hosts` array is ignored even if an older private config still has one.
 */
function loadFleetConfig(configPath = CONFIG_PATH, options = {}) {
  const overlay = readOverlay(configPath);
  const aliasDefaultsPath = options.aliasDefaultsPath || REPOSITORY_CONFIG_PATH;
  const historyAliases = configPath === aliasDefaultsPath
    ? {}
    : loadHostAliases(readOverlay(aliasDefaultsPath));
  const fleet = overlay.fleet && typeof overlay.fleet === 'object' && !Array.isArray(overlay.fleet)
    ? overlay.fleet
    : {};
  const thresholds = {
    staleAfterS: numOr(fleet.stale_after_s, DEFAULT_THRESHOLDS.staleAfterS),
    offlineAfterS: numOr(fleet.offline_after_s, DEFAULT_THRESHOLDS.offlineAfterS),
    sleepAfterS: numOr(fleet.sleep_after_s, DEFAULT_THRESHOLDS.sleepAfterS),
  };
  const candidates = options.grimnirPath ? [options.grimnirPath] : undefined;
  const loaded = loadGrimnirNodeRegistry(candidates);
  if (loaded.status !== 'loaded') {
    return emptyConfig(loaded.status, thresholds, loaded.path);
  }

  const projection = deriveFleetProjection(loaded.registry, overlay, historyAliases);
  return {
    ...projection,
    thresholds,
    authority: {
      status: 'loaded',
      source: 'grimnir',
      path: loaded.path,
      intentionallyEmpty: projection.hosts.length === 0,
    },
  };
}

function emptyConfig(status, thresholds = DEFAULT_THRESHOLDS, registryPath = null) {
  return {
    hosts: [],
    hostAliases: {},
    thresholds: { ...thresholds },
    authority: { status, source: 'grimnir', path: registryPath, intentionallyEmpty: false },
  };
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = {
  loadFleetConfig,
  deriveFleetProjection,
  loadGrimnirNodeRegistry,
  grimnirCandidates,
  DEFAULT_THRESHOLDS,
  CONFIG_PATH,
  REPOSITORY_CONFIG_PATH,
};
