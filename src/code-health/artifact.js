'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const path = require('node:path');
const { EXPECTED_SLOTS, sourceForRepository } = require('./registry');
const { loadContract } = require('./contract');

const LIMITS = Object.freeze({
  archiveBytes: 25 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  totalExpandedBytes: 25 * 1024 * 1024,
  entries: 500,
  jsonBytes: 8 * 1024 * 1024,
  pathLength: 240,
});
const MANIFEST_KEYS = Object.freeze(['contract_version', 'repo_owner', 'repo_name', 'commit_sha', 'snapshots', 'evidence_index']);
const PRODUCER_AUXILIARY_FILES = Object.freeze({
  'gille-inference': Object.freeze([
    'evidence/ci/inventory.json',
    'evidence/complexity/summary.json',
    'evidence/coverage/run.json',
    'evidence/overhead.json',
    'evidence/producer-status.json',
    'workflow-run.json',
  ]),
  sagascript: Object.freeze([
    'evidence/collection-status.json',
    'evidence/collection-overhead.json',
    'evidence/ci-workflow.json',
    'workflow-status.json',
  ]),
});

const WORKFLOW_STATUS_KEYS = Object.freeze([
  'status', 'phase', 'reason', 'phase_elapsed_seconds', 'preupload_elapsed_seconds',
  'preupload_budget_seconds', 'preupload_over_budget', 'metadata_elapsed_seconds',
  'metadata_budget_seconds', 'metadata_over_budget', 'over_budget',
]);

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finiteNonNegativeOrNull(value) {
  return value === null || finiteNonNegative(value);
}

function validateWorkflowStatus(files) {
  if (!files.has('workflow-status.json')) return;
  const status = readJsonFile(files, 'workflow-status.json');
  if (!status || typeof status !== 'object' || Array.isArray(status)
    || !['completed', 'partial', 'failed', 'not-collected'].includes(status.status)) {
    throw new Error('workflow status is malformed');
  }
  if (status.status === 'failed' || status.status === 'not-collected') {
    throw new Error('producer workflow reports a setup or collection failure');
  }
  if (canonical(Object.keys(status).sort()) !== canonical([...WORKFLOW_STATUS_KEYS].sort())
    || typeof status.phase !== 'string' || status.phase.length === 0
    || (status.reason !== null && typeof status.reason !== 'string')
    || !finiteNonNegativeOrNull(status.phase_elapsed_seconds)
    || !finiteNonNegative(status.preupload_elapsed_seconds)
    || !finiteNonNegative(status.preupload_budget_seconds)
    || typeof status.preupload_over_budget !== 'boolean'
    || !finiteNonNegativeOrNull(status.metadata_elapsed_seconds)
    || !finiteNonNegative(status.metadata_budget_seconds)
    || typeof status.metadata_over_budget !== 'boolean'
    || typeof status.over_budget !== 'boolean') {
    throw new Error('workflow status is malformed');
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchivePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.pathLength
    || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const pathValue = directory ? value.slice(0, -1) : value;
  if (!pathValue || (directory && !value.endsWith('/'))) return false;
  const parts = pathValue.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('artifact contains a non-UTF-8 member name'); }
}

