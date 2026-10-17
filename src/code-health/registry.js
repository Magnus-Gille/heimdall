'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const CONTRACT_ROOT = path.join(ROOT, 'contract');
const REGISTRY_ROOT = path.join(ROOT, 'registries');
const CONTRACT_PROVENANCE_SHA256 = '0175eda1b69f9392978d7263fc0c4b5dc3d2482baf0c5fab4edbee060dfa931a';
const REGISTRY_PROVENANCE_SHA256 = '1514034eea923bbe1ffdeceeaabe74c5d3685f045f8f236ddef5c244d1d56a55';
const REPOSITORIES = Object.freeze([
  Object.freeze({ owner: 'Magnus-Gille', name: 'gille-inference', workflowPath: '.github/workflows/code-health.yml' }),
  Object.freeze({ owner: 'Magnus-Gille', name: 'sagascript', workflowPath: '.github/workflows/code-health.yml' }),
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyFiles(root, provenance, expectedManifestSha256) {
  const manifestBytes = fs.readFileSync(path.join(root, 'provenance.json'));
  if (sha256(manifestBytes) !== expectedManifestSha256) throw new Error('code-health provenance manifest hash mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  for (const item of provenance) {
    const bytes = fs.readFileSync(path.join(root, item.path));
    if (sha256(bytes) !== item.sha256) throw new Error(`code-health source hash mismatch: ${item.path}`);
  }
  return manifest;
}

function assertUniqueSlots(slots, repository) {
  const slotRefs = new Set();
  for (const slot of slots) {
    if (!slot || typeof slot.slot_ref !== 'string' || typeof slot.metric !== 'string'
      || !['complex_functions', 'unused_candidates', 'coverage', 'ci_first_attempt', 'confirmed_regressions'].includes(slot.metric)
      || slotRefs.has(slot.slot_ref)) {
      throw new Error(`invalid or duplicate expected slot in ${repository.owner}/${repository.name}`);
    }
    slotRefs.add(slot.slot_ref);
  }
  if (!slots.length) throw new Error(`empty expected slot registry in ${repository.owner}/${repository.name}`);
}

function loadExpectedSlots() {
  const contractManifest = readJson(path.join(CONTRACT_ROOT, 'provenance.json'));
  verifyFiles(CONTRACT_ROOT, contractManifest.files, CONTRACT_PROVENANCE_SHA256);

  const registryManifest = readJson(path.join(REGISTRY_ROOT, 'provenance.json'));
  const sourceFiles = registryManifest.sources.map((source) => ({ path: source.local_path, sha256: source.sha256 }));
  const registryManifestBytes = fs.readFileSync(path.join(REGISTRY_ROOT, 'provenance.json'));
  if (sha256(registryManifestBytes) !== REGISTRY_PROVENANCE_SHA256) throw new Error('producer registry provenance hash mismatch');
  for (const source of registryManifest.sources) {
    if (!source.repository || !/^[a-f0-9]{40}$/.test(source.revision)
      || !/^[a-f0-9]{40}$/.test(source.source_git_blob)
      || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('producer registry provenance is malformed');
    const bytes = fs.readFileSync(path.join(ROOT, source.local_path));
    if (sha256(bytes) !== source.sha256) throw new Error(`producer registry hash mismatch: ${source.local_path}`);
  }
  if (sourceFiles.length !== REPOSITORIES.length) throw new Error('producer registry source inventory is incomplete');

  const gille = readJson(path.join(REGISTRY_ROOT, 'gille-inference/slots.json'));
  if (gille.repository?.owner !== 'Magnus-Gille' || gille.repository?.name !== 'gille-inference' || gille.contract_version !== '1.0') {
    throw new Error('gille-inference slot registry identity is invalid');
  }
  const gilleSlots = gille.slots.map((slot) => ({
    slot_ref: slot.slot_ref,
    metric: slot.metric,
    language: slot.language,
    platform: slot.platform,
    feature_refs: [],
    scope_version: slot.scope_version,
    metric_version: null,
    freshness_ms: slot.freshness_hours != null ? slot.freshness_hours * 60 * 60 * 1000 : slot.freshness_days * 24 * 60 * 60 * 1000,
  }));
  assertUniqueSlots(gilleSlots, REPOSITORIES[0]);

  const saga = readJson(path.join(REGISTRY_ROOT, 'sagascript/code-health-producer-v1.json'));
  if (saga.repository?.owner !== 'Magnus-Gille' || saga.repository?.name !== 'sagascript' || saga.contract_version !== '1.0'
    || !Array.isArray(saga.scopes)) throw new Error('sagascript producer registry identity is invalid');
  const sagaSlots = [];
  for (const scope of saga.scopes) {
    if (!scope || typeof scope.name !== 'string' || !scope.slots || typeof scope.slots !== 'object' || Array.isArray(scope.slots)) {
      throw new Error('sagascript scope registry is malformed');
    }
    for (const [metric, slot] of Object.entries(scope.slots)) {
      sagaSlots.push({
        slot_ref: slot.slot_ref,
        metric,
        scope: scope.name,
        language: slot.language,
        platform: slot.platform,
        feature_refs: slot.feature_refs,
        scope_version: slot.scope_version,
        metric_version: slot.metric_version,
        freshness_ms: slot.freshness_hours != null ? slot.freshness_hours * 60 * 60 * 1000 : slot.freshness_days * 24 * 60 * 60 * 1000,
      });
    }
  }
  assertUniqueSlots(sagaSlots, REPOSITORIES[1]);

  const byRepository = new Map([
    ['gille-inference', { source: REPOSITORIES[0], slots: gilleSlots }],
    ['sagascript', { source: REPOSITORIES[1], slots: sagaSlots }],
  ]);
  for (const value of byRepository.values()) {
    value.slots = value.slots.map((slot) => Object.freeze({ ...slot, feature_refs: Object.freeze([...(slot.feature_refs ?? [])]) }));
    value.byRef = new Map(value.slots.map((slot) => [slot.slot_ref, slot]));
    Object.freeze(value.slots);
    Object.freeze(value);
  }
  return byRepository;
}

const EXPECTED_SLOTS = loadExpectedSlots();

function sourceForRepository(owner, name) {
  if (owner !== 'Magnus-Gille') return null;
  return EXPECTED_SLOTS.get(name)?.source ?? null;
}

module.exports = { REPOSITORIES, EXPECTED_SLOTS, sourceForRepository, CONTRACT_ROOT };
