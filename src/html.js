'use strict';

/**
 * HTML escaping utility — used for ALL dynamic content in templates.
 * Prevents stored XSS from task output, event details, or any data
 * that may contain HTML-significant characters.
 */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAge(isoTimestamp) {
  if (!isoTimestamp) return 'never';
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function formatAgeWithTimestamp(isoTimestamp) {
  if (!isoTimestamp) return 'never';
  return `<time datetime="${esc(isoTimestamp)}" title="${esc(isoTimestamp)}">${esc(formatAge(isoTimestamp))}</time>`;
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function humanizeTaskName(taskNameOrNamespace) {
  const slug = String(taskNameOrNamespace).replace(/^tasks\//, '');
  // Strip the date(-time) prefix: `YYYYMMDD-HHmmss-` (date-time-slug) or a bare
  // `YYYYMMDD-` (date-slug, e.g. tasks/20260530-e2e77) so the date never leaks into the label.
  const name = slug.replace(/^\d{8}-\d{6}-/, '').replace(/^\d{8}-/, '');
  if (!name) return slug;
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const M5_VERDICT_BADGE = {
  viable: { cls: 'm5-badge-viable', label: 'viable' },
  marginal: { cls: 'm5-badge-marginal', label: 'marginal' },
  not_viable: { cls: 'm5-badge-notviable', label: 'not viable' },
  unknown: { cls: 'm5-badge-unknown', label: 'unknown' },
};

function m5StatusCard(metrics) {
  if (!metrics || metrics.inference_healthy == null) {
    return '<h3>M5 Status</h3><div class="proc-empty">No data yet — collector has not polled the gateway.</div>';
  }
  const healthy = metrics.inference_healthy === 1;
  const dot = healthy
    ? '<span class="status-dot online">●</span>'
    : '<span class="status-dot offline">●</span>';
  const statusLabel = healthy ? 'Online' : 'Down';
  const lastAge = metrics.lastCollected ? formatAge(metrics.lastCollected) : 'never';
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
  const num = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);
  return `
    <h3>M5 Status</h3>
    <div class="metric-row"><span class="metric-label">Gateway</span> <span class="metric-value">${dot} ${statusLabel}</span></div>
    <div class="metric-row"><span class="metric-label">Probe latency</span> <span class="metric-value">${num(metrics.inference_latency_ms, 'ms')}</span></div>
    <div class="metric-row"><span class="metric-label">Tracked pairs</span> <span class="metric-value">${num(metrics.inference_ledger_pairs)}</span></div>
    <div class="metric-row"><span class="metric-label">Recent pass rate</span> <span class="metric-value" title="Verified outcomes only — unverified delegations (no deterministic verifier) are excluded, not counted as failures.">${pct(metrics.inference_recent_pass_rate)}${metrics.inference_recent_unverified_count ? ` <span class="metric-note">(+${esc(String(metrics.inference_recent_unverified_count))} unverified)</span>` : ''}</span></div>
    <div class="metric-row"><span class="metric-label">Throughput</span> <span class="metric-value">${num(metrics.inference_avg_tok_per_sec, ' tok/s')}</span></div>
    <div class="metric-row"><span class="metric-label">Checked</span> <span class="metric-value">${esc(lastAge)}</span></div>
  `;
}

// matrix: { taskTypes, models, cells } from m5.ledgerToMatrix(); error: optional string.
function m5CapabilityMapCard(matrix, error) {
  if (error) {
    return `<h3>Capability Map</h3>
      <div class="m5-note">Ledger unavailable — ${esc(error)}. The gateway may be offline or unreachable from Heimdall's host.</div>`;
  }
  if (!matrix || !matrix.taskTypes || matrix.taskTypes.length === 0) {
    return `<h3>Capability Map</h3>
      <div class="m5-note">No ledger rows yet — the M5 has not recorded any (task_type × model) verdicts.</div>`;
  }

  const headerCols = matrix.models
    .map((m) => `<th class="m5-col-model">${esc(m)}</th>`)
    .join('');

  const bodyRows = matrix.taskTypes.map((tt) => {
    const cellsHtml = matrix.models.map((model) => {
      const c = matrix.cells[tt] && matrix.cells[tt][model];
      if (!c) return '<td class="m5-cell"><span class="m5-badge m5-badge-unknown">—</span></td>';
      const badge = M5_VERDICT_BADGE[c.verdict] || M5_VERDICT_BADGE.unknown;
      const passPct = c.successRate == null ? '—' : `${Math.round(c.successRate * 100)}%`;
      const tps = c.tokPerSec == null ? '' : ` · ${c.tokPerSec} tok/s`;
      const lock = c.frozen ? ' 🔒' : '';
      const title = `${esc(tt)} × ${esc(model)}: ${badge.label}, ${passPct} pass${tps}${c.frozen ? ', frozen' : ''}`;
      return `<td class="m5-cell"><span class="m5-badge ${badge.cls}" title="${title}">${passPct}${esc(tps)}${lock}</span></td>`;
    }).join('');
    return `<tr><td class="m5-row-task">${esc(tt)}</td>${cellsHtml}</tr>`;
  }).join('');

  return `
    <h3>Capability Map <span class="m5-subtitle">task type × model — live from /ledger</span></h3>
    <div class="m5-legend">
      <span class="m5-badge m5-badge-viable">viable</span>
      <span class="m5-badge m5-badge-marginal">marginal</span>
      <span class="m5-badge m5-badge-notviable">not viable</span>
      <span class="m5-badge m5-badge-unknown">unknown</span>
      <span class="m5-legend-note">🔒 = frozen (latched) · cell shows pass% · tok/s</span>
    </div>
    <div class="m5-matrix-wrap">
      <table class="m5-matrix">
        <thead><tr><th class="m5-col-task">Task type</th>${headerCols}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

// staticFindings: string[] (HTML-safe, pre-escaped headline conclusions).
// generated: { bullets: string[], generatedAt, model } | null (the M5-generated, validated summary).
function m5FindingsCard(staticFindings, generated) {
  const headlines = (staticFindings || [])
    .map((f) => `<li>${f}</li>`) // STATIC_FINDINGS are authored as safe HTML (strong/&amp; entities)
    .join('');

  let generatedHtml;
  if (generated && Array.isArray(generated.bullets) && generated.bullets.length) {
    const bullets = generated.bullets.map((b) => `<li>${esc(b)}</li>`).join('');
    const stamp = generated.generatedAt ? formatAge(generated.generatedAt) : 'just now';
    generatedHtml = `
      <div class="m5-generated">
        <div class="m5-generated-head">Fresh takeaways</div>
        <ul class="m5-generated-list">${bullets}</ul>
        <div class="m5-generated-foot">✨ generated by the M5 (${esc(generated.model || 'mellum')}) · ${esc(stamp)}</div>
      </div>`;
  } else {
    generatedHtml = `
      <div class="m5-generated m5-generated-empty">
        <div class="m5-generated-foot">✨ live M5 summary unavailable right now — showing verified findings only.</div>
      </div>`;
  }

  return `
    <h3>What We Learned <span class="m5-subtitle">verified over the RQ5 battery</span></h3>
    <ul class="m5-findings">${headlines}</ul>
    ${generatedHtml}
  `;
}

// profile-based view (from docs/m5-routing.json) OR derived hint (from live ledger).
// snapshot: parsed m5-routing.json | null; derived: deriveRoutingFromLedger() rows | null; error: string.
function m5RoutingCard(snapshot, derived, error) {
  if (snapshot) {
    const profiles = Object.entries(snapshot.modelProfiles || {}).map(([name, p]) => `
      <div class="m5-profile">
        <div class="m5-profile-head"><span class="m5-profile-name">${esc(name)}</span>
          <span class="m5-profile-meta">${p.thinking ? 'thinking' : 'non-thinking'} · ${esc(String(p.tokPerSec ?? '—'))} tok/s · ${p.overallPass != null ? Math.round(p.overallPass * 100) + '% pass' : '—'}</span>
        </div>
        <div class="m5-profile-role">${esc(p.role || '')}</div>
      </div>`).join('');

    const routeRows = Object.entries(snapshot.routing || {}).map(([tt, r]) => {
      const verdict = r.verdict || 'unknown';
      const cls = verdict === 'delegate-local' ? 'm5-route-local' : verdict === 'escalate-frontier' ? 'm5-route-escalate' : 'm5-route-explore';
      const pass = r.passRate != null ? `${Math.round(r.passRate * 100)}%` : '—';
      const tps = r.tokPerSec != null ? ` · ${esc(String(r.tokPerSec))} tok/s` : '';
      return `<tr><td class="m5-row-task">${esc(tt)}</td><td>${esc(r.model || '—')}</td><td>${pass}${tps}</td><td><span class="m5-route-badge ${cls}">${esc(verdict)}</span></td></tr>`;
    }).join('');

    const gen = snapshot.generatedAt ? `<span class="m5-subtitle">snapshot ${esc(snapshot.generatedAt)}</span>` : '';
    return `
      <h3>Routing Plan ${gen}</h3>
      <div class="m5-global-rule"><strong>Global rule:</strong> ${esc(snapshot.globalRule || '')}</div>
      ${(snapshot.escalateToFrontier && snapshot.escalateToFrontier.length) ? `<div class="m5-rule-line"><strong>Always escalate:</strong> ${esc(snapshot.escalateToFrontier.join(', '))}</div>` : ''}
      ${(snapshot.avoidForShortTasks && snapshot.avoidForShortTasks.length) ? `<div class="m5-rule-line"><strong>Avoid for short tasks:</strong> ${esc(snapshot.avoidForShortTasks.join(', '))}</div>` : ''}
      <div class="m5-profiles">${profiles}</div>
      <div class="m5-matrix-wrap">
        <table class="m5-matrix">
          <thead><tr><th class="m5-col-task">Task type</th><th>Model</th><th>Pass / speed</th><th>Route</th></tr></thead>
          <tbody>${routeRows}</tbody>
        </table>
      </div>
    `;
  }

  // No snapshot file → derived hint from live ledger.
  if (derived && derived.length) {
    const rows = derived.map((d) => {
      const cls = d.recommendation === 'delegate-local' ? 'm5-route-local' : d.recommendation === 'escalate-frontier' ? 'm5-route-escalate' : 'm5-route-explore';
      const pass = d.successRate == null ? '—' : `${Math.round(d.successRate * 100)}%`;
      const tps = d.tokPerSec == null ? '' : ` · ${d.tokPerSec} tok/s`;
      return `<tr><td class="m5-row-task">${esc(d.taskType)}</td><td>${esc(d.model)}</td><td>${pass}${esc(tps)}</td><td><span class="m5-route-badge ${cls}">${esc(d.recommendation)}</span></td></tr>`;
    }).join('');
    return `
      <h3>Routing Hint <span class="m5-subtitle">derived from live /ledger (best model per task)</span></h3>
      <div class="m5-note">No routing snapshot configured (set <code>M5_ROUTING_JSON_PATH</code> for the full plan). Showing the best local model per task type by pass rate.</div>
      <div class="m5-matrix-wrap">
        <table class="m5-matrix">
          <thead><tr><th class="m5-col-task">Task type</th><th>Best model</th><th>Pass / speed</th><th>Route</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Neither snapshot nor ledger available.
  return `<h3>Routing</h3><div class="m5-note">Routing data unavailable${error ? ` — ${esc(error)}` : ''}.</div>`;
}

// summary: { downloaded: ModelInfo[], loaded: ModelInfo[], counts: { downloaded, loaded } }
//   from summarizeModels() in m5.js; error: optional error string from fetchModels().
// Renders a list of all models with a loaded (●) vs on-disk (○) badge per model.
// Degrades gracefully when error is set (mirrors how capability map handles ledger errors).
function m5ModelsCard(summary, error) {
  if (error) {
    return `<h3>Models on the M5</h3>
      <div class="m5-note">Models unavailable — ${esc(error)}. The gateway may be offline or unreachable from Heimdall's host.</div>`;
  }
  if (!summary || summary.counts.downloaded === 0) {
    return `<h3>Models on the M5</h3>
      <div class="m5-note">No models reported yet — the M5 gateway returned an empty list.</div>`;
  }

  // Human-readable byte size: show tenths of a GB, e.g. "4.2 GB", "0.7 GB".
  function fmtSize(bytes) {
    if (bytes == null || typeof bytes !== 'number') return null;
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }

  const rows = summary.downloaded.map((m) => {
    const isLoaded = m && m.loaded === true;
    const dot = isLoaded
      ? '<span class="m5-model-dot m5-model-dot-loaded" title="Loaded in memory">●</span>'
      : '<span class="m5-model-dot m5-model-dot-disk" title="On disk">○</span>';
    const name = esc(m && (m.displayName || m.key) || '(unknown)');
    const sizePart = m && fmtSize(m.sizeBytes) ? `<span class="m5-model-meta">${esc(fmtSize(m.sizeBytes))}</span>` : '';
    const quantPart = m && m.quantization ? `<span class="m5-model-meta">${esc(m.quantization)}</span>` : '';
    const ctxPart = m && m.maxContextLength ? `<span class="m5-model-meta">${esc(String(Math.round(m.maxContextLength / 1024))) + 'k ctx'}</span>` : '';
    const stateBadge = isLoaded
      ? '<span class="m5-badge m5-badge-viable m5-model-badge">loaded</span>'
      : '<span class="m5-badge m5-badge-unknown m5-model-badge">on disk</span>';
    const metas = [sizePart, quantPart, ctxPart].filter(Boolean).join(' · ');
    return `
      <div class="m5-model-row">
        <span class="m5-model-name">${dot} ${name}</span>
        <span class="m5-model-details">${metas ? `${metas} · ` : ''}${stateBadge}</span>
      </div>`;
  }).join('');

  const { downloaded, loaded } = summary.counts;
  return `
    <h3>Models on the M5 <span class="m5-subtitle">live from /models</span></h3>
    <div class="m5-model-counts">${esc(String(downloaded))} downloaded · ${esc(String(loaded))} loaded in memory</div>
    <div class="m5-model-list">${rows}</div>
  `;
}

function m5SimpleModelsCard(summary, error) {
  if (error) return `<h3>Models</h3><div class="m5-note">Model list unavailable — ${esc(error)}.</div>`;
  if (!summary || summary.counts.downloaded === 0) {
    return '<h3>Models</h3><div class="m5-note">No models reported.</div>';
  }
  const name = (model) => esc(model && (model.displayName || model.key) || '(unknown)');
  const loaded = summary.loaded.map((model) => `<span class="m5-model-chip is-loaded">${name(model)}</span>`).join('');
  const ready = summary.downloaded.filter((model) => !model || model.loaded !== true)
    .map((model) => `<span class="m5-model-chip">${name(model)}</span>`).join('');
  return `<h3>Models</h3>
    <div class="m5-model-section"><div class="m5-model-section-label">Loaded now</div><div class="m5-model-chips">${loaded || '<span class="m5-muted">None</span>'}</div></div>
    <div class="m5-model-section"><div class="m5-model-section-label">Ready to load</div><div class="m5-model-chips">${ready || '<span class="m5-muted">None</span>'}</div></div>`;
}

function m5Duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''}`;
}

function m5RelativeTime(then, now) {
  const elapsed = new Date(now).getTime() - new Date(then).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'Unknown';
  if (elapsed < 60000) return 'Just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  return `${Math.floor(elapsed / 86400000)}d ago`;
}

function m5OverviewCard({ health, usage, error }) {
  const online = health && health.ok === true;
  const healthLabel = online ? 'Online' : 'Unavailable';
  const healthDetail = online ? 'Ready for inference' : 'The live health check did not answer';
  if (!usage) {
    return `<div class="m5-overview-head"><div><h3>M5 right now</h3><div class="m5-live-state"><span class="m5-live-dot ${online ? 'is-online' : 'is-offline'}"></span>${healthLabel}</div><div class="m5-live-detail">${healthDetail}</div></div></div>
      <div class="m5-note m5-usage-unavailable"><strong>Usage data unavailable</strong>${error ? ` — ${esc(error)}` : ''}. Live health and usage history are checked separately.</div>`;
  }

  const active = usage.activeRequests > 0
    ? `${usage.activeRequests} request${usage.activeRequests === 1 ? '' : 's'} running`
    : 'Idle now';
  const lastUsed = usage.lastUsedAt ? m5RelativeTime(usage.lastUsedAt, usage.generatedAt) : 'No recorded use';
  const days = [...usage.daily].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const maxRequests = Math.max(1, ...days.map((day) => day.requests));
  const rows = days.map((day) => {
    const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const width = Math.round((day.requests / maxRequests) * 100);
    return `<div class="m5-activity-row">
      <time class="m5-activity-date" datetime="${esc(day.date)}">${esc(label)}</time>
      <span class="m5-activity-track"><span class="m5-activity-bar" style="width:${width}%"></span></span>
      <span class="m5-activity-count">${day.requests === 0 ? 'No activity' : `${esc(String(day.requests))} request${day.requests === 1 ? '' : 's'}`}</span>
      <span class="m5-activity-time">${day.requestTimeMs === 0 ? '—' : esc(m5Duration(day.requestTimeMs))}</span>
    </div>`;
  }).join('');

  return `<div class="m5-overview-head">
      <div><h3>M5 right now</h3><div class="m5-live-state"><span class="m5-live-dot ${online ? 'is-online' : 'is-offline'}"></span>${healthLabel}</div><div class="m5-live-detail">${healthDetail}</div></div>
      <div class="m5-now">${esc(active)}</div>
    </div>
    <div class="m5-essentials">
      <div><div class="m5-essential-value">${esc(String(usage.last24Hours.requests))}</div><div class="m5-essential-label">Requests · last 24 hours</div></div>
      <div><div class="m5-essential-value">${esc(m5Duration(usage.last24Hours.requestTimeMs))}</div><div class="m5-essential-label">M5 request time · last 24 hours</div></div>
      <div><div class="m5-essential-value">${esc(lastUsed)}</div><div class="m5-essential-label">Last used</div></div>
    </div>
    <div class="m5-activity"><div class="m5-activity-head"><h4>Last 7 days</h4><span>Requests · request time</span></div>${rows}</div>
    <div class="m5-usage-foot">Admitted inference requests recorded by the gateway · request time is wall-clock, not GPU load · newest day first</div>`;
}

// usage: summarizeUsageMetrics() output | null; error: optional string.
// Renders aggregate totals + a per-model usage table + admission/rate-limit/outcome breakdowns.
// CONTENT-BLIND: every value comes from the gateway's aggregate /metrics (no per-user/content).
// Every dynamic value is escaped via esc(); model labels in particular are gateway-supplied.
function m5UsageCard(usage, error) {
  if (error) {
    return `<h3>Usage Metrics</h3>
      <div class="m5-note">Metrics unavailable — ${esc(error)}. The gateway may be offline or unreachable from Heimdall's host.</div>`;
  }
  if (!usage || !usage.totals || usage.totals.requests === 0) {
    return `<h3>Usage Metrics</h3>
      <div class="m5-note">No requests recorded yet — the M5 gateway's counters are empty (they reset on restart).</div>`;
  }

  // Compact number formatting: 1.2k / 3.4M, full count in the title attribute.
  function fmtNum(n) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(n));
  }
  function fmtMs(sec) {
    if (sec == null || typeof sec !== 'number' || !isFinite(sec)) return '—';
    return sec >= 1 ? `${sec.toFixed(2)}s` : `${Math.round(sec * 1000)}ms`;
  }

  const t = usage.totals;
  const totalsRow = `
    <div class="m5-usage-totals">
      <div class="m5-usage-stat"><span class="m5-usage-num" title="${esc(String(t.requests))} requests">${esc(fmtNum(t.requests))}</span><span class="m5-usage-lbl">requests</span></div>
      <div class="m5-usage-stat"><span class="m5-usage-num" title="${esc(String(t.totalTokens))} tokens">${esc(fmtNum(t.totalTokens))}</span><span class="m5-usage-lbl">tokens</span></div>
      <div class="m5-usage-stat"><span class="m5-usage-num" title="${esc(String(t.promptTokens))} prompt tokens">${esc(fmtNum(t.promptTokens))}</span><span class="m5-usage-lbl">prompt</span></div>
      <div class="m5-usage-stat"><span class="m5-usage-num" title="${esc(String(t.completionTokens))} completion tokens">${esc(fmtNum(t.completionTokens))}</span><span class="m5-usage-lbl">completion</span></div>
      <div class="m5-usage-stat"><span class="m5-usage-num" title="${esc(String(t.credits))} credits">${esc(fmtNum(t.credits))}</span><span class="m5-usage-lbl">credits</span></div>
    </div>`;

  const modelRows = (Array.isArray(usage.models) ? usage.models : []).map((m) => `
    <tr>
      <td class="m5-usage-model">${esc(m.model)}</td>
      <td class="m5-usage-cell" title="${esc(String(m.requests))} requests">${esc(fmtNum(m.requests))}</td>
      <td class="m5-usage-cell" title="${esc(String(m.totalTokens))} tokens">${esc(fmtNum(m.totalTokens))}</td>
      <td class="m5-usage-cell">${esc(fmtMs(m.avgDurationSec))}</td>
      <td class="m5-usage-cell">${esc(fmtMs(m.avgTtftSec))}</td>
    </tr>`).join('');

  const modelTable = modelRows
    ? `<div class="m5-usage-table-wrap">
        <table class="m5-usage-table">
          <thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Avg dur</th><th>Avg TTFT</th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>`
    : '';

  // Outcomes, rejections, rate-limits: a compact chips row (omit zeros).
  const chips = [];
  for (const o of (Array.isArray(usage.outcomes) ? usage.outcomes : [])) {
    if (o && o.count > 0 && o.outcome !== 'ok') {
      chips.push(`<span class="m5-usage-chip m5-usage-chip-warn" title="${esc(String(o.count))} ${esc(o.outcome)}">${esc(o.outcome)}: ${esc(fmtNum(o.count))}</span>`);
    }
  }
  if (usage.admissionRejections > 0) {
    chips.push(`<span class="m5-usage-chip m5-usage-chip-warn" title="${esc(String(usage.admissionRejections))} admission rejections (503)">503 busy: ${esc(fmtNum(usage.admissionRejections))}</span>`);
  }
  for (const r of (Array.isArray(usage.rateLimited) ? usage.rateLimited : [])) {
    if (r && r.count > 0) {
      chips.push(`<span class="m5-usage-chip m5-usage-chip-warn" title="${esc(String(r.count))} rate-limited (${esc(r.surface)})">429 ${esc(r.surface)}: ${esc(fmtNum(r.count))}</span>`);
    }
  }
  if (usage.inflight != null) {
    chips.push(`<span class="m5-usage-chip" title="current in-flight requests">in-flight: ${esc(String(usage.inflight))}</span>`);
  }
  const chipsRow = chips.length ? `<div class="m5-usage-chips">${chips.join('')}</div>` : '';

  return `
    <h3>Usage Metrics <span class="m5-subtitle">aggregate &amp; per-model — live from /metrics</span></h3>
    ${totalsRow}
    ${modelTable}
    ${chipsRow}
    <div class="m5-usage-foot">Content-blind aggregates (no per-user data). Counters reset on gateway restart.</div>
  `;
}

