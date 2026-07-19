'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  esc,
  formatAge,
  formatUptime,
  humanizeTaskName,
  huginTasksCard,
  taskHistoryCard,
  m5FindingsCard,
  m5ModelsCard,
  m5UsageCard,
  consolidationStatusCard,
} = require('../src/html');

describe('esc (HTML escaping)', () => {
  it('escapes &, <, >, ", \'', () => {
    assert.strictEqual(esc('&<>"\' test'), '&amp;&lt;&gt;&quot;&#39; test');
  });

  it('returns empty string for null/undefined', () => {
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(undefined), '');
  });

  it('converts numbers to strings', () => {
    assert.strictEqual(esc(42), '42');
  });

  it('handles strings with no special chars', () => {
    assert.strictEqual(esc('hello world'), 'hello world');
  });

  it('prevents XSS payloads', () => {
    const payload = '<script>alert("xss")</script>';
    const escaped = esc(payload);
    assert.ok(!escaped.includes('<script>'));
    assert.ok(escaped.includes('&lt;script&gt;'));
  });
});

describe('formatAge', () => {
  it('returns "never" for falsy input', () => {
    assert.strictEqual(formatAge(null), 'never');
    assert.strictEqual(formatAge(''), 'never');
    assert.strictEqual(formatAge(undefined), 'never');
  });

  it('returns "just now" for future timestamps', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    assert.strictEqual(formatAge(future), 'just now');
  });

  it('returns "just now" for <1min ago', () => {
    const recent = new Date(Date.now() - 30000).toISOString();
    assert.strictEqual(formatAge(recent), 'just now');
  });

  it('returns minutes for <1h', () => {
    const ts = new Date(Date.now() - 5 * 60000).toISOString();
    assert.strictEqual(formatAge(ts), '5m ago');
  });

  it('returns hours and minutes for <24h', () => {
    const ts = new Date(Date.now() - (2 * 3600000 + 30 * 60000)).toISOString();
    assert.strictEqual(formatAge(ts), '2h 30m ago');
  });

  it('returns days and hours for >=24h', () => {
    const ts = new Date(Date.now() - (26 * 3600000)).toISOString();
    assert.strictEqual(formatAge(ts), '1d 2h ago');
  });
});

describe('formatUptime', () => {
  it('returns "0s" for falsy/zero input', () => {
    assert.strictEqual(formatUptime(0), '0s');
    assert.strictEqual(formatUptime(null), '0s');
    assert.strictEqual(formatUptime(-1), '0s');
  });

  it('formats minutes only', () => {
    assert.strictEqual(formatUptime(300), '5m');
  });

  it('formats hours and minutes', () => {
    assert.strictEqual(formatUptime(7500), '2h 5m');
  });

  it('formats days and hours', () => {
    assert.strictEqual(formatUptime(90000), '1d 1h');
  });
});

describe('humanizeTaskName', () => {
  it('strips tasks/ prefix and timestamp', () => {
    assert.strictEqual(humanizeTaskName('tasks/20250301-120000-deploy-app'), 'Deploy App');
  });

  it('strips a bare date prefix for date-only task names', () => {
    // date-slug form (no time component) — the date must not leak into the label
    assert.strictEqual(humanizeTaskName('tasks/20260530-e2e77'), 'E2e77');
    assert.strictEqual(humanizeTaskName('tasks/20260402-research-foo'), 'Research Foo');
  });

  it('handles bare names', () => {
    assert.strictEqual(humanizeTaskName('run-tests'), 'Run Tests');
  });

  it('handles namespace prefix only', () => {
    assert.strictEqual(humanizeTaskName('tasks/'), '');
  });
});

describe('huginTasksCard heartbeat rendering', () => {
  const baseTasks = [{ status: 'completed', name: 'test-task', updated_at: new Date().toISOString() }];

  it('renders heartbeat status when running', () => {
    const hb = { status: 'running', polled_at: new Date().toISOString(), uptime_s: 3600, queue_depth: 2, current_task: null };
    const html = huginTasksCard(baseTasks, null, null, hb);
    assert.ok(html.includes('Running'));
    assert.ok(html.includes('heartbeat-row'));
    assert.ok(html.includes('1h 0m'));
    assert.ok(html.includes('Idle'));
  });

  it('renders stale heartbeat', () => {
    const hb = { status: 'stale', polled_at: new Date(Date.now() - 3 * 60000).toISOString(), uptime_s: 600, queue_depth: 0, current_task: null };
    const html = huginTasksCard(baseTasks, null, null, hb);
    assert.ok(html.includes('Stale'));
  });

  it('renders down heartbeat', () => {
    const hb = { status: 'down', polled_at: new Date(Date.now() - 15 * 60000).toISOString(), uptime_s: 100, queue_depth: 0, current_task: null };
    const html = huginTasksCard(baseTasks, null, null, hb);
    assert.ok(html.includes('Down'));
  });

  it('renders current task name', () => {
    const hb = { status: 'running', polled_at: new Date().toISOString(), uptime_s: 60, queue_depth: 1, current_task: 'tasks/20260321-082805-deploy-app' };
    const html = huginTasksCard(baseTasks, null, null, hb);
    assert.ok(html.includes('Deploy App'));
  });

  it('renders without heartbeat', () => {
    const html = huginTasksCard(baseTasks, null, null, null);
    assert.ok(!html.includes('heartbeat-row'));
    assert.ok(html.includes('Hugin Tasks'));
  });
});

