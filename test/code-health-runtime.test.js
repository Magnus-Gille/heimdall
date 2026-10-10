'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  API_HOST,
  GH_TIMEOUT_MS,
  RUN_PAGE_SIZE,
  RUN_PAGE_LIMIT,
  REPOSITORY_SCAN_BUDGET_MS,
  createGitHubTransport,
} = require('../src/code-health/github-transport');
const { loadCodeHealthRuntimeConfig, MAX_CONFIG_BYTES } = require('../src/code-health/runtime-config');
const { runCodeHealthCollection } = require('../src/code-health/runtime');
const { collectObjectiveReports } = require('../src/code-health/objective-collector');
const { readObjectiveSourceState } = require('../src/code-health/store');
const { openDatabase } = require('../src/db');

const NOW = new Date('2026-10-10T12:00:00Z');
const HEAD = 'a'.repeat(40);
const SOURCE = { owner: 'Magnus-Gille', repository: 'sagascript', workflowPath: '.github/workflows/code-health.yml' };

function workflowRun(overrides = {}) {
  return {
    id: 9321,
    workflow_id: 55,
    run_attempt: 1,
    status: 'completed',
    event: 'schedule',
    head_branch: 'main',
    head_sha: HEAD,
    created_at: '2026-10-09T09:00:00Z',
    updated_at: '2026-10-09T10:05:00Z',
    repository: { id: 1234, full_name: 'Magnus-Gille/sagascript' },
    head_repository: { id: 1234, full_name: 'Magnus-Gille/sagascript' },
    ...overrides,
  };
}

function workflowJob(overrides = {}) {
  return {
    id: 991,
    run_id: 9321,
    run_attempt: 1,
    status: 'completed',
    started_at: '2026-10-09T10:00:00Z',
    completed_at: '2026-10-09T10:05:00Z',
    ...overrides,
  };
}

function workflowArtifact(overrides = {}) {
  return {
    id: 8101,
    name: 'code-health-v1',
    size_in_bytes: 512,
    expired: false,
    created_at: '2026-10-09T10:04:00Z',
    workflow_run: {
      id: 9321,
      repository_id: 1234,
      head_repository_id: 1234,
      head_branch: 'main',
      head_sha: HEAD,
    },
    ...overrides,
  };
}

function ghFixture({
  listedRun = workflowRun(),
  currentRuns = [workflowRun()],
  jobs = [workflowJob()],
  artifacts = [workflowArtifact()],
  workflow = { id: 55, path: '.github/workflows/code-health.yml' },
  runListTotal = 1,
  runListPages,
  fail = null,
  malformedEndpoint = null,
  binary = Buffer.from([1, 2, 3]),
} = {}) {
  const calls = [];
  let runRead = 0;
  const execFile = (file, args, options, callback) => {
    const endpoint = args.at(-1);
    calls.push({ file, args: [...args], options: { ...options }, endpoint });
    if (endpoint === malformedEndpoint) {
      callback(null, '{not-json', '');
      return;
    }
    if (fail && endpoint === fail.endpoint) {
      callback(new Error('command failed'), '', fail.stderr || 'private token details');
      return;
    }
    let value;
    if (endpoint === `repos/${SOURCE.owner}/${SOURCE.repository}/actions/workflows/code-health.yml`) value = workflow;
    else if (endpoint.startsWith(`repos/${SOURCE.owner}/${SOURCE.repository}/actions/workflows/code-health.yml/runs?`)) {
      const pageNumber = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
      if (runListPages) value = runListPages[pageNumber - 1];
      else value = { total_count: runListTotal, workflow_runs: pageNumber === 1 ? [listedRun] : [] };
    } else if (endpoint === `repos/${SOURCE.owner}/${SOURCE.repository}/actions/runs/${listedRun.id}`) {
      value = currentRuns[Math.min(runRead, currentRuns.length - 1)];
      runRead += 1;
    } else if (endpoint.startsWith(`repos/${SOURCE.owner}/${SOURCE.repository}/actions/runs/${listedRun.id}/attempts/`)) {
      value = { total_count: jobs.length, jobs };
    } else if (endpoint === `repos/${SOURCE.owner}/${SOURCE.repository}/actions/runs/${listedRun.id}/artifacts?per_page=25&page=1`) {
      value = { total_count: artifacts.length, artifacts };
    } else if (endpoint === `repos/${SOURCE.owner}/${SOURCE.repository}/actions/artifacts/8101/zip`) {
      callback(null, binary, '');
      return;
    } else {
      callback(new Error('unexpected fixture request'), '', 'untrusted stderr');
      return;
    }
    callback(null, options.encoding === 'buffer' ? Buffer.from(JSON.stringify(value)) : JSON.stringify(value), '');
  };
  return { calls, execFile };
}