function parseZipArchive(input, limits = LIMITS) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buffer.length < 22 || buffer.length > limits.archiveBytes) throw new Error('artifact archive size is outside the accepted bound');
  let eocd = -1;
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= searchFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('artifact ZIP end record is missing');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralBytes = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== buffer.length || disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
    || entryCount > limits.entries || entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralBytes !== eocd) throw new Error('artifact ZIP directory is unsupported or exceeds its bound');

  const entries = [];
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('artifact ZIP central directory is malformed');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const fullLength = 46 + nameLength + extraLength + fileCommentLength;
    if (cursor + fullLength > eocd || startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff || (flags & ~(0x0008 | 0x0800)) !== 0 || method !== 0 && method !== 8) {
      throw new Error('artifact ZIP entry uses unsupported flags, compression, or ZIP64');
    }
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    const isDirectory = name.endsWith('/');
    if (!safeArchivePath(name, { directory: isDirectory })) throw new Error('artifact contains an unsafe member path');
    const mode = externalAttributes >>> 16;
    const kind = mode & 0xf000;
    if (kind === 0xa000 || (kind !== 0 && kind !== 0x8000 && kind !== 0x4000)) throw new Error('artifact contains a link or special file');
    if ((kind === 0x4000) !== isDirectory) throw new Error('artifact member type does not match its path');
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) throw new Error('artifact directory has a payload');
    if (!isDirectory && (uncompressedSize > limits.entryBytes || compressedSize > limits.archiveBytes)) throw new Error('artifact member exceeds its size bound');
    expandedBytes += uncompressedSize;
    if (expandedBytes > limits.totalExpandedBytes) throw new Error('artifact expanded size exceeds its bound');
    entries.push({ name, isDirectory, method, flags, expectedCrc, compressedSize, uncompressedSize, localOffset });
    cursor += fullLength;
  }
  if (cursor !== eocd) throw new Error('artifact ZIP central directory has trailing data');

  const names = new Set();
  const ranges = [];
  const files = new Map();
  const directories = [];
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error('artifact ZIP contains a duplicate member');
    names.add(entry.name);
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('artifact ZIP local member header is malformed');
    const localFlags = buffer.readUInt16LE(offset + 6);
    const localMethod = buffer.readUInt16LE(offset + 8);
    const localCrc = buffer.readUInt32LE(offset + 14);
    const localCompressedSize = buffer.readUInt32LE(offset + 18);
    const localUncompressedSize = buffer.readUInt32LE(offset + 22);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const localNameEnd = offset + 30 + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset || localFlags !== entry.flags || localMethod !== entry.method
      || decodeName(buffer.subarray(offset + 30, localNameEnd)) !== entry.name) throw new Error('artifact ZIP local and central headers disagree');
    if ((entry.flags & 0x0008) === 0
      ? localCrc !== entry.expectedCrc || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize
      : (localCrc !== 0 && localCrc !== entry.expectedCrc)
        || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)) {
      throw new Error('artifact ZIP local sizes or checksum disagree');
    }
    ranges.push([offset, dataEnd]);
    if (entry.isDirectory) {
      directories.push(entry.name);
      continue;
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let contents;
    try {
      contents = entry.method === 0 ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: limits.entryBytes });
    } catch {
      throw new Error('artifact member cannot be safely decompressed');
    }
    if (contents.length !== entry.uncompressedSize || crc32(contents) !== entry.expectedCrc) throw new Error('artifact member checksum or length is invalid');
    files.set(entry.name, contents);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) throw new Error('artifact ZIP entries overlap');
  }
  return { files, directories, sha256: sha256(buffer), bytes: buffer.length };
}

function readJsonFile(files, file) {
  const bytes = files.get(file);
  if (!bytes || bytes.length > LIMITS.jsonBytes) throw new Error(`artifact JSON member is missing or too large: ${file}`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`artifact JSON member is malformed: ${file}`); }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) throw new Error(`${label} keys do not match the v1 contract`);
}

