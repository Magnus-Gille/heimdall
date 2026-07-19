'use strict';

/**
 * memory-health.js — the Memory Health panel (#73) for /services/munin-memory.
 *
 * Pure render + rollup from the typed `fetchMemoryHealth()` result. No live data
 * here — the route supplies the result; tests drive it with the golden fixture.
 * Spec: docs/memory-health-spec.md §3.3 (thresholds) / §3.4 (layout) / §3.5
 * (service rollup) / §3.6 (unknown-vs-zero). State vocab: ok|warn|crit|stale.
 */

const { kpi, statusBadge, statusDot } = require('./components');
const { card } = require('./cards');
const { esc } = require('./util');
const T = require('../config/mem-health-thresholds');

const VALID_BREAKER = new Set(['healthy', 'tripped']);
const VALID_WORKER = new Set(['available', 'unavailable', 'disabled']);

// Real maintenance counters — NOT the v2 per-section `ok` flag (which would count
// as 1 under Object.values, falsely warning). Sum only these explicit keys.
// Only counters a human can resolve belong in the action total. retrieved_unused
// is observational retrieval telemetry: useful for diagnosis, but refreshing or
// reviewing an entry does not deterministically clear its 30-day event history.
const ACTIONABLE_MAINT_KEYS = ['active_but_stale', 'missing_status',
  'temporal_stale', 'consolidation_backlog'];

/** A v2 section is usable unless it explicitly reports `ok:false` (degraded). */
function sectionUsable(sec) {
  return !(sec && typeof sec === 'object' && sec.ok === false);
}

/** Sum the real maintenance counters; null if the block is missing/degraded. */
function maintenanceTotal(maint) {
  if (!maint || typeof maint !== 'object' || Array.isArray(maint) || maint.ok === false) return null;
  return ACTIONABLE_MAINT_KEYS.reduce((a, k) => a + (Number(maint[k]) || 0), 0);
}

/**
 * Service-status rollup (§3.5). first-match-wins: stale → crit → warn → ok.
 * @param {{status:string, payload?:object}|null} result  typed fetchMemoryHealth result
 * @returns {'ok'|'warn'|'crit'|'stale'}
 */
function memoryHealthRollup(result) {
  if (!result || result.status !== 'ok' || !result.payload) return 'stale';
  const p = result.payload;
  const emb = p.embedding || {};
  const con = p.consolidation || {};

  // A degraded core section (producer set `ok:false`) means health is unknown,
  // not healthy (§3.6) — likewise an unknown enum value (§1.3).
  if (!sectionUsable(emb) || !sectionUsable(con)
      || !VALID_BREAKER.has(emb.circuit_breaker)
      || !VALID_BREAKER.has(con.circuit_breaker)
      || !VALID_WORKER.has(con.worker)) {
    return 'stale';
  }

  const coverage = coverageState(emb);
  const synthesisAge = ageState(con.last_synthesis_at);
  if (coverage === 'stale' || (con.worker === 'available' && synthesisAge === 'stale')) {
    return 'stale';
  }

  if (coverage === 'crit'
      || (con.worker === 'available' && synthesisAge === 'crit')
      || emb.circuit_breaker === 'tripped'
      || (emb.counts && Number(emb.counts.failed) > 0)
      || con.circuit_breaker === 'tripped'
      || con.worker === 'unavailable'
      || Number(con.failures) >= Number(con.max_failures)) {
    return 'crit';
  }

  const backlogWarn = Array.isArray(con.backlog)
    && con.backlog.some((b) => Number(b.unincorporated) > Number(con.min_logs));
  const maintTotal = maintenanceTotal(p.maintenance);
  // A degraded peripheral section / partial payload is worth a warn, not a clean ok.
  if (coverage === 'warn'
      || (con.worker === 'available' && synthesisAge === 'warn')
      || Number(emb.stuck) > 0 || Number(con.failures) > 0 || backlogWarn
      || con.worker === 'disabled'
      || (maintTotal != null && maintTotal > 0)
      || p.partial === true || maintTotal == null) {
    return 'warn';
  }

  return 'ok';
}

