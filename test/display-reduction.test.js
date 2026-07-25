'use strict';

/**
 * Display-reduction tests (issue #3, "Simplify … around actionable state").
 *
 * The owner's complaint: "the info display is often bloated and not very
 * helpful". The rules pinned here:
 *
 *   1. UNKNOWN IS NOT BAD. A deployment whose drift cannot be measured must be
 *      visually distinct from one that is genuinely behind, and must not colour
 *      the "Services behind" KPI. The live dashboard showed five such rows —
 *      munin-memory, mimir, skuld, brokkr-* and tallriksvis — as drift.
 *   2. THE DEFAULT VIEW SHOWS ONLY WHAT YOU CAN ACT ON. Healthy and
 *      not-measurable rows collapse to one summary line instead of a card each.
 *   3. FINDINGS ARE A RESULT, NOT A FAILURE. A job that ran and found things is
 *      shown as a finding count, not as a red failed service.
 *   4. NO CONTRADICTORY LABELS. A timer has no endpoint by design; calling it
 *      "unreachable" while its status is "pass" is noise, not information.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeployRows, deploysGridFragment, buildOverviewStatus,
} = require('../src/render/overview');

const row = (o) => ({ host: 'control-node', ...o });

describe('buildDeployRows — unknown is distinct from behind', () => {
  it('never renders the legacy -1 sentinel as drift', () => {
    const [r] = buildDeployRows([row({ service: 'ratatoskr', deployed_commit: '6ff0610', latest_commit: '2a2ce05', commits_behind: -1 })]);
    assert.notStrictEqual(r.state, 'warn', 'a -1 count is an instrumentation failure, not drift');
    assert.strictEqual(r.state, 'stale');
  });

  it('marks an unmeasurable deployment as unknown, with a reason', () => {
    const [r] = buildDeployRows([row({
      service: 'munin-memory', deployed_commit: 'ok', latest_commit: '2eaa4e5',
      commits_behind: null, drift_state: 'unknown', drift_reason: 'deployed version "ok" is not a commit',
    })]);
    assert.strictEqual(r.state, 'stale');
    assert.match(r.reason, /not a commit/);
  });

  it('reports real drift with its real count', () => {
    const [r] = buildDeployRows([row({ service: 'hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' })]);
    assert.strictEqual(r.state, 'warn');
    assert.strictEqual(r.behind, 4);
  });

  it('does not call an ahead-of-main deployment "behind"', () => {
    const [r] = buildDeployRows([row({ service: 'x', deployed_commit: 'aaaaaaa', latest_commit: 'bbbbbbb', commits_behind: 0, drift_state: 'ahead' })]);
    assert.strictEqual(r.state, 'ok');
  });

  it('never emits a negative behind count to the renderer', () => {
    for (const rr of buildDeployRows([
      row({ service: 'a', deployed_commit: 'x', latest_commit: 'y', commits_behind: -1 }),
      row({ service: 'b', deployed_commit: 'aaaaaaa', latest_commit: 'bbbbbbb', commits_behind: -1 }),
    ])) {
      assert.ok(rr.behind === null || rr.behind >= 0, `behind must be null or >= 0, got ${rr.behind}`);
    }
  });
});

describe('buildOverviewStatus — unknown does not inflate the KPI', () => {
  const versions = [
    row({ service: 'hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' }),
    row({ service: 'munin-memory', deployed_commit: 'ok', latest_commit: '2eaa4e5', drift_state: 'unknown' }),
    row({ service: 'tallriksvis', deployed_commit: null, latest_commit: null, drift_state: 'unknown' }),
    row({ service: 'heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' }),
  ];

  it('counts only genuine drift as "behind"', () => {
    const s = buildOverviewStatus({ versions });
    assert.strictEqual(s.svcDrift, 1);
  });

  it('counts the unmeasurable ones separately', () => {
    const s = buildOverviewStatus({ versions });
    assert.strictEqual(s.svcUnmeasurable, 2);
  });

  it('does not treat an unmeasurable deployment as "attention needed"', () => {
    const s = buildOverviewStatus({
      versions: [row({ service: 'munin-memory', deployed_commit: 'ok', latest_commit: '2eaa4e5', drift_state: 'unknown' })],
    });
    assert.strictEqual(s.svcDrift, 0);
    assert.strictEqual(s.allHealthy, true, 'a measurement gap is not an outage');
  });
});

describe('deploysGridFragment — default view shows only actionable rows', () => {
  const versions = [
    row({ service: 'hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' }),
    row({ service: 'heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' }),
    row({ service: 'heimdall-collect', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' }),
    row({ service: 'munin-memory', deployed_commit: 'ok', latest_commit: '2eaa4e5', drift_state: 'unknown', drift_reason: 'no .git in deploy path' }),
  ];

  it('renders a card only for the drifting service', () => {
    const html = deploysGridFragment(versions, { exceptionsOnly: true });
    assert.match(html, /hugin/);
    assert.doesNotMatch(html, /heimdall-collect/, 'healthy rows must not each get a card');
  });

  it('collapses the healthy and unmeasurable rows into ONE summary line', () => {
    const html = deploysGridFragment(versions, { exceptionsOnly: true });
    assert.match(html, /2 up to date/);
    assert.match(html, /1 not measurable/);
  });

  it('says so plainly when nothing is drifting', () => {
    const html = deploysGridFragment(
      [row({ service: 'heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' })],
      { exceptionsOnly: true },
    );
    assert.match(html, /No deployment drift/);
  });

  it('labels an unmeasurable deployment honestly in the full view', () => {
    const html = deploysGridFragment(versions);
    assert.match(html, /not measurable/i);
    assert.doesNotMatch(html, /-1/);
  });
});

describe('service rendering — timers read as jobs, not as broken endpoints', () => {
  const { serviceView, stateLabel, serviceCard } = require('../src/render/service-page');

  const timerSnap = (timer, status) => ({
    service: 'grimnir-validate', kind: 'timer', status, reachable: 0, source: 'config',
    fetchedAt: '2026-07-25T18:00:00Z',
    descriptor: { service: { name: 'grimnir-validate', label: 'grimnir-validate' }, kind: 'timer', status, metrics: [], panels: [], timer },
  });

  it('shows a completed-with-findings run as a finding count, not a failure', () => {
    const v = serviceView(timerSnap({ lastRun: '2026-07-25T04:31:00Z', lastResult: 'exit 1', outcome: 'findings', findings: 2 }, 'pass'));
    assert.strictEqual(v.state, 'ok', 'the JOB succeeded — it is not a degraded service');
    assert.match(stateLabel(v), /2 findings/i);
  });

  it('still shows a job that could not run as failed', () => {
    const v = serviceView(timerSnap({ lastRun: '2026-07-25T05:02:28Z', lastResult: 'exit 1', outcome: 'failed' }, 'fail'));
    assert.strictEqual(v.state, 'crit');
    assert.match(stateLabel(v), /failed/i);
  });

  it('never describes a timer as "unreachable" — it has no endpoint by design', () => {
    const html = serviceCard(timerSnap({ lastRun: '2026-07-25T17:00:00Z', lastResult: 'ok', outcome: 'ok' }, 'pass'));
    assert.doesNotMatch(html, /unreachable/i);
    assert.doesNotMatch(html, /Config-only/i);
  });
});

describe('overview findings line — findings are a result, not an alert', () => {
  const { findingsFromSnapshots, findingsFragment } = require('../src/render/overview');

  const timerSnap = (service, timer) => ({
    service, kind: 'timer', status: 'pass', reachable: 0, source: 'config',
    descriptor: { service: { name: service, label: service }, kind: 'timer', status: 'pass', metrics: [], panels: [], timer },
  });

  it('collects jobs that ran and reported findings', () => {
    const out = findingsFromSnapshots([
      timerSnap('grimnir-validate', { lastRun: '2026-07-25T04:31:00Z', outcome: 'findings', findings: 2 }),
      timerSnap('heimdall-collect', { lastRun: '2026-07-25T17:55:00Z', outcome: 'ok' }),
      timerSnap('brokkr-maintenance-os', { lastRun: '2026-07-25T05:02:28Z', outcome: 'failed' }),
    ]);
    assert.deepStrictEqual(out.map((f) => f.service), ['grimnir-validate']);
    assert.strictEqual(out[0].count, 2);
  });

  it('renders findings as a count, in a non-alarming state', () => {
    const html = findingsFragment([{ service: 'grimnir-validate', count: 2, lastRun: '2026-07-25T04:31:00Z' }]);
    assert.match(html, /grimnir-validate/);
    assert.match(html, /2 findings/);
    assert.doesNotMatch(html, /is-crit/, 'findings are not a critical service state');
  });

  it('renders nothing at all when there are no findings', () => {
    assert.strictEqual(findingsFragment([]), '');
  });
});

describe('descriptor storage — no empty scaffolding', () => {
  const { compactDescriptor } = require('../src/db');

  it('drops empty metrics/panels arrays rather than storing "metrics":[],"panels":[]', () => {
    // Every service on the live instance carried these empty arrays in its
    // stored descriptor blob. They carry no information; the renderer already
    // defaults an absent array to [].
    const out = compactDescriptor({
      service: { name: 'x' }, kind: 'timer', status: 'pass', metrics: [], panels: [],
    });
    assert.ok(!('metrics' in out));
    assert.ok(!('panels' in out));
    assert.strictEqual(out.kind, 'timer');
  });

  it('keeps arrays that actually have content', () => {
    const out = compactDescriptor({ service: { name: 'x' }, metrics: [{ key: 'a' }], panels: [] });
    assert.strictEqual(out.metrics.length, 1);
    assert.ok(!('panels' in out));
  });

  it('drops null-valued optional keys but never the required ones', () => {
    const out = compactDescriptor({ service: { name: 'x' }, kind: 'timer', status: null, version: null, deploy: null });
    assert.ok(!('version' in out));
    assert.ok(!('deploy' in out));
    assert.deepStrictEqual(out.service, { name: 'x' });
  });

  it('passes through non-objects untouched', () => {
    assert.strictEqual(compactDescriptor(null), null);
  });
});

describe('service contract schema id', () => {
  const { SCHEMA_ID } = require('../src/contract/schema');
  it('is not an example.com placeholder', () => {
    assert.doesNotMatch(SCHEMA_ID, /example\.(com|org|net)/,
      'a documentation placeholder should not ship as the production schema id');
  });
  it('still identifies the v1 service contract', () => {
    assert.match(SCHEMA_ID, /\/service\/v1$/);
  });
});
