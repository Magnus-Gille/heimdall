'use strict';

const { execFile: nodeExecFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { REPOSITORIES } = require('./registry');
const { LIMITS } = require('./artifact');

const API_HOST = 'github.com';
const GH_TIMEOUT_MS = 10_000;
const REPOSITORY_SCAN_BUDGET_MS = 60_000;
const METADATA_MAX_BUFFER = 2 * 1024 * 1024;
const RUN_PAGE_SIZE = 25;
const RUN_PAGE_LIMIT = 2;
const ELIGIBLE_RUN_LIMIT = 10;
const JOB_PAGE_SIZE = 100;
const JOB_PAGE_LIMIT = 2;
const ARTIFACT_PAGE_SIZE = 25;
const TRUSTED_EVENTS = new Set(['schedule', 'workflow_dispatch']);
const RUN_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function instantMs(value) {
  if (typeof value !== 'string' || !RUN_INSTANT.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function runGh(execFile, args, {
  binary = false,
  maxBuffer = METADATA_MAX_BUFFER,
  deadline = null,
} = {}) {
  let timeout = GH_TIMEOUT_MS;
  let deadlineBounded = false;
  if (deadline) {
    const remaining = deadline.at - deadline.now();
    if (remaining <= 0) return Promise.reject(new Error('github-scan-deadline-exceeded'));
    timeout = Math.min(GH_TIMEOUT_MS, Math.floor(remaining));
    if (timeout < 1) return Promise.reject(new Error('github-scan-deadline-exceeded'));
    deadlineBounded = remaining <= GH_TIMEOUT_MS;
  }
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      encoding: binary ? 'buffer' : 'utf8',
      timeout,
      maxBuffer,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(deadline && (deadline.now() >= deadline.at
          || (error.code === 'ETIMEDOUT' && deadlineBounded))
          ? 'github-scan-deadline-exceeded' : 'github-read-unavailable'));
        return;
      }
      resolve(stdout);
    });
  });
}

function apiArgs(endpoint) {
  return [
    'api', '--hostname', API_HOST, '--method', 'GET',
    '--header', 'Accept: application/vnd.github+json', endpoint,
  ];
}

async function requestJson(execFile, endpoint, deadline) {
  const output = await runGh(execFile, apiArgs(endpoint), { deadline });
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > METADATA_MAX_BUFFER) {
    throw new Error('github-response-out-of-bounds');
  }
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('github-response-malformed'); }
  if (!isRecord(value)) throw new Error('github-response-malformed');
  return value;
}

function pinnedSource(owner, repository, workflowPath) {
  const source = REPOSITORIES.find((item) => item.owner === owner && item.name === repository);
  if (!source || workflowPath !== source.workflowPath) throw new Error('github-source-outside-allowlist');
  return source;
}

function workflowRunsEndpoint(source, since, page) {
  const created = encodeURIComponent(`${since}..*`);
  return `repos/${source.owner}/${source.name}/actions/workflows/code-health.yml/runs?branch=main&status=completed&created=${created}&per_page=${RUN_PAGE_SIZE}&page=${page}`;
}

function validRunRevision(run, source, workflowId) {
  const repository = run.repository;
  const headRepository = run.head_repository;
  if (!Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.workflow_id) || run.workflow_id !== workflowId
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.status !== 'completed' || !TRUSTED_EVENTS.has(run.event)
    || run.head_branch !== 'main'
    || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || instantMs(run.created_at) == null || instantMs(run.updated_at) == null
    || !isRecord(repository) || !Number.isSafeInteger(repository.id) || repository.id < 1
    || repository.full_name !== `${source.owner}/${source.name}`
    || !isRecord(headRepository) || headRepository.id !== repository.id
    || headRepository.full_name !== `${source.owner}/${source.name}`) {
    throw new Error('github-run-provenance-invalid');
  }
  return Object.freeze({
    id: run.id,
    workflowId: run.workflow_id,
    attempt: run.run_attempt,
    status: run.status,
    event: run.event,
    branch: run.head_branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    repositoryId: repository.id,
    repositoryOwner: source.owner,
    repositoryName: source.name,
  });
}

