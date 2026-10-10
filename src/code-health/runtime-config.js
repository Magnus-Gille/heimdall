'use strict';

const fs = require('node:fs');
const { REPOSITORIES } = require('./registry');
const { validateSourceConfig, DEFAULT_SUBJECTIVE_SOURCE_CONFIG } = require('./munin-export');

const MAX_CONFIG_BYTES = 16 * 1024;
const RUBRIC_VERSION = 'changeability-1.0';
const CONFIG_KEYS = new Set(['sources']);
const SOURCE_KEYS = new Set(['repoOwner', 'repoName', 'namespace', 'producerPrincipalId']);

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

function readBoundedConfigFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 4096) {
    throw new Error('invalid-source-configuration');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('invalid-source-configuration');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('invalid-source-configuration');
    return JSON.parse(bytes.toString('utf8', 0, length));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateConfigData(value) {
  if (!exactKeys(value, CONFIG_KEYS) || !Array.isArray(value.sources)
    || value.sources.length > REPOSITORIES.length) {
    throw new Error('invalid-source-configuration');
  }
  const seen = new Set();
  const sources = value.sources.map((source) => {
    if (!exactKeys(source, SOURCE_KEYS)) throw new Error('invalid-source-configuration');
    const key = `${source.repoOwner}/${source.repoName}`;
    if (seen.has(key)) throw new Error('invalid-source-configuration');
    seen.add(key);
    const pinned = REPOSITORIES.find((item) => item.owner === source.repoOwner && item.name === source.repoName);
    if (!pinned) throw new Error('invalid-source-configuration');
    const normalized = {
      enabled: true,
      namespace: source.namespace,
      producerPrincipalId: source.producerPrincipalId,
      repoOwner: source.repoOwner,
      repoName: source.repoName,
      rubricVersion: RUBRIC_VERSION,
    };
    try { validateSourceConfig(normalized); } catch { throw new Error('invalid-source-configuration'); }
    return Object.freeze(normalized);
  });
  return Object.freeze(sources);
}

function loadCodeHealthRuntimeConfig({ env = process.env, readConfig = readBoundedConfigFile } = {}) {
  const gateEnabled = env.HEIMDALL_CODE_HEALTH === 'on';
  const configPath = env.HEIMDALL_CODE_HEALTH_CONFIG;
  let sources = Object.freeze([]);
  let configValid = false;
  if (typeof configPath === 'string' && configPath.length > 0) {
    try {
      sources = validateConfigData(readConfig(configPath));
      configValid = true;
    } catch {
      // Keep validation details and the private path out of logs and responses.
    }
  }
  const status = gateEnabled ? (configValid ? 'enabled' : 'rejected') : 'disabled';
  const byRepository = new Map(sources.map((source) => [source.repoName, source]));
  const enabled = gateEnabled && configValid;
  return Object.freeze({
    gateEnabled,
    enabled,
    valid: configValid,
    status,
    objectiveEnabled: enabled,
    objectiveConfigured: configValid,
    sources,
    subjectiveConfigForRepo(repoName) {
      const source = byRepository.get(repoName);
      if (!source) {
        // An enabled but invalid config is surfaced as rejected by the reader.
        return gateEnabled && !configValid ? { enabled: true } : DEFAULT_SUBJECTIVE_SOURCE_CONFIG;
      }
      return { ...source, enabled };
    },
  });
}

module.exports = {
  MAX_CONFIG_BYTES,
  RUBRIC_VERSION,
  readBoundedConfigFile,
  validateConfigData,
  loadCodeHealthRuntimeConfig,
};
