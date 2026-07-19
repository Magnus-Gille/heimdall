'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  openDatabase, insertMetrics, getActiveAlerts, upsertServiceSnapshot,
} = require('../src/db');
const {
  ruleFires, collectAlertRules, evaluateRules, runAlertEngine, synthesizeMetricRules,
} = require('../src/alert-engine');
const { buildM5Descriptor } = require('../src/plugins/inference');
const { buildMcpDescriptor } = require('../src/mcp-probe');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-engine-'));
  return openDatabase(path.join(dir, 'test.db'));
}
let seq = 0;
function seed(db, host, metric, value) {
  // distinct timestamps (table is unique per host+metric+timestamp); id order = insert order
  seq += 1;
  insertMetrics(db, [{ timestamp: `2026-06-17T00:00:${String(seq).padStart(2, '0')}Z`, host, metric, value, unit: 'boolean', metadata: null }]);
}
function seedMeta(db, host, metric, value, metadata) {
  seq += 1;
  insertMetrics(db, [{ timestamp: `2026-06-17T00:00:${String(seq).padStart(2, '0')}Z`, host, metric, value, unit: 'text', metadata }]);
}
function snap(db, descriptor) {
  upsertServiceSnapshot(db, {
    service: descriptor.service.name, kind: descriptor.kind, status: descriptor.status,
    descriptor, fetchedAt: new Date(0).toISOString(), reachable: true, schemaVersion: descriptor._schema, source: 'plugin', error: null,
  });
}
const DOWN_RULE = { host: 'm5', metric: 'inference_healthy', op: '==', value: 0, streak: 2, severity: 'warning', title: 'M5 inference gateway unhealthy' };

describe('alert-engine ruleFires — streak semantics (v1 parity)', () => {
  it('does not fire with fewer than `streak` samples', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    assert.equal(ruleFires(db, DOWN_RULE), false, '1 failure < streak 2');
  });

  it('fires when the latest `streak` samples all satisfy the condition', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    assert.equal(ruleFires(db, DOWN_RULE), true, '2 consecutive failures');
  });

  it('does not fire when the latest sample recovered (mixed window)', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 1); // recovered → last 2 = [1,0]
    assert.equal(ruleFires(db, DOWN_RULE), false);
  });

  it('supports comparison operators and streak 1', () => {
    const db = freshDb();
    const rule = { host: 'm5', metric: 'inference_recent_pass_rate', op: '<', value: 0.7, streak: 1 };
    seed(db, 'm5', 'inference_recent_pass_rate', 0.9);
    assert.equal(ruleFires(db, rule), false);
    seed(db, 'm5', 'inference_recent_pass_rate', 0.58);
    assert.equal(ruleFires(db, rule), true);
  });

  it('an unknown op never fires', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    assert.equal(ruleFires(db, { ...DOWN_RULE, op: '~=' }), false);
  });
});