describe('code-health runtime configuration', () => {
  it('keeps collection off by default while retaining valid source identity for reads', () => {
    const source = {
      repoOwner: SOURCE.owner,
      repoName: SOURCE.repository,
      namespace: 'grimnir/code-health',
      producerPrincipalId: 'heimdall-test-producer',
    };
    const config = loadCodeHealthRuntimeConfig({
      env: { HEIMDALL_CODE_HEALTH_CONFIG: 'private-config-location' },
      readConfig: () => ({ sources: [source] }),
    });
    assert.equal(config.status, 'disabled');
    assert.equal(config.objectiveEnabled, false);
    assert.equal(config.subjectiveConfigForRepo('sagascript').enabled, false);
    assert.equal(config.subjectiveConfigForRepo('sagascript').namespace, source.namespace);
    assert.doesNotMatch(JSON.stringify(config), /private-config-location/);
  });

  it('rejects malformed enabled config without returning its path or accepting extra source fields', () => {
    const config = loadCodeHealthRuntimeConfig({
      env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'private-config-location' },
      readConfig: () => ({ sources: [{
        repoOwner: SOURCE.owner,
        repoName: SOURCE.repository,
        namespace: 'grimnir/code-health',
        producerPrincipalId: 'heimdall-test-producer',
        endpoint: 'https://example.invalid',
      }] }),
    });
    assert.equal(config.status, 'rejected');
    assert.equal(config.enabled, false);
    assert.equal(config.subjectiveConfigForRepo('sagascript').enabled, true);
    assert.doesNotMatch(JSON.stringify(config), /private-config-location|example\.invalid/);
  });

  it('bounds the private config file before parsing it', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-code-health-config-'));
    const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20));
      const config = loadCodeHealthRuntimeConfig({
        env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: file },
      });
      assert.equal(config.status, 'rejected');
      assert.doesNotMatch(JSON.stringify(config), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('read-only GitHub transport', () => {
  it('binds an artifact to the exact attempt window and stable run revision', async () => {
    const fixture = ghFixture();
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => NOW });
    const listing = await transport.listArtifacts({
      ...SOURCE,
      branch: 'main',
      events: ['schedule', 'workflow_dispatch'],
      artifactName: 'code-health-v1',
    });
    assert.equal(listing.incomplete, false);
    assert.equal(listing.candidates.length, 1);
    assert.equal(listing.candidates[0].run.attempt, 1);
    assert.equal(listing.candidates[0].artifact.workflow_run_attempt, 1);
    assert.equal(listing.candidates[0].workflow.path, SOURCE.workflowPath);
    assert.ok(fixture.calls.every(({ file, args, options }) => file === 'gh'
      && args[0] === 'api'
      && args.includes('--hostname') && args[args.indexOf('--hostname') + 1] === API_HOST
      && args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET'
      && !args.includes('--paginate')
      && options.timeout === GH_TIMEOUT_MS
      && options.shell === undefined));
    assert.equal(fixture.calls[0].endpoint, `repos/${SOURCE.owner}/${SOURCE.repository}/actions/workflows/code-health.yml`);
    assert.ok(fixture.calls.some((call) => call.endpoint.includes('/attempts/1/jobs?')));
  });

  it('rejects an older attempt artifact instead of relabeling it as the current attempt', async () => {
    const current = workflowRun({ run_attempt: 2 });
    const fixture = ghFixture({
      listedRun: current,
      currentRuns: [current, current],
      jobs: [workflowJob({ run_attempt: 2, started_at: '2026-10-09T10:10:00Z', completed_at: '2026-10-09T10:15:00Z' })],
      artifacts: [workflowArtifact({ created_at: '2026-10-09T10:04:00Z' })],
    });
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => NOW });
    const listing = await transport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(listing.candidates, []);
    assert.equal(listing.incomplete, true);
  });

  it('rejects run-attempt races and mismatched job identity as partial scans', async () => {
    const initial = workflowRun();
    const laterAttempt = workflowRun({ run_attempt: 2, updated_at: '2026-10-09T10:20:00Z' });
    const racing = ghFixture({ currentRuns: [initial, laterAttempt] });
    const transport = createGitHubTransport({ execFile: racing.execFile, now: () => NOW });
    const raced = await transport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(raced.candidates, []);
    assert.equal(raced.incomplete, true);

    const listedRevision = workflowRun();
    const staleList = ghFixture({
      listedRun: listedRevision,
      currentRuns: [workflowRun({ updated_at: '2026-10-09T10:06:00Z' })],
    });
    const staleTransport = createGitHubTransport({ execFile: staleList.execFile, now: () => NOW });
    const stale = await staleTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(stale.candidates, []);
    assert.equal(stale.incomplete, true);

    const mismatch = ghFixture({ jobs: [workflowJob({ run_attempt: 2 })] });
    const secondTransport = createGitHubTransport({ execFile: mismatch.execFile, now: () => NOW });
    const rejected = await secondTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(rejected.candidates, []);
    assert.equal(rejected.incomplete, true);

    const wrongRepository = ghFixture({ artifacts: [workflowArtifact({ workflow_run: {
      ...workflowArtifact().workflow_run,
      repository_id: 9999,
    } })] });
    const thirdTransport = createGitHubTransport({ execFile: wrongRepository.execFile, now: () => NOW });
    const wrongRepo = await thirdTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(wrongRepo.candidates, []);
    assert.equal(wrongRepo.incomplete, true);

    const duplicateArtifacts = ghFixture({ artifacts: [
      workflowArtifact(),
      workflowArtifact({ id: 8102, created_at: '2026-10-09T10:03:00Z' }),
    ] });
    const duplicateTransport = createGitHubTransport({ execFile: duplicateArtifacts.execFile, now: () => NOW });
    const ambiguous = await duplicateTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(ambiguous.candidates, []);
    assert.equal(ambiguous.incomplete, true);
  });

  it('rejects the wrong workflow path and fails without exposing CLI stderr', async () => {
    const wrongWorkflow = ghFixture({ workflow: { id: 55, path: '.github/workflows/other.yml' } });
    const transport = createGitHubTransport({ execFile: wrongWorkflow.execFile, now: () => NOW });
    await assert.rejects(transport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' }), /workflow-provenance-invalid/);
    assert.equal(wrongWorkflow.calls.length, 1);

    const failed = ghFixture({ fail: {
      endpoint: `repos/${SOURCE.owner}/${SOURCE.repository}/actions/workflows/code-health.yml`,
      stderr: 'sensitive credential material',
    } });
    const failedTransport = createGitHubTransport({ execFile: failed.execFile, now: () => NOW });
    await assert.rejects(
      failedTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' }),
      (error) => error.message === 'github-read-unavailable' && !error.message.includes('sensitive'),
    );

    const malformed = ghFixture({ malformedEndpoint: `repos/${SOURCE.owner}/${SOURCE.repository}/actions/workflows/code-health.yml` });
    const malformedTransport = createGitHubTransport({ execFile: malformed.execFile, now: () => NOW });
    await assert.rejects(
      malformedTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' }),
      /github-response-malformed/,
    );
  });

  it('clamps each GitHub command to the remaining repository scan budget', async () => {
    const fixture = ghFixture();
    let elapsed = 0;
    let readbacks = 0;
    const execFile = (file, args, options, callback) => {
      const endpoint = args.at(-1);
      if (endpoint === `repos/${SOURCE.owner}/${SOURCE.repository}/actions/runs/9321`) {
        readbacks += 1;
        if (readbacks === 2) {
          assert.equal(options.timeout, 5_000);
          elapsed += options.timeout;
          callback(new Error('timed out'), '', '');
          return;
        }
      }
      assert.ok(options.timeout <= GH_TIMEOUT_MS);
      elapsed += 11_000;
      fixture.execFile(file, args, options, callback);
    };
    const transport = createGitHubTransport({
      execFile,
      now: () => NOW,
      monotonicNow: () => elapsed,
    });
    const listing = await transport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.equal(REPOSITORY_SCAN_BUDGET_MS, 60_000);
    assert.equal(listing.incomplete, true);
    assert.deepEqual(listing.candidates, []);
    assert.equal(elapsed, REPOSITORY_SCAN_BUDGET_MS);
  });

  it('surfaces provider page truncation and downloads only a numeric artifact ID from the fixed repository', async () => {
    const old = workflowRun({ created_at: '2026-09-01T09:00:00Z' });
    const runs = Array.from({ length: RUN_PAGE_SIZE * RUN_PAGE_LIMIT + 1 }, (_, index) => ({
      ...old,
      id: old.id + index,
    }));
    const pages = [
      { total_count: runs.length, workflow_runs: runs.slice(0, RUN_PAGE_SIZE) },
      { total_count: runs.length, workflow_runs: runs.slice(RUN_PAGE_SIZE, RUN_PAGE_SIZE * RUN_PAGE_LIMIT) },
    ];
    const fixture = ghFixture({ runListPages: pages });
    const transport = createGitHubTransport({ execFile: fixture.execFile, now: () => NOW });
    const listing = await transport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(listing.candidates, []);
    assert.equal(listing.incomplete, true);
    assert.equal(fixture.calls.filter((call) => call.endpoint.includes('/actions/workflows/code-health.yml/runs?')).length, RUN_PAGE_LIMIT);

    const underfilled = ghFixture({ runListTotal: 3 });
    const underfilledTransport = createGitHubTransport({ execFile: underfilled.execFile, now: () => NOW });
    await assert.rejects(
      underfilledTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' }),
      /github-response-incomplete/,
    );

    const bytes = await transport.downloadArtifact({ owner: SOURCE.owner, repository: SOURCE.repository, artifactId: 8101 });
    assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
    assert.match(fixture.calls.at(-1).endpoint, /\/actions\/artifacts\/8101\/zip$/);
    await assert.rejects(transport.downloadArtifact({ owner: SOURCE.owner, repository: SOURCE.repository, artifactId: '8101' }), /allowlist/);

    const tooManyJobs = ghFixture({ jobs: Array.from({ length: 101 }, (_, index) => workflowJob({ id: 1000 + index })) });
    const boundedTransport = createGitHubTransport({ execFile: tooManyJobs.execFile, now: () => NOW });
    const bounded = await boundedTransport.listArtifacts({ ...SOURCE, branch: 'main', events: ['schedule', 'workflow_dispatch'], artifactName: 'code-health-v1' });
    assert.deepEqual(bounded.candidates, []);
    assert.equal(bounded.incomplete, true);
  });
});