function sameRunRevision(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectListedRun(run, source, workflowId, sinceMs, nowMs) {
  if (!isRecord(run) || !Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.workflow_id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || !isRecord(run.repository) || !Number.isSafeInteger(run.repository.id) || run.repository.id < 1
    || run.repository.full_name !== `${source.owner}/${source.name}`
    || !isRecord(run.head_repository) || run.head_repository.full_name !== `${source.owner}/${source.name}`
    || run.head_repository.id !== run.repository.id
    || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || instantMs(run.created_at) == null) return { eligible: false, incomplete: true };
  if (run.workflow_id !== workflowId) return { eligible: false, incomplete: true };
  const createdAt = instantMs(run.created_at);
  if (createdAt > nowMs) return { eligible: false, incomplete: true };
  if (createdAt < sinceMs) return { eligible: false, incomplete: false };
  if (run.status !== 'completed' || run.head_branch !== 'main') return { eligible: false, incomplete: true };
  if (!TRUSTED_EVENTS.has(run.event)) return { eligible: false, incomplete: false };
  return { eligible: true, incomplete: false };
}

function validateListPage(page, field, pageSize, pageNumber = 1) {
  if (!Number.isSafeInteger(page.total_count) || page.total_count < 0
    || !Array.isArray(page[field]) || page[field].length > pageSize) {
    throw new Error('github-response-malformed');
  }
  const expectedLength = Math.min(pageSize, Math.max(0, page.total_count - ((pageNumber - 1) * pageSize)));
  if (page[field].length !== expectedLength) throw new Error('github-response-incomplete');
  return page[field];
}

async function collectRunPages(execFile, source, workflowId, since, currentTime, deadline) {
  const sinceMs = Date.parse(since);
  const nowMs = Date.parse(currentTime);
  const runs = new Map();
  let incomplete = false;
  let advertisedTotal = 0;
  for (let pageNumber = 1; pageNumber <= RUN_PAGE_LIMIT; pageNumber += 1) {
    const page = await requestJson(execFile, workflowRunsEndpoint(source, since, pageNumber), deadline);
    const items = validateListPage(page, 'workflow_runs', RUN_PAGE_SIZE, pageNumber);
    advertisedTotal = Math.max(advertisedTotal, page.total_count);
    for (const item of items) {
      const inspected = inspectListedRun(item, source, workflowId, sinceMs, nowMs);
      if (inspected.incomplete) incomplete = true;
      if (!inspected.eligible) continue;
      const prior = runs.get(item.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(item)) incomplete = true;
      else runs.set(item.id, item);
    }
    const more = page.total_count > pageNumber * RUN_PAGE_SIZE;
    if (!more) break;
    if (pageNumber === RUN_PAGE_LIMIT) incomplete = true;
  }
  if (advertisedTotal > RUN_PAGE_LIMIT * RUN_PAGE_SIZE) incomplete = true;
  return {
    runs: [...runs.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id),
    incomplete,
  };
}

async function attemptJobWindow(execFile, source, run, deadline) {
  const jobs = new Map();
  let advertisedTotal = 0;
  for (let pageNumber = 1; pageNumber <= JOB_PAGE_LIMIT; pageNumber += 1) {
    const endpoint = `repos/${source.owner}/${source.name}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=${JOB_PAGE_SIZE}&page=${pageNumber}`;
    const page = await requestJson(execFile, endpoint, deadline);
    const items = validateListPage(page, 'jobs', JOB_PAGE_SIZE, pageNumber);
    advertisedTotal = Math.max(advertisedTotal, page.total_count);
    for (const job of items) {
      if (!isRecord(job) || !Number.isSafeInteger(job.id) || job.id < 1
        || job.run_id !== run.id || job.run_attempt !== run.attempt
        || job.status !== 'completed'
        || instantMs(job.started_at) == null || instantMs(job.completed_at) == null) {
        throw new Error('github-attempt-jobs-ambiguous');
      }
      if (jobs.has(job.id)) throw new Error('github-attempt-jobs-ambiguous');
      jobs.set(job.id, job);
    }
    if (page.total_count <= pageNumber * JOB_PAGE_SIZE) break;
    if (pageNumber === JOB_PAGE_LIMIT) throw new Error('github-attempt-jobs-out-of-bounds');
  }
  if (advertisedTotal < 1 || advertisedTotal !== jobs.size) throw new Error('github-attempt-jobs-ambiguous');
  const windows = [...jobs.values()];
  const earliestStarted = Math.min(...windows.map((job) => instantMs(job.started_at)));
  const latestCompleted = Math.max(...windows.map((job) => instantMs(job.completed_at)));
  if (!Number.isFinite(earliestStarted) || !Number.isFinite(latestCompleted) || earliestStarted >= latestCompleted) {
    throw new Error('github-attempt-jobs-ambiguous');
  }
  return { earliestStarted, latestCompleted };
}

function artifactMatchesAttempt(artifact, source, run, repoId, window) {
  if (!isRecord(artifact) || !Number.isSafeInteger(artifact.id) || artifact.id < 1
    || artifact.name !== 'code-health-v1' || artifact.expired === true
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || artifact.size_in_bytes > LIMITS.archiveBytes || instantMs(artifact.created_at) == null
    || !isRecord(artifact.workflow_run)) return false;
  const workflowRun = artifact.workflow_run;
  const createdAt = instantMs(artifact.created_at);
  return workflowRun.id === run.id
    && workflowRun.repository_id === repoId
    && workflowRun.head_repository_id === repoId
    && workflowRun.head_branch === 'main'
    && workflowRun.head_sha === run.headSha
    && createdAt > window.earliestStarted
    && createdAt < window.latestCompleted;
}

async function artifactsForRun(execFile, source, run, repoId, window, deadline) {
  const endpoint = `repos/${source.owner}/${source.name}/actions/runs/${run.id}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=1`;
  const page = await requestJson(execFile, endpoint, deadline);
  const items = validateListPage(page, 'artifacts', ARTIFACT_PAGE_SIZE);
  const candidates = [];
  let incomplete = page.total_count > ARTIFACT_PAGE_SIZE;
  for (const artifact of items) {
    if (!isRecord(artifact) || artifact.name !== 'code-health-v1') continue;
    if (!artifactMatchesAttempt(artifact, source, run, repoId, window)) {
      incomplete = true;
      continue;
    }
    candidates.push(artifact);
  }
  if (candidates.length > 1) return { candidates: [], incomplete: true };
  return { candidates, incomplete };
}

function toCandidate(source, workflow, run, artifact) {
  return {
    workflow: { path: workflow.path },
    run: {
      repository_owner: source.owner,
      repository_name: source.name,
      branch: run.branch,
      event: run.event,
      status: run.status,
      id: run.id,
      attempt: run.attempt,
      head_sha: run.headSha,
      created_at: run.createdAt,
    },
    artifact: {
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.size_in_bytes,
      created_at: artifact.created_at,
      workflow_run_id: run.id,
      // The API omits run_attempt. This binding was established from the exact
      // attempt's explicitly tagged job window and the stable run readback.
      workflow_run_attempt: run.attempt,
    },
  };
}

function createGitHubTransport({
  execFile = nodeExecFile,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
} = {}) {
  const deadlines = new Map();
  async function listArtifacts({ owner, repository, workflowPath, branch, events, artifactName }) {
    const source = pinnedSource(owner, repository, workflowPath);
    if (branch !== 'main' || artifactName !== 'code-health-v1'
      || !Array.isArray(events) || events.length !== TRUSTED_EVENTS.size
      || new Set(events).size !== TRUSTED_EVENTS.size || events.some((event) => !TRUSTED_EVENTS.has(event))) {
      throw new Error('github-source-outside-allowlist');
    }
    const at = now();
    const nowMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
    if (!Number.isFinite(nowMs)) throw new Error('github-clock-invalid');
    const currentTime = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const since = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const sourceKey = `${source.owner}/${source.name}`;
    const startedAt = monotonicNow();
    if (!Number.isFinite(startedAt)) throw new Error('github-clock-invalid');
    const deadline = { now: monotonicNow, at: startedAt + REPOSITORY_SCAN_BUDGET_MS };
    deadlines.set(sourceKey, deadline);
    const workflow = await requestJson(execFile, `repos/${source.owner}/${source.name}/actions/workflows/code-health.yml`, deadline);
    if (workflow.path !== source.workflowPath || !Number.isSafeInteger(workflow.id) || workflow.id < 1) {
      throw new Error('github-workflow-provenance-invalid');
    }

    const listed = await collectRunPages(execFile, source, workflow.id, since, currentTime, deadline);
    let incomplete = listed.incomplete;
    if (listed.runs.length > ELIGIBLE_RUN_LIMIT) incomplete = true;
    const selectedRuns = listed.runs.slice(0, ELIGIBLE_RUN_LIMIT);
    const candidates = [];
    const seenArtifactIds = new Set();
    for (const listedRun of selectedRuns) {
      try {
        const listedRevision = validRunRevision(listedRun, source, workflow.id);
        const initialJson = await requestJson(execFile, `repos/${source.owner}/${source.name}/actions/runs/${listedRun.id}`, deadline);
        const initial = validRunRevision(initialJson, source, workflow.id);
        if (!sameRunRevision(listedRevision, initial)) {
          incomplete = true;
          continue;
        }
        const window = await attemptJobWindow(execFile, source, initial, deadline);
        const artifactPage = await artifactsForRun(execFile, source, initial, initial.repositoryId, window, deadline);
        if (artifactPage.incomplete) incomplete = true;

        // Artifact metadata carries no attempt number, so it is not admitted
        // until a second read proves the run revision did not change mid-scan.
        const readbackJson = await requestJson(execFile, `repos/${source.owner}/${source.name}/actions/runs/${listedRun.id}`, deadline);
        const readback = validRunRevision(readbackJson, source, workflow.id);
        if (!sameRunRevision(initial, readback)) {
          incomplete = true;
          continue;
        }
        for (const artifact of artifactPage.candidates) {
          if (seenArtifactIds.has(artifact.id)) {
            incomplete = true;
            continue;
          }
          seenArtifactIds.add(artifact.id);
          candidates.push(toCandidate(source, workflow, initial, artifact));
        }
      } catch {
        // A missing or ambiguous attempt window makes this run ineligible.
        // Preserve the rest of the bounded cycle and report it as partial.
        incomplete = true;
        if (deadline.now() >= deadline.at) break;
      }
    }
    return { candidates, incomplete };
  }

  async function downloadArtifact({ owner, repository, artifactId }) {
    const source = REPOSITORIES.find((item) => item.owner === owner && item.name === repository);
    if (!source || !Number.isSafeInteger(artifactId) || artifactId < 1) throw new Error('github-source-outside-allowlist');
    const endpoint = `repos/${source.owner}/${source.name}/actions/artifacts/${artifactId}/zip`;
    const deadline = deadlines.get(`${source.owner}/${source.name}`);
    if (!deadline) throw new Error('github-scan-deadline-exceeded');
    const bytes = await runGh(execFile, apiArgs(endpoint), { binary: true, maxBuffer: LIMITS.archiveBytes, deadline });
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LIMITS.archiveBytes) {
      throw new Error('github-artifact-out-of-bounds');
    }
    return bytes;
  }

  return Object.freeze({ listArtifacts, downloadArtifact });
}

module.exports = {
  API_HOST,
  GH_TIMEOUT_MS,
  REPOSITORY_SCAN_BUDGET_MS,
  METADATA_MAX_BUFFER,
  RUN_PAGE_SIZE,
  RUN_PAGE_LIMIT,
  ELIGIBLE_RUN_LIMIT,
  JOB_PAGE_SIZE,
  JOB_PAGE_LIMIT,
  ARTIFACT_PAGE_SIZE,
  createGitHubTransport,
};