describe('alert-engine evaluateRules — fire / resolve', () => {
  it('fires after the streak and resolves on recovery (replaces the per-probe logic)', () => {
    const db = freshDb();
    // cycle 1: one failure → no alert
    seed(db, 'm5', 'inference_healthy', 0);
    evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 0, 'no alert after 1 failure');
    // cycle 2: second failure → alert
    seed(db, 'm5', 'inference_healthy', 0);
    evaluateRules(db, [DOWN_RULE]);
    const active = getActiveAlerts(db);
    assert.equal(active.length, 1, 'alert after 2 consecutive failures');
    assert.equal(active[0].title, 'M5 inference gateway unhealthy');
    assert.equal(active[0].severity, 'warning');
    assert.equal(active[0].source, 'engine'); // no service annotation here
    // cycle 3: recovery → resolved
    seed(db, 'm5', 'inference_healthy', 1);
    evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 0, 'alert clears on recovery');
  });

  it('streak is DB-derived → survives a fresh require of the engine (oneshot model)', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    delete require.cache[require.resolve('../src/alert-engine')];
    require('../src/alert-engine').evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 0);
    seed(db, 'm5', 'inference_healthy', 0);
    delete require.cache[require.resolve('../src/alert-engine')];
    require('../src/alert-engine').evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 1, 'streak survives module reload');
  });

  it('a stale alert from before a restart clears on the next healthy sample', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 1);
    seed(db, 'm5', 'inference_healthy', 1);
    evaluateRules(db, [DOWN_RULE]); // engine has no memory of the open alert — DB drives it
    assert.equal(getActiveAlerts(db).length, 0, 'stale alert clears');
  });

  it('does NOT resolve an active alert while still failing below the streak (v1 parity)', () => {
    const db = freshDb();
    // fire (2 failures), then a window with only a sub-streak failing sample present
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 1, 'fired');
    // Simulate metric pruning leaving a single still-failing sample (< streak).
    db.prepare("DELETE FROM metrics WHERE host='m5' AND metric='inference_healthy'").run();
    seed(db, 'm5', 'inference_healthy', 0); // latest sample still bad, but only 1 row
    const res = evaluateRules(db, [DOWN_RULE]);
    assert.equal(getActiveAlerts(db).length, 1, 'alert must NOT clear while still failing below streak');
    assert.deepEqual(res.pending, ['M5 inference gateway unhealthy']);
    assert.deepEqual(res.resolved, []);
  });

  it('isolates a per-rule error so one bad rule never breaks the cycle', () => {
    const db = freshDb();
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    const errors = [];
    const res = evaluateRules(db, [DOWN_RULE], {
      createAlert: () => { throw new Error('boom'); },
      onError: (rule, err) => errors.push(err.message),
    });
    assert.equal(errors.length, 1);
    assert.deepEqual(res.fired, []); // create threw, not recorded
  });
});

describe('alert-engine collectAlertRules + runAlertEngine — descriptor-driven', () => {
  it('gathers rules from the real M5 + MCP descriptors (host = instance_id)', () => {
    const db = freshDb();
    snap(db, buildM5Descriptor());
    snap(db, buildMcpDescriptor());
    const rules = collectAlertRules(db);
    const m5 = rules.find((r) => r.title === 'M5 inference gateway unhealthy');
    const mcp = rules.find((r) => r.title === 'MCP transport unhealthy');
    assert.ok(m5 && m5.host === 'm5' && m5.metric === 'inference_healthy' && m5.streak === 2);
    assert.ok(mcp && mcp.host === 'control-node' && mcp.metric === 'mcp_healthy');
  });

  it('forces rule host = descriptor instance_id (a descriptor cannot target another service)', () => {
    const db = freshDb();
    const evil = buildM5Descriptor();
    evil.service.name = 'evil';
    evil.service.instance_id = 'evil';
    evil.alerts.rules[0].host = 'control-node'; // try to target the MCP host
    evil.alerts.rules[0].title = 'MCP transport unhealthy';
    snap(db, evil);
    const rule = collectAlertRules(db).find((r) => r.service === 'evil');
    assert.equal(rule.host, 'evil', 'host is forced to the descriptor instance_id, not the supplied host');
  });

  it('rules with no snapshots → empty (collector must self-seed the built-in descriptors)', () => {
    const db = freshDb();
    assert.deepEqual(collectAlertRules(db), [], 'no rules on a fresh DB until snapshots are seeded');
    snap(db, buildM5Descriptor());
    assert.equal(collectAlertRules(db).length, 1, 'seeding the M5 descriptor makes its rule available');
  });

  it('skips rules missing a metric or title', () => {
    const db = freshDb();
    const d = buildM5Descriptor();
    d.alerts.rules.push({ op: '==', value: 0 }); // no metric/title
    snap(db, d);
    assert.equal(collectAlertRules(db).length, 1, 'only the valid rule survives');
  });

  it('end-to-end: M5 + MCP rules fire from their descriptors via runAlertEngine', () => {
    const db = freshDb();
    snap(db, buildM5Descriptor());
    snap(db, buildMcpDescriptor());
    // two failures each
    seed(db, 'm5', 'inference_healthy', 0); seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'control-node', 'mcp_healthy', 0); seed(db, 'control-node', 'mcp_healthy', 0);
    const r = runAlertEngine(db);
    assert.equal(r.fired.length, 2);
    const titles = getActiveAlerts(db).map((a) => a.title).sort();
    assert.deepEqual(titles, ['M5 inference gateway unhealthy', 'MCP transport unhealthy']);
    // sources annotate the owning service
    assert.ok(getActiveAlerts(db).every((a) => /^engine:/.test(a.source)));
  });
});