// ─── tile state helpers (§3.3) ──────────────────────────────────────────────

/** Coverage state: ok ≥99 & 0 failed & 0 stuck; warn pending/stuck>0; crit failed>0 or <95; null→stale. */
function coverageState(emb) {
  const cov = emb.coverage_pct;
  if (cov == null || !Number.isFinite(cov)) return 'stale';
  const failed = Number(emb.counts && emb.counts.failed) || 0;
  const pending = Number(emb.counts && emb.counts.pending) || 0;
  const stuck = Number(emb.stuck) || 0;
  if (failed > 0 || cov < T.EMBEDDING_COVERAGE_CRIT_PCT) return 'crit';
  if (pending > 0 || stuck > 0 || cov < T.EMBEDDING_COVERAGE_WARN_PCT) return 'warn';
  return 'ok';
}

/** Worker enum → state. Unknown/missing → stale, never ok (§1.3/§3.6). */
function workerState(worker) {
  if (worker === 'unavailable') return 'crit';
  if (worker === 'disabled') return 'warn';
  if (worker === 'available') return 'ok';
  return 'stale';
}

/** Circuit-breaker enum → state. Unknown/missing → stale, never ok (§1.3/§3.6). */
function breakerState(b) {
  if (b === 'tripped') return 'crit';
  if (b === 'healthy') return 'ok';
  return 'stale';
}

function ageState(lastSynthesisAt) {
  if (!lastSynthesisAt) return 'stale';
  const ms = Date.parse(lastSynthesisAt);
  if (Number.isNaN(ms)) return 'stale';
  const age = Date.now() - ms;
  if (age > T.LAST_SYNTHESIS_AGE_CRIT_MS) return 'crit';
  if (age > T.LAST_SYNTHESIS_AGE_WARN_MS) return 'warn';
  return 'ok';
}