function collectReferences(value, output = new Set()) {
  if (typeof value === 'string' && /^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(value)) output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectReferences(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectReferences(item, output);
  return output;
}

function collectSnapshotReferences(snapshot, output = new Set()) {
  for (const [key, value] of Object.entries(snapshot)) {
    // snapshot_id is the snapshot's identity, resolved through the authenticated manifest path.
    // Nested references (including any nested key also named snapshot_id) remain evidence refs.
    if (key !== 'snapshot_id') collectReferences(value, output);
  }
  return output;
}

function validateEvidenceIndex(evidenceIndex, snapshots, fileNames, repository) {
  exactKeys(evidenceIndex, ['version', 'refs'], 'evidence index');
  if (evidenceIndex.version !== '1.0' || !evidenceIndex.refs || typeof evidenceIndex.refs !== 'object' || Array.isArray(evidenceIndex.refs)) {
    throw new Error('artifact evidence index is invalid');
  }
  const snapshotReferences = new Set();
  for (const snapshot of snapshots) collectSnapshotReferences(snapshot, snapshotReferences);
  for (const reference of snapshotReferences) {
    if (!Object.hasOwn(evidenceIndex.refs, reference)) throw new Error(`snapshot evidence reference is unresolved: ${reference}`);
  }
  const referencedFiles = new Set();
  for (const [reference, evidence] of Object.entries(evidenceIndex.refs)) {
    if (!/^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(reference) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error('artifact evidence reference is malformed');
    }
    if (evidence.kind === 'artifact-file') {
      exactKeys(evidence, ['kind', 'path'], 'artifact-file evidence');
      if (!safeArchivePath(evidence.path) || !(evidence.path.startsWith('evidence/')
        || evidence.path.startsWith('snapshots/') || evidence.path === 'scope-registry.json')) {
        throw new Error('artifact evidence path is outside its namespace');
      }
      referencedFiles.add(evidence.path);
    } else if (evidence.kind === 'source') {
      exactKeys(evidence, ['kind', 'path', 'line'], 'source evidence');
      if (!safeArchivePath(evidence.path) || !Number.isSafeInteger(evidence.line) || evidence.line < 1) throw new Error('source evidence is malformed');
    } else if (evidence.kind === 'github-run') {
      exactKeys(evidence, ['kind', 'run_id', 'attempt'], 'GitHub run evidence');
      if (!Number.isSafeInteger(evidence.run_id) || evidence.run_id < 1
        || !Number.isSafeInteger(evidence.attempt) || evidence.attempt < 1) throw new Error('GitHub run evidence is malformed');
    } else throw new Error('artifact evidence kind is unsupported');
  }
  if (repository.name === 'sagascript') {
    const filePath = 'scope-registry.json';
    if (!referencedFiles.has(filePath) || !fileNames.has(filePath)) throw new Error('sagascript artifact omits its registered scope registry');
    const expectedRegistry = readJsonFileFromPath(path.join(__dirname, 'registries/sagascript/code-health-producer-v1.json'));
    if (canonical(readJsonFile(fileNames, filePath)) !== canonical(expectedRegistry)) throw new Error('sagascript artifact scope registry differs from the pinned producer registry');
  }
  return referencedFiles;
}

function readJsonFileFromPath(file) {
  return JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
}

function validateSnapshotAgainstRegistry(snapshot, repository, provenance) {
  const expected = EXPECTED_SLOTS.get(repository.name);
  if (!expected) throw new Error('snapshot repository has no pinned slot registry');
  if (snapshot.contract_version !== '1.0' || snapshot.repository?.owner !== repository.owner || snapshot.repository?.name !== repository.name) {
    throw new Error('snapshot identity differs from authenticated repository provenance');
  }
  for (const [metricName, metric] of Object.entries(snapshot.metrics)) {
    const slot = expected.byRef.get(metric.slot_ref);
    if (!slot || slot.metric !== metricName) throw new Error(`snapshot slot is not registered for ${repository.name}/${metricName}`);
    if (metric.source) {
      const suffix = repository.name === 'gille-inference'
        ? ({ complex_functions: 'complexity', unused_candidates: 'knip', coverage: 'coverage', ci_first_attempt: 'ci' })[metricName]
        : null;
      const expectedRunRef = repository.name === 'sagascript'
        ? `ref:github-run-${provenance.runId}-attempt-${provenance.attempt}`
        : suffix ? `ref:collection-gha-${provenance.runId}-attempt-${provenance.attempt}-${suffix}` : null;
      if (!expectedRunRef || metric.source.run_ref !== expectedRunRef || metric.source.attempt !== provenance.attempt) {
        throw new Error(`snapshot source run is not bound to authenticated workflow run: ${slot.slot_ref}`);
      }
      if (metric.source.language !== slot.language || metric.source.platform !== slot.platform
        || metric.source.scope_version !== slot.scope_version
        || canonical([...(metric.source.feature_refs ?? [])].sort()) !== canonical([...slot.feature_refs].sort())
        || (slot.metric_version && metric.source.metric_version !== slot.metric_version)) {
        throw new Error(`snapshot metric source differs from registered scope: ${slot.slot_ref}`);
      }
    }
  }
}

async function parseObjectiveArtifact(bytes, provenance) {
  const repository = { owner: provenance.repositoryOwner, name: provenance.repositoryName };
  const pinnedSource = sourceForRepository(repository.owner, repository.name);
  if (!pinnedSource) throw new Error('artifact repository is not allowlisted');
  const archive = parseZipArchive(bytes);
  const files = archive.files;
  validateWorkflowStatus(files);
  const manifest = readJsonFile(files, 'manifest.json');
  exactKeys(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.contract_version !== '1.0' || manifest.repo_owner !== repository.owner || manifest.repo_name !== repository.name
    || manifest.commit_sha !== provenance.headSha || !/^[a-f0-9]{40}$/.test(manifest.commit_sha)
    || manifest.evidence_index !== 'evidence-index.json' || !Array.isArray(manifest.snapshots) || manifest.snapshots.length < 1
    || manifest.snapshots.length > 100) throw new Error('manifest does not match authenticated run provenance');
  const snapshotPaths = new Set();
  const snapshotIds = new Set();
  const snapshots = [];
  for (const snapshotPath of manifest.snapshots) {
    if (!safeArchivePath(snapshotPath) || !snapshotPath.startsWith('snapshots/') || !snapshotPath.endsWith('.json') || snapshotPaths.has(snapshotPath)) {
      throw new Error('manifest snapshot path is unsafe or duplicated');
    }
    snapshotPaths.add(snapshotPath);
    const snapshot = readJsonFile(files, snapshotPath);
    if (snapshot.commit !== provenance.headSha || snapshot.snapshot_id == null || snapshotIds.has(snapshot.snapshot_id)) {
      throw new Error('snapshot commit is unbound or snapshot identity is duplicated');
    }
    snapshotIds.add(snapshot.snapshot_id);
    validateSnapshotAgainstRegistry(snapshot, repository, provenance);
    snapshots.push(snapshot);
  }
  const evidenceIndex = readJsonFile(files, manifest.evidence_index);
  const referencedFiles = validateEvidenceIndex(evidenceIndex, snapshots, files, repository);
  const allowedFiles = new Set(['manifest.json', 'evidence-index.json', ...snapshotPaths, ...referencedFiles]);
  for (const auxiliaryPath of PRODUCER_AUXILIARY_FILES[repository.name] ?? []) {
    if (files.has(auxiliaryPath)) allowedFiles.add(auxiliaryPath);
  }
  if (files.has('report.md')) allowedFiles.add('report.md');
  for (const name of files.keys()) if (!allowedFiles.has(name)) throw new Error(`artifact contains an unknown file: ${name}`);
  for (const name of allowedFiles) {
    if (!files.has(name)) throw new Error(`artifact omits a declared file: ${name}`);
  }
  for (const directory of archive.directories) {
    const prefix = directory;
    if (![...allowedFiles].some((name) => name.startsWith(prefix))) throw new Error('artifact contains an unknown directory');
  }
  const contract = await loadContract();
  for (const snapshot of snapshots) {
    const validation = contract.validateObjective(contract.objectiveSchema, snapshot);
    if (!validation.valid) throw new Error('objective snapshot failed frozen contract validation');
  }
  return { archive, manifest, evidenceIndex, snapshots, repository, pinnedSource };
}

module.exports = { LIMITS, canonical, safeArchivePath, parseZipArchive, parseObjectiveArtifact, sha256 };