// ── ITEM #3: live companion error string enrichment ───────────────────────────

describe('alert-engine error_metric enrichment (item #3)', () => {
  it('fired alert detail includes base static string AND live error when error_metric row has metadata.error', () => {
    const db = freshDb();
    const rule = {
      host: 'm5', metric: 'inference_healthy', op: '==', value: 0, streak: 2,
      severity: 'warning', title: 'M5 inference gateway unhealthy',
      detail: 'M5 inference gateway not responding.',
      error_metric: 'inference_error',
    };
    // seed two failing health rows so the rule fires
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    // seed the companion error metric with a metadata error string
    seedMeta(db, 'm5', 'inference_error', null, { error: 'Timeout' });
    evaluateRules(db, [rule]);
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].detail.includes('M5 inference gateway not responding.'),
      'base static string present');
    assert.ok(alerts[0].detail.includes('Timeout'), 'live error string present');
    assert.ok(alerts[0].detail.includes('Last error:'), '"Last error:" label present');
  });

  it('no error_metric on rule → detail equals base static string with no "Last error" suffix', () => {
    const db = freshDb();
    const rule = {
      host: 'm5', metric: 'inference_healthy', op: '==', value: 0, streak: 2,
      severity: 'warning', title: 'M5 inference gateway unhealthy',
      detail: 'M5 inference gateway not responding.',
      // no error_metric field
    };
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    evaluateRules(db, [rule]);
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].detail, 'M5 inference gateway not responding.');
    assert.ok(!alerts[0].detail.includes('Last error:'), 'no "Last error:" suffix');
  });

  it('error_metric present but metadata is null → detail equals base static string', () => {
    const db = freshDb();
    const rule = {
      host: 'm5', metric: 'inference_healthy', op: '==', value: 0, streak: 2,
      severity: 'warning', title: 'M5 inference gateway unhealthy',
      detail: 'M5 inference gateway not responding.',
      error_metric: 'inference_error',
    };
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    // seed companion metric with null metadata (healthy, no error recorded)
    seedMeta(db, 'm5', 'inference_error', null, null);
    evaluateRules(db, [rule]);
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].detail, 'M5 inference gateway not responding.');
  });

  it('error_metric present but no companion row at all → detail equals base static string', () => {
    const db = freshDb();
    const rule = {
      host: 'm5', metric: 'inference_healthy', op: '==', value: 0, streak: 2,
      severity: 'warning', title: 'M5 inference gateway unhealthy',
      detail: 'M5 inference gateway not responding.',
      error_metric: 'inference_error',
    };
    seed(db, 'm5', 'inference_healthy', 0);
    seed(db, 'm5', 'inference_healthy', 0);
    // no inference_error row seeded at all
    evaluateRules(db, [rule]);
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].detail, 'M5 inference gateway not responding.');
  });

  it('M5 descriptor rule carries error_metric = inference_error', () => {
    const d = buildM5Descriptor();
    const rule = d.alerts.rules[0];
    assert.equal(rule.error_metric, 'inference_error');
  });

  it('MCP descriptor rule carries error_metric = mcp_error', () => {
    const d = buildMcpDescriptor();
    const rule = d.alerts.rules[0];
    assert.equal(rule.error_metric, 'mcp_error');
  });

  it('collectAlertRules normalizes error_metric: string carried through, non-string becomes null', () => {
    const db = freshDb();
    const d = buildM5Descriptor();
    d.alerts.rules[0].error_metric = 'inference_error';
    snap(db, d);
    const rules = collectAlertRules(db);
    assert.equal(rules[0].error_metric, 'inference_error');

    const db2 = freshDb();
    const d2 = buildM5Descriptor();
    d2.alerts.rules[0].error_metric = 42; // non-string → null
    snap(db2, d2);
    const rules2 = collectAlertRules(db2);
    assert.equal(rules2[0].error_metric, null);
  });
});

// ── ITEM #4: synthesize alert rules from metrics[].warn/crit ─────────────────