function taskBaseSlug(name) {
  // Strip timestamp prefix (YYYYMMDD-HHMMSS-) and -retry/-retry-N suffix
  const slug = String(name).replace(/^tasks\//, '');
  return slug.replace(/^\d{8}-\d{6}-/, '').replace(/-retry(-\d+)?$/, '');
}

function huginTasksCard(tasks, successRate, queueMetrics, heartbeat, timeoutCal) {
  const running = tasks.filter(t => t.status === 'running' || t.status === 'claimed');
  const allQueued = tasks.filter(t => t.status === 'pending');
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'done');
  const completedSlugs = new Set(completed.map(t => taskBaseSlug(t.name)));
  const allFailed = tasks.filter(t => (t.status === 'failed' || t.status === 'error') && !completedSlugs.has(taskBaseSlug(t.name)));
  const queued = allQueued.slice(0, 5);
  const failed = allFailed.slice(0, 5);
  const recent = completed.slice(0, 5);

  let badge = '';
  if (successRate) {
    const cls = successRate.rate >= 90 ? 'badge-green' : successRate.rate >= 70 ? 'badge-amber' : 'badge-red';
    badge = ` <span class="success-badge ${cls}" title="${successRate.completed} succeeded, ${successRate.failed} failed in ${successRate.days}d">${successRate.rate}% success, ${successRate.days}d</span>`;
  }

  // Heartbeat status row
  let heartbeatRow = '';
  if (heartbeat) {
    const statusColors = { running: 'var(--green)', stale: 'var(--amber, orange)', down: 'var(--red)', unknown: 'var(--muted)' };
    const statusLabels = { running: 'Running', stale: 'Stale', down: 'Down', unknown: 'Unknown' };
    const color = statusColors[heartbeat.status] || statusColors.unknown;
    const label = statusLabels[heartbeat.status] || 'Unknown';
    const uptimeStr = heartbeat.uptime_s != null ? formatUptime(heartbeat.uptime_s) : '—';
    const lastPoll = heartbeat.polled_at ? formatAge(heartbeat.polled_at) : 'never';
    const depth = heartbeat.queue_depth != null ? heartbeat.queue_depth : '—';
    const currentTask = heartbeat.current_task ? esc(humanizeTaskName(heartbeat.current_task)) : 'Idle';
    heartbeatRow = `<div class="heartbeat-row"><span class="heartbeat-status" style="color:${color}" title="Last poll: ${esc(lastPoll)}">● ${esc(label)}</span> <span class="heartbeat-detail">up ${esc(uptimeStr)} · poll ${esc(lastPoll)} · queue ${esc(String(depth))} · ${currentTask}</span></div>`;
  }

  // Queue metrics row
  let queueMetricsRow = '';
  const qm = queueMetrics;
  if (qm) {
    const parts = [];
    if (qm.oldestPendingAge != null) {
      const ageMin = Math.round(qm.oldestPendingAge / 60000);
      parts.push(`oldest queued: ${ageMin < 60 ? ageMin + 'm' : Math.round(ageMin / 60) + 'h'}`);
    }
    if (qm.avgCompletionTime != null) {
      const avgSec = Math.round(qm.avgCompletionTime / 1000);
      parts.push(`avg: ${avgSec < 60 ? avgSec + 's' : Math.round(avgSec / 60) + 'm'}`);
    }
    if (qm.retryCount > 0) parts.push(`${qm.retryCount} retries`);
    if (qm.stuckTasks.length > 0) parts.push(`<span style="color:var(--red)">${qm.stuckTasks.length} stuck</span>`);
    if (parts.length > 0) {
      queueMetricsRow = `<div class="task-queue-metrics">${parts.join(' · ')}</div>`;
    }
  }

  // Timeout calibration row
  let calRow = '';
  if (timeoutCal && timeoutCal.sampleSize > 0) {
    const parts = [];
    parts.push(`${timeoutCal.sampleSize} tasks`);
    if (timeoutCal.medianDurationS != null) {
      const med = timeoutCal.medianDurationS;
      parts.push(`median ${med < 60 ? med + 's' : Math.round(med / 60) + 'm'}`);
    }
    if (timeoutCal.timeoutRatio != null) {
      parts.push(`${Math.round(timeoutCal.timeoutRatio * 100)}% timeout used`);
    }
    if (timeoutCal.overUtilized > 0) {
      parts.push(`<span style="color:var(--amber, orange)">${timeoutCal.overUtilized} near-timeout</span>`);
    }
    if (timeoutCal.timedOut > 0) {
      parts.push(`<span style="color:var(--red)">${timeoutCal.timedOut} timed out</span>`);
    }
    if (timeoutCal.underUtilized > 0) {
      parts.push(`${timeoutCal.underUtilized} over-provisioned`);
    }
    calRow = `<div class="task-queue-metrics" title="Timeout calibration (${timeoutCal.days}d window)">⏱ ${parts.join(' · ')}</div>`;
  }

  return `
    <h3>Hugin Tasks${badge}</h3>
    ${heartbeatRow}
    ${queueMetricsRow}
    ${calRow}
    ${running.length > 0 ? running.map(t => {
      let durationStr = t.runtime ? `(${esc(t.runtime)})` : '';
      if (!durationStr && t.updated_at) {
        const ageMs = Date.now() - new Date(t.updated_at).getTime();
        if (ageMs > 60000) durationStr = `(${esc(formatAge(t.updated_at))})`;
      }
      return `<div class="task-running" title="${esc(t.name)}">● Running: ${esc(humanizeTaskName(t.name))} ${durationStr}</div>`;
    }).join('') : '<div class="task-idle">No tasks running</div>'}
    ${queued.length > 0 ? `
      <div class="task-queue-header">Queued (${esc(String(allQueued.length))}):</div>
      <div class="task-queue-list">${queued.map(t => `<div class="task-queued" title="${esc(t.name)}">○ ${esc(humanizeTaskName(t.name))}</div>`).join('')}</div>
    ` : ''}
    ${failed.length > 0 ? `
      <div class="task-failed-header">Failed (${esc(String(allFailed.length))}):</div>
      <div class="task-failed-list">${failed.map(t => `<div class="task-failed" title="${esc(t.name)}"><span class="task-failed-icon">✗</span> ${esc(humanizeTaskName(t.name))}${t.failureReason ? ` <span class="task-failure-reason">— ${esc(t.failureReason)}</span>` : ''}</div>`).join('')}</div>
    ` : ''}
    <div class="task-summary">Completed: ${esc(String(completed.length))} recent</div>
    ${recent.length > 0 ? `<div class="task-recent">Recent: ${recent.map(t => `<span title="${esc(t.name)}">${esc(humanizeTaskName(t.name))} ✓</span>`).join(', ')}</div>` : ''}
  `;
}