/** Human age like "1d 4h" / "5h" / "12m". */
function fmtAge(lastSynthesisAt) {
  if (!lastSynthesisAt) return '—';
  const ms = Date.parse(lastSynthesisAt);
  if (Number.isNaN(ms)) return '—';
  let s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const LEGEND_ORDER = [
  ['ok', 'healthy'], ['warn', 'warn'], ['crit', 'critical'], ['stale', 'unknown'],
];

function legend() {
  const items = LEGEND_ORDER
    .map(([s, label]) => `<span class="legend-item">${statusDot(s)}${esc(label)}</span>`)
    .join('');
  return `<div class="mem-health-legend">${items}</div>`;
}

/** A stat tile that renders muted "—" in is-stale when the value is unknown (§3.6). */
function tile(value, label, state) {
  if (state === 'stale' || value == null) return kpi('—', label, 'stale');
  return kpi(value, label, state);
}

/** Classification stacked bar — only when the block is present (§3.6). */
function classificationBar(cls) {
  if (!cls || cls.ok === false || !cls.by_level) return '';
  const order = ['public', 'internal', 'client-confidential', 'client-restricted'];
  const entries = order
    .map((k) => [k, Number(cls.by_level[k]) || 0])
    .filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  const segs = entries.map(([k, n]) =>
    `<span class="cls-seg cls-${k}" style="width:${((n / total) * 100).toFixed(1)}%" title="${esc(k)}: ${n}"></span>`).join('');
  const keys = entries.map(([k, n]) =>
    `<span class="cls-key"><span class="cls-dot cls-${esc(k)}"></span>${esc(k)} ${n}</span>`).join('');
  return `<div class="mem-cls">
    <div class="mem-cls-label">Classification</div>
    <div class="cls-bar">${segs}</div>
    <div class="cls-keys">${keys}</div>
  </div>`;
}

function countValue(section, key) {
  if (!section || typeof section !== 'object' || section.ok === false) return null;
  const value = Number(section[key]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function formatCount(value) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number).toLocaleString('en-US') : '—';
}

function formatPercent(fraction) {
  if (fraction == null || fraction === '') return '—';
  const number = Number(fraction);
  if (!Number.isFinite(number)) return '—';
  return `${(number * 100).toFixed(2).replace(/\.00$/, '')}%`;
}

function formatDuration(ms) {
  if (ms == null || ms === '') return '—';
  const number = Number(ms);
  if (!Number.isFinite(number)) return '—';
  if (number < 1000) return `${Math.round(number)}ms`;
  return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}s`;
}

function operationalSummaryState(emb, con) {
  if (!sectionUsable(emb) || !sectionUsable(con)
      || !VALID_BREAKER.has(emb.circuit_breaker)
      || !VALID_BREAKER.has(con.circuit_breaker)
      || !VALID_WORKER.has(con.worker)) return 'stale';

  const coverage = coverageState(emb);
  const synthesisAge = ageState(con.last_synthesis_at);
  if (coverage === 'stale' || synthesisAge === 'stale') return 'stale';
  if (coverage === 'crit' || synthesisAge === 'crit'
      || emb.circuit_breaker === 'tripped'
      || con.circuit_breaker === 'tripped'
      || con.worker === 'unavailable'
      || Number(con.failures) >= Number(con.max_failures)) return 'crit';

  const backlog = Array.isArray(con.backlog)
    && con.backlog.some(item => Number(item.unincorporated) > Number(con.min_logs));
  if (coverage === 'warn' || synthesisAge === 'warn' || con.worker === 'disabled'
      || Number(con.failures) > 0 || backlog) return 'warn';
  return 'ok';
}

function attentionItemsFor(attention, category) {
  if (!attention || attention.status !== 'ok' || !attention.payload
      || !Array.isArray(attention.payload.items)) return null;
  return attention.payload.items.filter((item) => item.category === category);
}

function compactPreview(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function attentionItemRows(items, decisionPrompt) {
  if (!Array.isArray(items)) {
    return `<div class="mem-action-unavailable">Exact item list unavailable. Reload before reviewing.</div>`;
  }
  if (items.length === 0) return '';
  return `<ul class="mem-attention-items">${items.map((item) => {
    const preview = compactPreview(item.preview);
    const untrusted = item.untrusted_content === true ? '<span class="mem-untrusted">untrusted content</span>' : '';
    return `<li><div class="mem-attention-head"><code>${esc(item.namespace)}</code>` +
      `<span>updated ${esc(fmtAge(item.updated_at))}</span>${untrusted}</div>` +
      `${preview ? `<p>${esc(preview)}</p>` : ''}<small>${esc(decisionPrompt)}</small></li>`;
  }).join('')}</ul>`;
}

function reviewGroup({ count, title, hint, category, attention, decisionPrompt }) {
  if (!count) return '';
  const items = attentionItemsFor(attention, category);
  const detail = attentionItemRows(items, decisionPrompt);
  const coverage = Array.isArray(items) && items.length !== count
    ? `<div class="mem-action-unavailable">Showing ${formatCount(items.length)} of ${formatCount(count)} current items.</div>`
    : '';
  return `<li class="mem-action-group"><details><summary><span class="mem-action-count">${formatCount(count)}</span>` +
    `<span class="mem-action-copy"><strong>${esc(title)}</strong><small>${esc(hint)}</small></span>` +
    `<span class="mem-action-open">Review</span></summary>${coverage}${detail}</details></li>`;
}

function retrievalQualitySignal(maint) {
  const unused = countValue(maint, 'retrieved_unused');
  if (!unused) return '';
  return `<section class="mem-quality"><div class="mem-section-title">Retrieval quality signal</div>` +
    `<details><summary>${formatCount(unused)} memories repeatedly surfaced without recorded use</summary>` +
    `<p>This is diagnostic telemetry, not an action backlog. Preview-only use and missing client feedback can create false positives, so it does not affect the Attention total or service warning.</p>` +
    `<small>Use memory_insights or memory_patterns when investigating retrieval quality; do not delete memories merely to make this number zero.</small></details></section>`;
}

function maintenanceActions(maint, attention) {
  const total = maintenanceTotal(maint);
  if (total == null) {
    return `<section class="mem-actions is-stale"><div class="mem-section-title">Needs attention</div>` +
      `<div class="mem-empty">Maintenance details unavailable.</div></section>`;
  }

  const consolidation = countValue(maint, 'consolidation_backlog');
  const temporal = countValue(maint, 'temporal_stale');
  const missing = countValue(maint, 'missing_status');
  const stale = countValue(maint, 'active_but_stale');

  const rows = [];
  if (consolidation) {
    rows.push(`<li><span class="mem-action-count">${formatCount(consolidation)}</span><span class="mem-action-copy">` +
      `<strong>Review ${formatCount(consolidation)} consolidation backlog ${consolidation === 1 ? 'namespace' : 'namespaces'}</strong>` +
      `<small>Logs are waiting to be synthesized.</small></span>` +
      `<a class="mem-action-link" href="/services/munin-memory/consolidation">Open consolidation</a></li>`);
  }
  rows.push(reviewGroup({
    count: temporal,
    title: `Update ${formatCount(temporal)} statuses with past-due plans`,
    hint: 'The status still describes a date that has passed.',
    category: 'temporal_stale', attention,
    decisionPrompt: 'Choose: replace the past-due plan with current truth, or change lifecycle.',
  }));
  rows.push(reviewGroup({
    count: missing,
    title: `Add status to ${formatCount(missing)} tracked namespaces`,
    hint: 'Each needs a create, merge, or archive decision.',
    category: 'missing_status', attention,
    decisionPrompt: 'Choose: create a status, merge into a canonical namespace, or archive.',
  }));
  rows.push(reviewGroup({
    count: stale,
    title: `Refresh or close ${formatCount(stale)} stale active statuses`,
    hint: 'They have not been updated in more than 14 days.',
    category: 'active_but_stale', attention,
    decisionPrompt: 'Choose: keep active and refresh, or change lifecycle to maintenance, completed, stopped, or archived.',
  }));

  const renderedRows = rows.filter(Boolean);
  const body = renderedRows.length > 0
    ? `<ul class="mem-action-list">${renderedRows.join('')}</ul>`
    : `<div class="mem-empty is-ok">No maintenance actions.</div>`;
  return `<section class="mem-actions"><div class="mem-section-title">Needs attention` +
    `${total > 0 ? ` <span>${formatCount(total)}</span>` : ''}</div>${body}</section>`;
}

function securitySummary(security, classification) {
  if (!sectionUsable(security) || !security || !sectionUsable(classification) || !classification) {
    return `<section class="mem-security is-stale"><div class="mem-section-title">Protections triggered · 7 days</div>` +
      `<div class="mem-empty">Security counters unavailable.</div></section>`;
  }
  const red7 = countValue(security, 'redaction_events_7d');
  const red30 = countValue(security, 'redaction_events_30d');
  const zone7 = countValue(security, 'cross_zone_blocks_7d');
  const zone30 = countValue(security, 'cross_zone_blocks_30d');
  const denied7 = countValue(classification, 'access_denied_7d');
  const item = (value7, label, value30) => `<div class="mem-security-item"><strong>${formatCount(value7)} ${esc(label)}</strong>` +
    (value30 == null ? '' : `<small>${formatCount(value30)} in 30 days</small>`) + `</div>`;
  return `<section class="mem-security"><div class="mem-section-title">Protections triggered · 7 days</div>` +
    `<div class="mem-security-grid">${item(red7, 'secret redactions', red30)}` +
    `${item(zone7, 'cross-zone blocks', zone30)}${item(denied7, 'denied requests', null)}</div></section>`;
}

function technicalDetails(payload, emb, con) {
  const size = payload.size;
  const retrieval = payload.retrieval;
  const lines = [];

  if (sectionUsable(size) && size) {
    lines.push(`<div class="mem-detail-line"><span>Store</span><strong>${formatCount(size.entries_total)} entries</strong>` +
      `<small>${formatCount(size.entries_state)} state · ${formatCount(size.entries_log)} log · ` +
      `${formatCount(size.namespace_count)} namespaces</small></div>`);
  }
  if (sectionUsable(retrieval) && retrieval) {
    const mix = retrieval.mode_mix || {};
    lines.push(`<div class="mem-detail-line mem-retrieval"><span>Retrieval</span>` +
      `<strong>${formatCount(retrieval.query_volume_7d)} queries / 7d · ${formatCount(retrieval.query_volume_30d)} / 30d</strong>` +
      `<small>p50 ${formatDuration(retrieval.latency_p50_ms)} · p95 ${formatDuration(retrieval.latency_p95_ms)} · ` +
      `${formatPercent(mix.hybrid)} hybrid · ${formatPercent(mix.lexical)} lexical · ${formatPercent(mix.semantic)} semantic</small></div>`);
  }

  const model = emb.model ? `${esc(emb.model)}${emb.dtype ? ` / ${esc(emb.dtype)}` : ''}` : 'unknown';
  const reembed = emb.reembed_in_progress ? ` ${statusBadge('warn', 're-embed in progress')}` : '';
  lines.push(`<div class="mem-detail-line"><span>Engine</span><strong><span class="mono">${model}</span>${reembed}</strong>` +
    `<small>worker ${statusBadge(workerState(con.worker), con.worker || 'unknown')} · embedder ` +
    `${statusBadge(breakerState(emb.circuit_breaker), emb.circuit_breaker || 'unknown')} · ` +
    `avg synthesis ${formatDuration(con.avg_latency_ms)}</small></div>`);

  if (con.last_error) {
    lines.push(`<div class="mem-detail-line is-warn"><span>Last consolidation error</span>` +
      `<strong>${esc(con.last_error)}</strong><small>${esc(con.last_error_at || 'time unknown')}</small></div>`);
  }

  return `<details class="mem-details"><summary>Technical details</summary><div class="mem-detail-grid">` +
    `${lines.join('')}${classificationBar(payload.classification)}${legend()}</div></details>`;
}

/**
 * Render the Memory Health card from a typed fetchMemoryHealth result.
 * @param {{status:string, payload?:object, servedFromCache?:boolean}|null} result
 * @param {{status:string, payload?:{items?:object[]}}|null} attention
 * @returns {string} HTML (a full card)
 */
function memoryHealthCard(result, attention = null) {
  // Degraded: no green tiles without live data (§3.6). Show a banner; if a cached
  // payload is present, the banner notes it's last-known.
  if (!result || result.status !== 'ok' || !result.payload) {
    const status = result ? result.status : 'no-data';
    const cached = result && result.servedFromCache ? ' Showing last-known values.' : '';
    return card({
      title: 'Memory Health',
      fullWidth: true,
      body: `<div class="mem-health-degraded is-stale">Memory Health data unavailable (${esc(status)}).${esc(cached)}</div>${legend()}`,
    });
  }

  const p = result.payload;
  const emb = p.embedding || {};
  const con = p.consolidation || {};

  // Section usability — a producer `ok:false` section renders stale, not healthy (§3.6).
  const embOk = sectionUsable(emb);
  const conOk = sectionUsable(con);

  // Coverage
  const covState = embOk ? coverageState(emb) : 'stale';
  const covVal = (!embOk || emb.coverage_pct == null) ? '—' : `${Number(emb.coverage_pct).toFixed(2)}%`;

  // Embedding queue — fold the stuck count in so it's visible. A missing/invalid
  // counts block (or a degraded embedding section) renders stale, not a green 0/0/0 (§3.6).
  const counts = emb.counts;
  const hasCounts = counts && typeof counts === 'object'
    && ['pending', 'processing', 'failed'].every((k) => Number.isFinite(Number(counts[k])));
  const stuck = Number(emb.stuck) || 0;
  let queueState; let queueVal; let queueLabel;
  if (!embOk || !hasCounts) {
    queueState = 'stale'; queueVal = '—'; queueLabel = 'Queue (p/proc/fail)';
  } else {
    queueState = (Number(counts.failed) > 0) ? 'crit' : (stuck > 0 ? 'warn' : 'ok');
    queueVal = `${Number(counts.pending) || 0}/${Number(counts.processing) || 0}/${Number(counts.failed) || 0}`;
    queueLabel = stuck > 0 ? `Queue · ${stuck} stuck` : 'Queue (p/proc/fail)';
  }

  // Last synthesis age
  const synthState = conOk ? ageState(con.last_synthesis_at) : 'stale';

  // Backlog total — only meaningful when the consolidation section is usable AND the
  // producer says the list is complete (§3.6).
  let backlogState; let backlogVal;
  if (!conOk || con.backlog_complete === false || !Array.isArray(con.backlog)) {
    backlogState = 'stale'; backlogVal = '—';
  } else {
    const sum = con.backlog.reduce((a, b) => a + (Number(b.unincorporated) || 0), 0);
    const over = con.backlog.some((b) => Number(b.unincorporated) > Number(con.min_logs));
    backlogState = over ? 'warn' : 'ok'; backlogVal = String(sum);
  }

  // Attention total — sum only real maintenance counters (NOT the section `ok` flag);
  // a missing/degraded maintenance block renders stale, not green 0 (§3.6).
  const attnTotal = maintenanceTotal(p.maintenance);
  const attnState = attnTotal == null ? 'stale' : (attnTotal > 0 ? 'warn' : 'ok');
  const attnVal = attnTotal == null ? '—' : String(attnTotal);

  const tiles = [
    tile(covVal, 'Coverage', covState),
    tile(queueVal, queueLabel, queueState),
    tile(conOk ? fmtAge(con.last_synthesis_at) : '—', 'Last synthesis', synthState),
    tile(backlogVal, 'Backlog', backlogState),
    tile(attnVal, 'Attention', attnState),
  ].join('');

  // Partial-payload banner (§3.6): the producer emits `partial:true` when a section
  // failed; surface it so a degraded payload never looks fully healthy.
  const partialBanner = p.partial === true
    ? `<div class="mem-health-degraded is-stale">Partial data — some sections were unavailable from Munin.</div>`
    : '';

  const summaryState = operationalSummaryState(emb, con);
  const summaryText = summaryState === 'crit'
    ? 'Memory needs intervention. Search or consolidation is degraded.'
    : (summaryState === 'stale'
      ? 'Memory health is incomplete. Treat the values below as uncertain.'
      : `Memory is working${summaryState === 'warn' ? ' with operational warnings' : ''}.` +
        `${attnTotal > 0 ? ` ${formatCount(attnTotal)} maintenance items need review.` : ' No maintenance actions are open.'}`);

  const body = `${partialBanner}<div class="mem-health-summary is-${summaryState}">${esc(summaryText)}</div>
    <div class="mem-tiles">${tiles}</div>
    ${maintenanceActions(p.maintenance, attention)}
    ${retrievalQualitySignal(p.maintenance)}
    ${securitySummary(p.security_events, p.classification)}
    ${technicalDetails(p, emb, con)}`;

  return card({ title: 'Memory Health', fullWidth: true, body });
}

module.exports = { memoryHealthRollup, memoryHealthCard };