describe('taskHistoryCard', () => {
  it('shows empty state when no terminal tasks', () => {
    const tasks = [{ status: 'running', name: 'active-task', updated_at: new Date().toISOString() }];
    const html = taskHistoryCard(tasks);
    assert.ok(html.includes('No completed tasks'));
  });

  it('renders completed tasks with checkmark', () => {
    const tasks = [
      { status: 'completed', name: 'deploy-app', updated_at: '2026-03-21T10:00:00Z', runtime: '2m30s' },
    ];
    const html = taskHistoryCard(tasks);
    assert.ok(html.includes('task-hist-ok'));
    assert.ok(html.includes('Deploy App'));
    assert.ok(html.includes('2m30s'));
    assert.ok(html.includes('Task History'));
  });

  it('renders failed tasks with failure reason', () => {
    const tasks = [
      { status: 'failed', name: 'run-tests', updated_at: '2026-03-21T10:00:00Z', runtime: '45s', failureReason: 'Timeout' },
    ];
    const html = taskHistoryCard(tasks);
    assert.ok(html.includes('task-hist-fail'));
    assert.ok(html.includes('Timeout'));
    assert.ok(html.includes('task-hist-row-fail'));
  });

  it('excludes running and pending tasks', () => {
    const tasks = [
      { status: 'running', name: 'active', updated_at: new Date().toISOString() },
      { status: 'pending', name: 'queued', updated_at: new Date().toISOString() },
      { status: 'completed', name: 'done-task', updated_at: '2026-03-21T10:00:00Z', runtime: '1m' },
    ];
    const html = taskHistoryCard(tasks);
    assert.ok(!html.includes('Active'));
    assert.ok(!html.includes('Queued'));
    assert.ok(html.includes('Done Task'));
  });

  it('shows count in header', () => {
    const tasks = [
      { status: 'completed', name: 'a', updated_at: '2026-03-21T10:00:00Z' },
      { status: 'failed', name: 'b', updated_at: '2026-03-21T09:00:00Z' },
    ];
    const html = taskHistoryCard(tasks);
    assert.ok(html.includes('(2)'));
  });

  it('handles missing runtime gracefully', () => {
    const tasks = [
      { status: 'done', name: 'no-runtime', updated_at: '2026-03-21T10:00:00Z', runtime: null },
    ];
    const html = taskHistoryCard(tasks);
    assert.ok(html.includes('—'));
  });
});

describe('m5FindingsCard (XSS regression)', () => {
  it('HTML-escapes generated bullets containing script tags', () => {
    const generated = {
      bullets: ['<script>alert(1)</script>'],
      generatedAt: new Date().toISOString(),
      model: 'mellum',
    };
    const html = m5FindingsCard([], generated);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped opening tag must be present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear');
  });
});

// ── m5ModelsCard XSS regression ──────────────────────────────────────────────
describe('m5ModelsCard (XSS regression)', () => {
  const XSS = '<script>alert(1)</script>';
  const QUOTE_BREAK = '" onmouseover="alert(2)';

  it('HTML-escapes displayName containing script tags', () => {
    const summary = {
      downloaded: [{ key: 'safe', displayName: XSS, loaded: false }],
      loaded: [],
      counts: { downloaded: 1, loaded: 0 },
    };
    const html = m5ModelsCard(summary, null);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> must be present in displayName');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in displayName');
  });

  it('HTML-escapes key when displayName is absent', () => {
    const summary = {
      downloaded: [{ key: XSS, loaded: false }],
      loaded: [],
      counts: { downloaded: 1, loaded: 0 },
    };
    const html = m5ModelsCard(summary, null);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> must be present in key');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in key');
  });

  it('HTML-escapes quantization field', () => {
    const summary = {
      downloaded: [{ key: 'safe', displayName: 'Safe', quantization: XSS, loaded: false }],
      loaded: [],
      counts: { downloaded: 1, loaded: 0 },
    };
    const html = m5ModelsCard(summary, null);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> must be present in quantization');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in quantization');
  });

  it('HTML-escapes quote-breaking payloads in displayName', () => {
    const summary = {
      downloaded: [{ key: 'safe', displayName: QUOTE_BREAK, loaded: false }],
      loaded: [],
      counts: { downloaded: 1, loaded: 0 },
    };
    const html = m5ModelsCard(summary, null);
    assert.ok(!html.includes(QUOTE_BREAK), 'raw quote-break payload must NOT appear unescaped');
    assert.ok(html.includes('&quot;'), 'quote character must be escaped');
  });

  it('HTML-escapes the error message', () => {
    const html = m5ModelsCard(null, XSS);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> in error must be present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in error');
  });
});