describe('default-off collection runtime', () => {
  it('makes no provider calls by default or after enabled config rejection', async () => {
    const db = openDatabase(':memory:');
    let calls = 0;
    try {
      const disabled = loadCodeHealthRuntimeConfig({ env: {} });
      const off = await runCodeHealthCollection(db, disabled, {
        githubTransport: { listArtifacts: async () => { calls += 1; return []; }, downloadArtifact: async () => { calls += 1; return Buffer.alloc(0); } },
        muninRpc: async () => { calls += 1; },
      });
      assert.equal(off.status, 'disabled');
      assert.equal(calls, 0);

      const rejectedConfig = loadCodeHealthRuntimeConfig({
        env: { HEIMDALL_CODE_HEALTH: 'on', HEIMDALL_CODE_HEALTH_CONFIG: 'bad-config' },
        readConfig: () => ({ sources: [] }),
      });
      const rejected = await runCodeHealthCollection(db, rejectedConfig, {
        githubTransport: { listArtifacts: async () => { calls += 1; return []; }, downloadArtifact: async () => { calls += 1; return Buffer.alloc(0); } },
        muninRpc: async () => { calls += 1; },
      });
      assert.equal(rejected.status, 'rejected');
      assert.equal(calls, 0);
    } finally {
      db.close();
    }
  });

  it('keeps source state incomplete after a bounded provider scan truncates', async () => {
    const db = openDatabase(':memory:');
    try {
      const result = await collectObjectiveReports({
        db,
        config: { enabled: true },
        clock: () => NOW,
        transport: {
          listArtifacts: async ({ repository }) => repository === 'gille-inference'
            ? { candidates: [], incomplete: true }
            : { candidates: [], incomplete: false },
          downloadArtifact: async () => Buffer.alloc(0),
        },
      });
      assert.equal(result.status, 'partial');
      const state = readObjectiveSourceState(db, {
        repoOwner: 'Magnus-Gille',
        repoName: 'gille-inference',
        enabled: true,
        configured: true,
      });
      assert.equal(state.status, 'incomplete');
      assert.equal(state.last_attempt_status, 'incomplete');
    } finally {
      db.close();
    }
  });

  it('records a scan deadline as incomplete while retaining prior evidence', async () => {
    const db = openDatabase(':memory:');
    try {
      const candidate = {
        workflow: { path: '.github/workflows/code-health.yml' },
        run: {
          repository_owner: 'Magnus-Gille',
          repository_name: 'gille-inference',
          branch: 'main',
          event: 'schedule',
          status: 'completed',
          id: 9321,
          attempt: 1,
          head_sha: HEAD,
          created_at: '2026-10-09T09:00:00Z',
        },
        artifact: {
          id: 8101,
          name: 'code-health-v1',
          size_in_bytes: 3,
          created_at: '2026-10-09T10:04:00Z',
          workflow_run_id: 9321,
          workflow_run_attempt: 1,
        },
      };
      const result = await collectObjectiveReports({
        db,
        config: { enabled: true },
        clock: () => NOW,
        transport: {
          listArtifacts: async ({ repository }) => repository === 'gille-inference'
            ? { candidates: [candidate], incomplete: false }
            : { candidates: [], incomplete: false },
          downloadArtifact: async () => { throw new Error('github-scan-deadline-exceeded'); },
        },
      });
      assert.equal(result.status, 'partial');
      assert.equal(result.incomplete, true);
      const state = readObjectiveSourceState(db, {
        repoOwner: 'Magnus-Gille',
        repoName: 'gille-inference',
        enabled: true,
        configured: true,
      });
      assert.equal(state.status, 'incomplete');
      assert.equal(state.last_attempt_status, 'incomplete');
    } finally {
      db.close();
    }
  });
});