function taskHistoryCard(tasks, page = 1) {
  const terminal = tasks.filter(t =>
    ['completed', 'done', 'failed', 'error'].includes(t.status)
  );

  if (terminal.length === 0) {
    return '<h3>Task History</h3><div class="task-idle">No completed tasks</div>';
  }

  const PAGE_SIZE = 20;
  const totalPages = Math.ceil(terminal.length / PAGE_SIZE);
  // Clamp page to valid range
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = terminal.slice(start, start + PAGE_SIZE);

  const rows = pageItems.map(t => {
    const ok = t.status === 'completed' || t.status === 'done';
    const icon = ok ? '<span class="task-hist-ok">✓</span>' : '<span class="task-hist-fail">✗</span>';
    const date = t.updated_at
      ? new Date(t.updated_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })
      : '—';
    const time = t.updated_at
      ? new Date(t.updated_at).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' })
      : '';
    const runtime = t.runtime ? esc(t.runtime) : '—';
    const reason = !ok && t.failureReason ? ` <span class="task-failure-reason">— ${esc(t.failureReason)}</span>` : '';

    return `<tr class="task-hist-row ${ok ? '' : 'task-hist-row-fail'}">
      <td class="task-hist-icon">${icon}</td>
      <td class="task-hist-name" title="${esc(t.name)}">${esc(humanizeTaskName(t.name))}${reason}</td>
      <td class="task-hist-date" title="${esc(t.updated_at || '')}">${esc(date)} ${esc(time)}</td>
      <td class="task-hist-runtime">${runtime}</td>
    </tr>`;
  }).join('');

  const prevDisabled = currentPage <= 1;
  const nextDisabled = currentPage >= totalPages;
  const pagination = `
    <div style="display:flex;align-items:center;gap:0.75rem;margin-top:0.5rem;font-size:0.85rem;">
      <button
        ${prevDisabled ? 'disabled' : ''}
        hx-get="/api/card/task-history?page=${currentPage - 1}"
        hx-target="closest .card"
        hx-swap="innerHTML"
        style="padding:0.2rem 0.6rem;cursor:${prevDisabled ? 'default' : 'pointer'};opacity:${prevDisabled ? '0.4' : '1'};"
      >← Prev</button>
      <span style="color:var(--text-muted,#888);">Page ${currentPage} of ${totalPages}</span>
      <button
        ${nextDisabled ? 'disabled' : ''}
        hx-get="/api/card/task-history?page=${currentPage + 1}"
        hx-target="closest .card"
        hx-swap="innerHTML"
        style="padding:0.2rem 0.6rem;cursor:${nextDisabled ? 'default' : 'pointer'};opacity:${nextDisabled ? '0.4' : '1'};"
      >Next →</button>
    </div>
  `;

  return `
    <h3>Task History <span class="task-hist-count">(${terminal.length})</span></h3>
    <table class="task-hist-table">
      <thead><tr>
        <th></th><th>Task</th><th>Date</th><th>Runtime</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pagination}
  `;
}

