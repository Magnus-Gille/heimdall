'use strict';

/**
 * alert-engine.js — generic declarative threshold alert engine (P3 §6.2).
 *
 * Replaces the copy-pasted "N-failure streak → alert" logic in inference.js and
 * mcp-probe.js with ONE evaluator that reads declared rules from the stored
 * service descriptors (`descriptor.alerts.rules`). Runs once per collector cycle
 * (§9b), AFTER that cycle's metrics are written, so the current sample is part of
 * the streak — preserving the v1 semantics. The streak is derived from the DB
 * (not module memory), so it survives the oneshot collector process model.
 *
 * A rule: { metric, op, value, streak, severity, title, detail?, category?, host? }.
 * It FIRES when the latest `streak` samples of (host, metric) all satisfy
 * `op(value, rule.value)`; otherwise it resolves. Firing/resolving go through the
 * same createAlert/resolveAlert the rest of the system uses (dedup by host+title),
 * so the alert surface and overall-status aggregation are unchanged.
 */

const DB = require('./db');

const OPS = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function streakOf(rule) {
  return isFiniteNum(rule.streak) && rule.streak >= 1 ? Math.floor(rule.streak) : 1;
}

/**
 * Does this rule currently FIRE? Reads the latest `streak` samples of (host,
 * metric) and requires ALL of them to satisfy op(sample, rule.value). Fewer than
 * `streak` samples → does not fire (mirrors the v1 `length >= 2` guard).
 */
function recentValues(db, rule, limit, deps = {}) {
  const query = deps.queryRecent || ((host, metric, lim) =>
    db.prepare('SELECT value FROM metrics WHERE host = ? AND metric = ? ORDER BY id DESC LIMIT ?').all(host, metric, lim));
  return query(rule.host, rule.metric, limit) || [];
}

function ruleFires(db, rule, deps = {}) {
  const op = OPS[rule.op];
  if (!op) return false;
  const streak = streakOf(rule);
  const rows = recentValues(db, rule, streak, deps);
  if (rows.length < streak) return false;
  return rows.every((r) => r && isFiniteNum(r.value) && op(r.value, rule.value));
}

/**
 * Is the LATEST sample in the rule's "bad" state? Used to distinguish genuine
 * recovery (latest sample good → resolve) from a still-failing-but-sub-streak
 * sample (leave the alert as-is). This mirrors v1, which resolved only on a
 * healthy probe and did nothing while unhealthy below the streak threshold.
 */
function latestIsBad(db, rule, deps = {}) {
  const op = OPS[rule.op];
  if (!op) return false;
  const rows = recentValues(db, rule, 1, deps);
  return rows.length >= 1 && rows[0] && isFiniteNum(rows[0].value) && op(rows[0].value, rule.value);
}

// Threshold key → engine op mapping for synthesizeMetricRules.
const THRESHOLD_OPS = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

/**
 * Synthesize alert rules from a service snapshot's metrics[].warn/crit threshold
 * objects. Returns rule objects in the same shape collectAlertRules emits.
 *
 * Threshold shape (from architecture-v2.md §3.2):
 *   { lt: N } | { lte: N } | { gt: N } | { gte: N }
 * warn → severity 'warning'; crit → severity 'critical'.
 * Unrecognized threshold keys or non-finite values are skipped (lenient).
 * Titles are STABLE and VALUE-INDEPENDENT so a threshold change never orphans
 * an unresolvable alert: "${serviceLabel}: ${metricLabel} warning/critical".
 *
 * NOTE: This delivers the GENERIC ENGINE CAPABILITY. Do NOT add live warn/crit
 * thresholds to the real M5 or munin-mcp descriptors in this PR — keep their
 * metrics: [] empty. Exercise via synthetic descriptors in tests only.
 *
 * @param {object} snapshot  service snapshot: { service, descriptor }
 * @returns {object[]} normalized rule objects
 */