// ── m5UsageCard XSS regression + render ──────────────────────────────────────
describe('m5UsageCard (XSS regression + render)', () => {
  const XSS = '<script>alert(1)</script>';

  function usageWith(over) {
    return {
      models: [{ model: 'mellum', requests: 42, promptTokens: 100, completionTokens: 300, totalTokens: 400, avgDurationSec: 0.5, avgTtftSec: 0.2 }],
      totals: { requests: 42, promptTokens: 100, completionTokens: 300, totalTokens: 400, credits: 500 },
      outcomes: [{ outcome: 'ok', count: 40 }, { outcome: 'error', count: 2 }],
      admissionRejections: 3,
      rateLimited: [{ surface: 'quota', count: 4 }],
      inflight: 1,
      ...over,
    };
  }

  it('renders aggregate totals and a per-model row', () => {
    const html = m5UsageCard(usageWith({}), null);
    assert.ok(html.includes('Usage Metrics'));
    assert.ok(html.includes('mellum'), 'model name appears');
    assert.ok(html.includes('requests'), 'totals labels appear');
    // Warn chips for non-ok outcomes / rejections / rate-limits.
    assert.ok(html.includes('error: 2'));
    assert.ok(html.includes('503 busy: 3'));
    assert.ok(html.includes('429 quota: 4'));
  });

  it('HTML-escapes a malicious model label (no per-user data, but defence-in-depth)', () => {
    const html = m5UsageCard(usageWith({
      models: [{ model: XSS, requests: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, avgDurationSec: null, avgTtftSec: null }],
    }), null);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> must be present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear');
  });

  it('HTML-escapes a malicious outcome / rate-limit surface label', () => {
    const html = m5UsageCard(usageWith({
      outcomes: [{ outcome: XSS, count: 5 }],
      rateLimited: [{ surface: XSS, count: 6 }],
    }), null);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in chips');
  });

  it('HTML-escapes the error message', () => {
    const html = m5UsageCard(null, XSS);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped <script> in error must be present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must NOT appear in error');
  });

  it('renders an empty-state note when there are no requests', () => {
    const html = m5UsageCard({ totals: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, credits: 0 }, models: [], outcomes: [], admissionRejections: 0, rateLimited: [], inflight: null }, null);
    assert.ok(html.includes('No requests recorded yet'));
  });
});

describe('consolidationStatusCard', () => {
  const healthyDetail = {
    health: { available: true, circuit_breaker_tripped: false, failures: 0, max_failures: 5, last_error: null, last_error_at: null },
    telemetry: [{ tool_name: 'memory_consolidate', total_calls: 42, avg_duration_ms: 1234.6 }],
    coverage: [
      { namespace: 'projects/a', lastConsolidated: '2026-06-20T00:00:00Z', backlog: 0 },
      { namespace: 'projects/b', lastConsolidated: '2026-06-26T00:00:00Z', backlog: 3 },
    ],
  };

  it('renders Unavailable when health is null', () => {
    const html = consolidationStatusCard({ health: null });
    assert.match(html, /Unavailable/);
  });

  it('healthy state shows Healthy + failures 0/max + last synthesis + telemetry runs/avg', () => {
    const html = consolidationStatusCard(healthyDetail);
    assert.match(html, /Healthy/);
    assert.match(html, /failures 0\/5/);
    assert.match(html, /last synthesis/);
    assert.match(html, /42 runs/);
    assert.match(html, /avg 1235ms/);
  });

  it('failing state shows Failing N/max and does not show the healthy stats line', () => {
    const html = consolidationStatusCard({
      health: { available: true, circuit_breaker_tripped: false, failures: 2, max_failures: 5, last_error: 'boom', last_error_at: '2026-06-26T00:00:00Z' },
      telemetry: [], coverage: [],
    });
    assert.match(html, /Failing 2\/5/);
    assert.match(html, /Last error: boom/);
    assert.doesNotMatch(html, /last synthesis/);
  });

  it('tripped state shows TRIPPED', () => {
    const html = consolidationStatusCard({
      health: { available: false, circuit_breaker_tripped: true, failures: 5, max_failures: 5, last_error: 'dead', last_error_at: '2026-06-26T00:00:00Z' },
      telemetry: [], coverage: [],
    });
    assert.match(html, /TRIPPED/);
  });
});