function consolidationHealthCard(health, synthesizedCount) {
  if (!health) {
    return `<h3>Memory Consolidation</h3>
    <div class="consolidation-health">
      <div class="consolidation-status status-off">Unavailable</div>
    </div>`;
  }
  const statusClass = health.available ? 'status-ok' : 'status-off';
  const statusLabel = health.available ? 'Running' : 'Disabled';
  const dot = health.available
    ? '<span class="status-dot online">●</span>'
    : '<span class="status-dot offline">●</span>';
  return `<h3>Memory Consolidation</h3>
    <div class="consolidation-health">
      <div class="consolidation-status ${statusClass}">${dot} ${esc(statusLabel)}</div>
      ${synthesizedCount != null
        ? `<div class="consolidation-stat">${esc(String(synthesizedCount))} namespace${synthesizedCount !== 1 ? 's' : ''} synthesized</div>`
        : ''}
    </div>`;
}

function lifecycleBadge(lifecycle) {
  const config = {
    active: { cls: 'proj-active', label: 'Active' },
    maintenance: { cls: 'proj-maintenance', label: 'Maintenance' },
    stopped: { cls: 'proj-stopped', label: 'Stopped' },
    completed: { cls: 'proj-completed', label: 'Completed' },
    archived: { cls: 'proj-archived', label: 'Archived' },
  };
  const c = config[lifecycle] || config.active;
  return `<span class="lifecycle-badge ${c.cls}">${lifecycle === 'completed' ? '✓ ' : ''}${c.label}</span>`;
}