describe('synthesizeMetricRules (item #4)', () => {
  // Synthetic descriptor builder for tests — NOT wired to M5/MCP
  function makeSnap(metricsArr, overrides = {}) {
    return {
      service: overrides.service || 'test-svc',
      descriptor: {
        service: {
          name: overrides.service || 'test-svc',
          label: overrides.serviceLabel || 'Test Svc',
          instance_id: overrides.instanceId || 'testhost',
        },
        metrics: metricsArr,
      },
    };
  }

  it('warn threshold lt → rule with op "<", severity "warning", streak 1, category "metric"', () => {
    const snap = makeSnap([
      { key: 'pass_rate', label: 'Pass Rate', unit: '%', warn: { lt: 70 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 1);
    const r = rules[0];
    assert.equal(r.op, '<');
    assert.equal(r.value, 70);
    assert.equal(r.severity, 'warning');
    assert.equal(r.streak, 1);
    assert.equal(r.category, 'metric');
    assert.equal(r.host, 'testhost');
    assert.equal(r.metric, 'pass_rate');
  });

  it('crit threshold lt → severity "critical"', () => {
    const snap = makeSnap([
      { key: 'pass_rate', label: 'Pass Rate', unit: '%', crit: { lt: 40 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].severity, 'critical');
    assert.equal(rules[0].op, '<');
    assert.equal(rules[0].value, 40);
  });

  it('both warn and crit → two distinct rules with distinct stable titles', () => {
    const snap = makeSnap([
      { key: 'pass_rate', label: 'Pass Rate', unit: '%', warn: { lt: 70 }, crit: { lt: 40 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 2);
    const titles = rules.map((r) => r.title);
    assert.notEqual(titles[0], titles[1], 'warn and crit titles must be distinct');
    // Titles must NOT contain the numeric threshold values (value-independence)
    for (const t of titles) {
      assert.ok(!t.includes('70') && !t.includes('40'),
        `title "${t}" must not embed threshold value`);
    }
  });

  it('gt threshold → op ">"', () => {
    const snap = makeSnap([
      { key: 'queue_depth', label: 'Queue Depth', unit: 'jobs', warn: { gt: 100 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules[0].op, '>');
    assert.equal(rules[0].value, 100);
  });

  it('lte threshold → op "<="', () => {
    const snap = makeSnap([
      { key: 'health_score', label: 'Health', unit: '', warn: { lte: 50 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules[0].op, '<=');
  });

  it('gte threshold → op ">="', () => {
    const snap = makeSnap([
      { key: 'error_rate', label: 'Errors', unit: '%', warn: { gte: 10 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules[0].op, '>=');
  });

  it('unrecognized threshold key → skipped (lenient)', () => {
    const snap = makeSnap([
      { key: 'latency', label: 'Latency', unit: 'ms', warn: { between: [10, 100] } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 0, 'unrecognized threshold key produces no rule');
  });

  it('title is STABLE and value-INDEPENDENT (threshold value not embedded)', () => {
    const snapA = makeSnap([{ key: 'pass_rate', label: 'Pass Rate', unit: '%', warn: { lt: 70 } }]);
    const snapB = makeSnap([{ key: 'pass_rate', label: 'Pass Rate', unit: '%', warn: { lt: 60 } }]);
    const rulesA = synthesizeMetricRules(snapA);
    const rulesB = synthesizeMetricRules(snapB);
    assert.equal(rulesA[0].title, rulesB[0].title, 'title is the same even when threshold changes');
    assert.notEqual(rulesA[0].value, rulesB[0].value, 'but the threshold value differs');
  });

  it('detail contains threshold value and unit', () => {
    const snap = makeSnap([
      { key: 'pass_rate', label: 'Pass Rate', unit: '%', warn: { lt: 70 } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.ok(rules[0].detail.includes('70'), 'detail includes threshold value');
    assert.ok(rules[0].detail.includes('%'), 'detail includes unit');
  });

  it('metrics with no warn/crit produce no rules', () => {
    const snap = makeSnap([
      { key: 'latency_ms', label: 'Latency', unit: 'ms' },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 0);
  });

  it('non-finite threshold value → skipped', () => {
    const snap = makeSnap([
      { key: 'latency', label: 'Latency', unit: 'ms', warn: { lt: NaN } },
    ]);
    const rules = synthesizeMetricRules(snap);
    assert.equal(rules.length, 0);
  });

  it('collectAlertRules includes synthesized metric rules alongside explicit rules', () => {
    const db = freshDb();
    // Use a descriptor that has both an explicit rule and a metric with a threshold
    const d = buildM5Descriptor();
    // Add a metric with a warn threshold
    d.metrics = [
      { key: 'inference_recent_pass_rate', label: 'Recent Pass Rate', unit: '%', warn: { lt: 70 } },
    ];
    snap(db, d);
    const rules = collectAlertRules(db);
    // Should have at least 2: the explicit rule + 1 synthesized
    const explicit = rules.filter((r) => r.title === 'M5 inference gateway unhealthy');
    const synth = rules.filter((r) => r.category === 'metric');
    assert.equal(explicit.length, 1, 'explicit rule present');
    assert.equal(synth.length, 1, 'synthesized metric rule present');
    assert.equal(synth[0].metric, 'inference_recent_pass_rate');
    assert.equal(synth[0].op, '<');
    assert.equal(synth[0].value, 70);
    assert.equal(synth[0].severity, 'warning');
    assert.equal(synth[0].host, 'm5');
  });

  it('two same-label metrics do not resolve each other (dedup_key isolation)', () => {
    const db = freshDb();
    const descriptor = {
      _schema: 2,
      kind: 'service',
      status: 'healthy',
      service: { name: 'dedup-svc', label: 'Dedup Service', instance_id: 'deduphost' },
      metrics: [
        // Both share label 'Latency' and severity 'warning' → same title under old code
        { key: 'latency_p95', label: 'Latency', unit: 'ms', warn: { gt: 500 } }, // fires (600 > 500)
        { key: 'latency_p50', label: 'Latency', unit: 'ms', warn: { gt: 100 } }, // healthy (50 < 100)
      ],
      alerts: { rules: [] },
    };
    upsertServiceSnapshot(db, {
      service: 'dedup-svc', kind: 'service', status: 'healthy',
      descriptor, fetchedAt: new Date(0).toISOString(), reachable: true,
      schemaVersion: 2, source: 'plugin', error: null,
    });
    seed(db, 'deduphost', 'latency_p95', 600); // crosses threshold → fires
    seed(db, 'deduphost', 'latency_p50', 50);  // healthy → must NOT resolve the p95 alert
    runAlertEngine(db);
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1, 'p95 alert survives; healthy p50 must not resolve it');
    assert.ok(alerts[0].dedup_key && alerts[0].dedup_key.includes('latency_p95'),
      `surviving alert dedup_key should reference latency_p95, got: ${alerts[0].dedup_key}`);
  });

  it('end-to-end: synthesized metric rule fires an alert through the engine when threshold crossed', () => {
    const db = freshDb();
    // Build a descriptor snapshot with a warn threshold on pass_rate
    const descriptor = {
      _schema: 2,
      kind: 'service',
      status: 'healthy',
      service: { name: 'synth-svc', label: 'Synth Service', instance_id: 'synthhost' },
      metrics: [
        { key: 'pass_rate', label: 'Pass rate', unit: '%', warn: { lt: 70 } },
      ],
      alerts: { rules: [] },
    };
    upsertServiceSnapshot(db, {
      service: 'synth-svc', kind: 'service', status: 'healthy',
      descriptor, fetchedAt: new Date(0).toISOString(), reachable: true,
      schemaVersion: 2, source: 'plugin', error: null,
    });
    // Seed a metric value below the warn threshold (50 < 70 → should fire)
    seed(db, 'synthhost', 'pass_rate', 50);
    // Run the engine — synthesized rule has streak 1, so one sample suffices
    const r = runAlertEngine(db);
    assert.equal(r.fired.length, 1, 'one alert fired for crossed threshold');
    const alerts = getActiveAlerts(db);
    assert.equal(alerts.length, 1, 'one active alert in db');
    const a = alerts[0];
    assert.equal(a.severity, 'warning', 'severity is warning');
    // Synthesized title: "<service label>: <metric label> warning" — value-independent
    assert.ok(a.title.toLowerCase().includes('pass rate'), `title "${a.title}" must include the metric label`);
    assert.ok(a.title.toLowerCase().includes('warning'), `title "${a.title}" must include the severity label`);
    assert.ok(!a.title.includes('70'), 'title must not embed the threshold value');
  });
});