function synthesizeMetricRules(snapshot) {
  const d = (snapshot && snapshot.descriptor) || null;
  if (!d) return [];
  const host = (d.service && d.service.instance_id) || null;
  if (!host) return [];
  const svcLabel = (d.service && d.service.label) || (d.service && d.service.name) || snapshot.service || host;
  const metrics = Array.isArray(d.metrics) ? d.metrics : [];
  const out = [];
  for (const m of metrics) {
    if (!m || typeof m.key !== 'string') continue;
    const metricLabel = (typeof m.label === 'string' && m.label) ? m.label : m.key;
    const unit = typeof m.unit === 'string' ? m.unit : '';
    const toRule = (threshObj, severity, severityLabel) => {
      if (!threshObj || typeof threshObj !== 'object' || Array.isArray(threshObj)) return null;
      const key = Object.keys(THRESHOLD_OPS).find((k) => k in threshObj);
      if (!key) return null;
      const val = threshObj[key];
      if (!isFiniteNum(val)) return null;
      const op = THRESHOLD_OPS[key];
      return {
        host,
        metric: m.key,
        op,
        value: val,
        streak: 1,
        severity,
        title: `${svcLabel}: ${metricLabel} ${severityLabel}`,
        detail: `${metricLabel} ${op} ${val}${unit}`,
        error_metric: null,
        // Stable, metric-unique dedup identity so two metrics that share a display
        // label + severity can't resolve each other's alert (the title alone is NOT
        // unique — labels are human strings; the metric key is the unique id).
        dedup_key: `engine:metric:${host}:${m.key}:${severity}`,
        category: 'metric',
        service: snapshot.service || null,
      };
    };
    const warnRule = toRule(m.warn, 'warning', 'warning');
    if (warnRule) out.push(warnRule);
    const critRule = toRule(m.crit, 'critical', 'critical');
    if (critRule) out.push(critRule);
  }
  return out;
}

/**
 * Read the latest companion error string for a rule's host + error_metric.
 * Returns the `.error` string from the most recent row's metadata, or null.
 * Defensive: null/parse-error → null.
 * @param {object} db
 * @param {object} rule   { host, error_metric }
 * @param {object} [deps] { queryErrorMeta? }
 */
function liveErrorString(db, rule, deps = {}) {
  if (typeof rule.error_metric !== 'string' || !rule.error_metric) return null;
  try {
    const queryMeta = deps.queryErrorMeta || ((host, metric) =>
      db.prepare(
        'SELECT metadata FROM metrics WHERE host = ? AND metric = ? ORDER BY id DESC LIMIT 1',
      ).get(host, metric));
    const row = queryMeta(rule.host, rule.error_metric);
    if (!row) return null;
    let meta = row.metadata;
    if (meta == null) return null;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { return null; }
    }
    if (meta && typeof meta.error === 'string' && meta.error) return meta.error;
  } catch { /* defensive */ }
  return null;
}

/**
 * Gather alert rules from every stored service descriptor's `alerts.rules`. Each
 * rule is annotated with the host to query (the descriptor's instance_id) and the
 * owning service. Rules missing a metric or title are skipped. Synthesized rules
 * from metrics[].warn/crit are appended after the explicit rules.
 */