function isStale(updatedAt) {
  if (!updatedAt) return false;
  const diff = Date.now() - new Date(updatedAt).getTime();
  return diff > 14 * 24 * 60 * 60 * 1000; // 14 days
}

function titleFromSlug(slug) {
  if (!slug) return '';
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatMarkdownContent(text) {
  if (!text) return '';
  // Convert markdown bullet lists to HTML, escape the rest
  const lines = text.split('\n');
  let inList = false;
  let html = '';
  for (const line of lines) {
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (bulletMatch) {
      if (!inList) { html += '<ul class="proj-list">'; inList = true; }
      html += `<li>${esc(bulletMatch[2])}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim()) html += `<p>${esc(line.trim())}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function projectCard(project) {
  const age = formatAge(project.updatedAt);
  const stale = isStale(project.updatedAt) && project.lifecycle === 'active';
  const blockersText = (project.sections && project.sections['Blockers']) || '';
  const hasBlockers = blockersText.length > 0 && !/^[-*\s]*none\.?\s*$/i.test(blockersText);
  const cardClasses = ['proj-card', 'proj-card--compact'];
  if (hasBlockers) cardClasses.push('proj-card--blocked');
  if (project.needsAttention) cardClasses.push('proj-card--attention');

  const attentionBadge = project.needsAttention
    ? '<span class="attention-badge">Needs Attention</span>'
    : '';
  const staleBadge = stale ? '<span class="stale-badge">Stale</span>' : '';
  const blockerBadge = hasBlockers
    ? '<span class="blocker-badge" title="Has blockers">⚠ blocked</span>'
    : '';

  // Tagline: first line of Vision, or fallback to first line of summary
  let taglineText = '';
  if (project.sections && project.sections['Vision']) {
    taglineText = project.sections['Vision'].split('\n')[0];
  } else if (project.summary) {
    const firstLine = project.summary.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (firstLine) taglineText = firstLine.replace(/^#+\s*/, '').slice(0, 160);
  }
  const tagline = taglineText
    ? `<div class="proj-vision">${esc(taglineText)}</div>`
    : '';

  // Verbose body pieces (shown when card is expanded)
  const currentWork = project.sections && project.sections['Current Work']
    ? `<div class="proj-current-work">${formatMarkdownContent(project.sections['Current Work'])}</div>`
    : '';

  const blockers = hasBlockers
    ? `<div class="proj-blockers"><div class="proj-blockers-label">Blockers</div>${formatMarkdownContent(project.sections['Blockers'])}</div>`
    : '';

  const nextSteps = project.sections && project.sections['Next Steps']
    ? `<details class="proj-collapsible"><summary class="proj-collapsible-toggle">Next Steps</summary><div class="proj-collapsible-body">${formatMarkdownContent(project.sections['Next Steps'])}</div></details>`
    : '';

  const roadmap = project.sections && project.sections['Roadmap']
    ? `<details class="proj-collapsible"><summary class="proj-collapsible-toggle">Roadmap</summary><div class="proj-collapsible-body">${formatMarkdownContent(project.sections['Roadmap'])}</div></details>`
    : '';

  const synthesis = project.synthesis
    ? (() => {
        const synthAge = formatAge(project.synthesis.updatedAt);
        const synthStale = project.updatedAt && project.synthesis.updatedAt
          && new Date(project.synthesis.updatedAt) < new Date(new Date(project.updatedAt).getTime() - 24 * 60 * 60 * 1000);
        const synthStaleBadge = synthStale ? ' <span class="stale-badge">Stale</span>' : '';

        const synthSections = project.synthesis.sections || {};
        const keyDecisions = synthSections['Key Decisions']
          ? `<div class="synth-decisions">${formatMarkdownContent(synthSections['Key Decisions'])}</div>`
          : '';
        const synthCurrentWork = synthSections['Current Work']
          ? `<div class="synth-current-work">${formatMarkdownContent(synthSections['Current Work'])}</div>`
          : '';

        const content = project.synthesis.content || '';
        const synthBody = keyDecisions || synthCurrentWork
          ? keyDecisions + synthCurrentWork
          : `<div class="synth-summary">${formatMarkdownContent(content.slice(0, 400) + (content.length > 400 ? '…' : ''))}</div>`;

        return `<details class="proj-collapsible synth-section">
          <summary class="proj-collapsible-toggle">
            AI Synthesis <span class="synth-age">${esc(synthAge)}</span>${synthStaleBadge}
          </summary>
          <div class="proj-collapsible-body">
            ${synthBody}
          </div>
        </details>`;
      })()
    : '';

  const connections = project.crossReferences && project.crossReferences.length > 0
    ? `<div class="proj-connections">
        <span class="connections-label">Connections:</span>
        ${project.crossReferences.map(ref => {
          const target = (ref.target_namespace || '').replace(/^(projects|people|decisions)\//, '');
          const typeIcon = ref.reference_type === 'depends_on' ? '→'
            : ref.reference_type === 'blocks' ? '⊘'
            : ref.reference_type === 'feeds_into' ? '↗'
            : ref.reference_type === 'supersedes' ? '↦'
            : '↔';
          return `<span class="connection-chip" title="${esc(ref.context || ref.reference_type)}">${typeIcon} ${esc(titleFromSlug(target))}</span>`;
        }).join(' ')}
      </div>`
    : '';

  let body = currentWork + blockers + nextSteps + roadmap + synthesis + connections;
  // Fallback if no structured sections and no synthesis at all
  if (!body && !taglineText) {
    const summary = (project.summary || '').split('\n').slice(0, 3).join('\n').slice(0, 300);
    body = `<div class="proj-summary">${esc(summary)}${project.summary && project.summary.length > 300 ? '…' : ''}</div>`;
  }

  const hasExpandableBody = body.trim().length > 0;
  const slugAttr = project.slug ? ` data-proj-slug="${esc(project.slug)}"` : '';

  // Milestone chip on the compact card
  const nextMs = project.nextMilestone ? milestoneChip(project.nextMilestone) : '';
  const achievedMs = project.achievedMilestones ? achievedMilestonesList(project.achievedMilestones) : '';
  // Append achieved milestones to body
  if (achievedMs) body += achievedMs;

  // Header is the clickable summary; tagline lives inside it so it stays visible when collapsed
  const headerInner = `
        <div class="proj-card-header">
          <span class="proj-lifecycle-dot proj-${esc(project.lifecycle || 'active')}" title="${esc(project.lifecycle || 'active')}"></span>
          <span class="proj-name">${esc(project.name)}</span>
          ${blockerBadge}${attentionBadge}${staleBadge}
          ${nextMs}
          <span class="proj-updated" title="${esc(project.updatedAt || '')}">${esc(age)}</span>
        </div>
        ${tagline}`;

  if (!hasExpandableBody) {
    return `
    <div class="${cardClasses.join(' ')}"${slugAttr}>
      ${headerInner}
    </div>`;
  }

  return `
    <details class="${cardClasses.join(' ')}"${slugAttr}>
      <summary class="proj-card-summary">${headerInner}
      </summary>
      <div class="proj-card-body">${body}</div>
    </details>`;
}

function milestoneChip(milestone) {
  if (!milestone) return '';
  const dateStr = milestone.date || 'TBD';
  return `<span class="proj-milestone-chip" title="${esc(milestone.label)}">→ ${esc(dateStr)}: ${esc(milestone.label)}</span>`;
}

function achievedMilestonesList(milestones) {
  if (!milestones || milestones.length === 0) return '';
  return `<details class="proj-collapsible">
    <summary class="proj-collapsible-toggle">Achieved (${milestones.length})</summary>
    <div class="proj-collapsible-body">
      <ul class="proj-list">${milestones.map(m =>
        `<li><span class="proj-milestone-date">${esc(m.date || 'TBD')}</span> ${esc(m.label)}</li>`
      ).join('')}</ul>
    </div>
  </details>`;
}

function projectTreeCard(group) {
  const root = group.root;
  const childCount = group.children.length;
  const blockedChildren = group.children.filter(c => {
    const bt = (c.sections && c.sections['Blockers']) || '';
    return bt.length > 0 && !/^[-*\s]*none\.?\s*$/i.test(bt);
  }).length;
  const childrenAge = group.children.length > 0
    ? formatAge(group.children.reduce((latest, c) =>
        new Date(c.updatedAt || 0) > new Date(latest) ? c.updatedAt : latest, group.children[0].updatedAt))
    : '';

  const roadmapBtn = group.roadmapUrl
    ? `<a class="proj-roadmap-btn" href="${esc(group.roadmapUrl)}" target="_blank" rel="noopener" title="Open roadmap">→ Roadmap</a>`
    : '';

  const rootMilestone = root.nextMilestone ? milestoneChip(root.nextMilestone) : '';

  const rootTagline = root.sections && root.sections['Vision']
    ? `<div class="proj-vision">${esc(root.sections['Vision'].split('\n')[0])}</div>`
    : '';

  const childrenHtml = group.children.map(c => projectCard(c)).join('');

  return `
    <div class="proj-tree">
      <details class="proj-card proj-card--compact proj-card--tree-root" data-proj-slug="${esc(root.slug)}" open>
        <summary class="proj-card-summary">
          <div class="proj-card-header">
            <span class="proj-lifecycle-dot proj-${esc(root.lifecycle || 'active')}" title="${esc(root.lifecycle || 'active')}"></span>
            <span class="proj-name">${esc(root.name || group.label)}</span>
            ${blockedChildren > 0 ? `<span class="blocker-badge">⚠ ${blockedChildren} blocked</span>` : ''}
            ${roadmapBtn}
            <span class="proj-updated" title="${esc(root.updatedAt || '')}">${esc(formatAge(root.updatedAt))}</span>
          </div>
          ${rootTagline}
          <div class="proj-tree-meta">
            <span class="proj-tree-count">${childCount} sub-projects</span>
            ${childrenAge ? `<span class="proj-tree-child-age">latest activity ${esc(childrenAge)}</span>` : ''}
            ${rootMilestone}
          </div>
        </summary>
        <div class="proj-card-body">
          <div class="proj-subtree">${childrenHtml}</div>
        </div>
      </details>
    </div>`;
}

function categoryCard(group) {
  const memberCount = group.members.length;
  const membersHtml = group.members.map(m => projectCard(m)).join('');
  const emptyMsg = memberCount === 0 ? '<div class="proj-empty-category">No projects yet</div>' : '';

  return `
    <div class="proj-category">
      <details class="proj-card proj-card--compact proj-card--category" data-proj-slug="cat-${esc(group.id)}">
        <summary class="proj-card-summary">
          <div class="proj-card-header">
            <span class="proj-category-icon">◆</span>
            <span class="proj-name">${esc(group.label)}</span>
            <span class="proj-tree-count">${memberCount}</span>
            ${memberCount > 0 ? `<span class="proj-updated">${esc(formatAge(group.members[0]?.updatedAt))}</span>` : ''}
          </div>
          ${group.tagline ? `<div class="proj-vision">${esc(group.tagline)}</div>` : ''}
        </summary>
        <div class="proj-card-body">
          <div class="proj-subtree">${membersHtml}${emptyMsg}</div>
        </div>
      </details>
    </div>`;
}

function projectsListCard(projects, tree) {
  if (!projects || projects.length === 0) {
    return '<div class="proj-page-header"><h2>Projects</h2></div><div class="proj-empty">No projects found in Munin</div>';
  }

  // Stats bar
  const activeCount = projects.filter(p => p.lifecycle === 'active').length;
  const attentionCount = projects.filter(p => p.needsAttention).length;
  const blockerCount = projects.filter(p => {
    const bt = (p.sections && p.sections['Blockers']) || '';
    return bt.length > 0 && !/^[-*\s]*none\.?\s*$/i.test(bt);
  }).length;
  const archivedCount = projects.filter(p => p.lifecycle === 'archived').length;

  let html = `<div class="proj-page-header">
    <h2>Projects</h2>
    <div class="proj-stats">
      <span class="proj-stat">${projects.length} total</span>
      <span class="proj-stat proj-stat--active">${activeCount} active</span>
      ${blockerCount > 0 ? `<span class="proj-stat proj-stat--blocked">${blockerCount} blocked</span>` : ''}
      ${attentionCount > 0 ? `<span class="proj-stat proj-stat--attention">${attentionCount} need attention</span>` : ''}
      ${archivedCount > 0 ? `<span class="proj-stat">${archivedCount} archived</span>` : ''}
    </div>
  </div>`;

  // If we have a tree, render hierarchically
  if (tree && tree.groups && tree.groups.length > 0) {
    // Render groups
    for (const g of tree.groups) {
      if (g.kind === 'project-tree') {
        html += projectTreeCard(g);
      } else if (g.kind === 'category') {
        html += categoryCard(g);
      }
    }

    // Uncategorized projects
    if (tree.uncategorized && tree.uncategorized.length > 0) {
      html += `
        <details class="proj-group proj-group--uncategorized" open>
          <summary class="proj-group-header">
            <span class="proj-group-label">${esc(tree.uncategorizedLabel || 'Other Projects')}</span>
            <span class="proj-group-count">${tree.uncategorized.length}</span>
          </summary>
          <div class="proj-group-body">
            ${tree.uncategorized.map(p => projectCard(p)).join('')}
          </div>
        </details>`;
    }

    // Archived
    if (tree.archived && tree.archived.length > 0) {
      html += `
        <details class="proj-group proj-group--archived">
          <summary class="proj-group-header">
            <span class="proj-group-label">Archived</span>
            <span class="proj-group-count">${tree.archived.length}</span>
          </summary>
          <div class="proj-group-body proj-archived-list">
            ${tree.archived.map(p => `
              <div class="proj-archived-row">
                <span class="proj-name-sm">${esc(p.name)}</span>
                ${lifecycleBadge(p.lifecycle)}
                <span class="proj-updated-sm">${esc(formatAge(p.updatedAt))}</span>
              </div>
            `).join('')}
          </div>
        </details>`;
    }
  } else {
    // Fallback: flat lifecycle grouping (no layout config available)
    const groups = {
      active: { label: 'Active', projects: [], expanded: true },
      maintenance: { label: 'Maintenance', projects: [], expanded: true },
      stopped: { label: 'Stopped', projects: [], expanded: false },
      completed: { label: 'Completed', projects: [], expanded: false },
      archived: { label: 'Archived', projects: [], expanded: false },
    };
    for (const p of projects) {
      const g = groups[p.lifecycle] || groups.active;
      g.projects.push(p);
    }
    for (const g of Object.values(groups)) {
      g.projects.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    }
    for (const [key, group] of Object.entries(groups)) {
      if (group.projects.length === 0) continue;
      const detailsAttr = group.expanded ? ' open' : '';
      if (key === 'archived') {
        html += `
          <details class="proj-group proj-group--${key}"${detailsAttr}>
            <summary class="proj-group-header">
              <span class="proj-group-label">${esc(group.label)}</span>
              <span class="proj-group-count">${group.projects.length}</span>
            </summary>
            <div class="proj-group-body proj-archived-list">
              ${group.projects.map(p => `
                <div class="proj-archived-row">
                  <span class="proj-name-sm">${esc(p.name)}</span>
                  ${lifecycleBadge(p.lifecycle)}
                  <span class="proj-updated-sm">${esc(formatAge(p.updatedAt))}</span>
                </div>
              `).join('')}
            </div>
          </details>`;
      } else {
        html += `
          <details class="proj-group proj-group--${key}"${detailsAttr}>
            <summary class="proj-group-header">
              <span class="proj-group-label">${esc(group.label)}</span>
              <span class="proj-group-count">${group.projects.length}</span>
            </summary>
            <div class="proj-group-body">
              ${group.projects.map(p => projectCard(p)).join('')}
            </div>
          </details>`;
      }
    }
  }

  return html;
}

function briefingFullCard(briefing) {
  if (!briefing) {
    return `<div class="briefing-empty">No briefing available yet. Skuld generates one daily at 06:00.</div>`;
  }

  const narrative = briefing.narrative || '';
  // Simple markdown-to-HTML: headers, bold, bullets
  const html = narrative
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/^<\/p><p>(<[hul])/gm, '$1');

  const generatedAt = briefing.generatedAt ? `<span class="briefing-meta-val">${esc(briefing.generatedAt)}</span>` : '—';
  const sources = briefing.sources && briefing.sources.length
    ? `<span class="briefing-meta-val">${briefing.sources.map(esc).join(', ')}</span>` : '—';
  const events = briefing.eventsToday != null ? `<span class="briefing-meta-val">${briefing.eventsToday}</span>` : '—';

  return `
    <div class="briefing-header">
      <h2>Daily Briefing — ${esc(briefing.date || 'unknown')}</h2>
      <div class="briefing-meta">
        <span class="briefing-meta-key">Generated:</span> ${generatedAt}
        <span class="briefing-meta-key">Sources:</span> ${sources}
        <span class="briefing-meta-key">Events today:</span> ${events}
      </div>
    </div>
    <div class="briefing-narrative"><p>${html}</p></div>
  `;
}

function consolidationStatusCard(detail) {
  const { health, telemetry, coverage } = detail || {};

  if (!health) {
    return `<h3>Consolidation Worker</h3>
    <div class="consolidation-health">
      <div class="consolidation-status">
        <span class="status-dot offline">●</span> Unavailable
      </div>
    </div>`;
  }

  const tripped = health.circuit_breaker_tripped;
  const hasFails = (health.failures || 0) > 0;
  const healthy = health.available && !tripped && !hasFails;

  let dotClass, labelClass, statusLabel;
  if (tripped || !health.available) {
    dotClass = 'offline';
    labelClass = 'is-crit';
    statusLabel = tripped ? 'TRIPPED' : 'Disabled';
  } else if (hasFails) {
    dotClass = 'online';
    labelClass = 'is-warn';
    statusLabel = `Failing ${health.failures}/${health.max_failures}`;
  } else {
    dotClass = 'online';
    labelClass = 'is-ok';
    statusLabel = 'Healthy';
  }

  // Telemetry: find the memory_consolidate aggregate (rows keyed by tool_name).
  let callsHtml = '';
  if (Array.isArray(telemetry)) {
    const t = telemetry.find(e => e.tool_name === 'memory_consolidate');
    if (t && t.total_calls != null) {
      callsHtml = `<div class="consolidation-stat">${esc(String(t.total_calls))} run${t.total_calls !== 1 ? 's' : ''} · avg ${esc(String(Math.round(t.avg_duration_ms || 0)))}ms</div>`;
    }
  }

  // Healthy-state enrichment: failures 0/max + last successful synthesis
  // (most-recent updated_at across the coverage entries).
  let healthyStatsHtml = '';
  if (healthy) {
    const parts = [`failures ${health.failures || 0}/${health.max_failures}`];
    let lastSynth = null;
    if (Array.isArray(coverage)) {
      for (const c of coverage) {
        if (c.lastConsolidated && (!lastSynth || c.lastConsolidated > lastSynth)) lastSynth = c.lastConsolidated;
      }
    }
    if (lastSynth) parts.push(`last synthesis ${formatAge(lastSynth)}`);
    healthyStatsHtml = `<div class="consolidation-stat">${parts.map(esc).join(' · ')}</div>`;
  }

  const errorHtml = health.last_error
    ? `<div class="consolidation-stat consol-error">Last error: ${esc(String(health.last_error).slice(0, 120))} <span style="color:var(--text-muted)">(${esc(formatAge(health.last_error_at))})</span></div>`
    : '';

  return `<h3>Consolidation Worker</h3>
    <div class="consolidation-health">
      <div class="consolidation-status">
        <span class="status-dot ${esc(dotClass)}">●</span>
        <span class="${esc(labelClass)}">${esc(statusLabel)}</span>
      </div>
      ${healthyStatsHtml}
      ${errorHtml}
      ${callsHtml}
    </div>`;
}

module.exports = {
  esc,
  humanizeTaskName,
  formatAge,
  formatAgeWithTimestamp,
  formatUptime,
  m5StatusCard,
  m5CapabilityMapCard,
  m5FindingsCard,
  m5RoutingCard,
  m5ModelsCard,
  m5SimpleModelsCard,
  m5OverviewCard,
  m5UsageCard,
  huginTasksCard,
  taskHistoryCard,
  consolidationHealthCard,
  consolidationStatusCard,
  projectsListCard,
  briefingFullCard,
};