function collectAlertRules(db, deps = {}) {
  const getSnaps = deps.getServiceSnapshots || DB.getServiceSnapshots;
  const out = [];
  for (const snap of getSnaps(db) || []) {
    const d = (snap && snap.descriptor) || null;
    if (!d) continue;
    const rules = d.alerts && Array.isArray(d.alerts.rules) ? d.alerts.rules : [];
    const descriptorHost = (d.service && d.service.instance_id) || snap.service;
    for (const r of rules) {
      if (!r || typeof r.metric !== 'string' || typeof r.title !== 'string') continue;
      out.push({
        // Host is ALWAYS the descriptor's own instance_id — a rule cannot target
        // another service's host. This scopes create/resolve (keyed by host+title)
        // so a network-discovered descriptor can't clear another service's alert.
        host: descriptorHost,
        metric: r.metric,
        op: typeof r.op === 'string' && OPS[r.op] ? r.op : '==',
        value: isFiniteNum(r.value) ? r.value : 0,
        streak: isFiniteNum(r.streak) ? r.streak : 1,
        severity: typeof r.severity === 'string' ? r.severity : 'warning',
        title: r.title,
        detail: typeof r.detail === 'string' ? r.detail : null,
        error_metric: typeof r.error_metric === 'string' ? r.error_metric : null,
        dedup_key: typeof r.dedup_key === 'string' && r.dedup_key ? r.dedup_key : null,
        category: typeof r.category === 'string' ? r.category : 'system',
        service: snap.service,
      });
    }
    // Synthesize additional rules from per-metric warn/crit thresholds.
    for (const synth of synthesizeMetricRules(snap)) {
      out.push(synth);
    }
  }
  return out;
}

function defaultDetail(rule) {
  const streak = streakOf(rule);
  const window = streak >= 2 ? `${streak} consecutive checks` : 'the latest check';
  return `${rule.metric} ${rule.op} ${rule.value} for ${window} on ${rule.host}.`;
}

/**
 * Evaluate each rule and fire/resolve accordingly. Per-rule errors are isolated
 * so one bad rule never breaks the cycle. Returns { fired: [...], resolved: [...] }.
 */
function evaluateRules(db, rules, deps = {}) {
  const createAlertFn = deps.createAlert || DB.createAlert;
  const resolveAlertFn = deps.resolveAlert || DB.resolveAlert;
  const resolveByDedupKeyFn = deps.resolveAlertByDedupKey || DB.resolveAlertByDedupKey;
  // A swallowed alert failure means a missed alert — log by default so it's
  // visible in the collector output rather than silently lost.
  const onError = typeof deps.onError === 'function'
    ? deps.onError
    : (rule, err) => console.warn(`  Alert engine: rule "${rule && rule.title}" failed: ${(err && err.message) || err}`);
  const fired = [];
  const resolved = [];
  const pending = [];
  for (const rule of rules || []) {
    try {
      if (ruleFires(db, rule, deps)) {
        const baseDetail = rule.detail || defaultDetail(rule);
        const liveErr = liveErrorString(db, rule, deps);
        const detail = liveErr ? `${baseDetail} Last error: ${liveErr}` : baseDetail;
        createAlertFn(db, rule.host, rule.category || 'system', rule.severity || 'warning', rule.title,
          detail,
          { source: rule.service ? `engine:${rule.service}` : 'engine', dedup_key: rule.dedup_key || undefined });
        fired.push(rule.title);
      } else if (latestIsBad(db, rule, deps)) {
        // Still failing but below the streak threshold — leave any active alert
        // untouched (v1 parity: it only resolved on a genuinely healthy sample).
        pending.push(rule.title);
      } else {
        // Resolve by the rule's stable dedup_key when present (synthesized metric
        // rules, or descriptors that opt in) so two metrics sharing a display title
        // can't clear each other's alert; fall back to (host, title) otherwise.
        if (rule.dedup_key) resolveByDedupKeyFn(db, rule.dedup_key);
        else resolveAlertFn(db, rule.host, rule.title);
        resolved.push(rule.title);
      }
    } catch (err) {
      onError(rule, err);
    }
  }
  return { fired, resolved, pending };
}

/** Collector entry point (§9b): gather declared rules and evaluate them. */
function runAlertEngine(db, deps = {}) {
  return evaluateRules(db, collectAlertRules(db, deps), deps);
}

module.exports = { OPS, ruleFires, latestIsBad, collectAlertRules, evaluateRules, runAlertEngine, defaultDetail, synthesizeMetricRules };
