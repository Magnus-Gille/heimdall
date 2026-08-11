'use strict';

/**
 * components.js — v2 reusable render components. Every component returns an
 * HTML string. Status is expressed as color + SHAPE + TEXT together
 * (WCAG 1.4.1); callers never rely on color alone.
 *
 * Canonical status states: 'ok' | 'warn' | 'crit' | 'stale' | 'info'.
 */

const { esc, formatUptime, formatBytes, formatAge } = require('./util');

const STATUS = {
  ok:    { glyph: '✓', label: 'Healthy' },
  warn:  { glyph: '▲', label: 'Warning' },
  crit:  { glyph: '●', label: 'Critical' },
  info:  { glyph: '●', label: 'Info' },
  stale: { glyph: '?', label: 'Unknown' },
};

function normState(state) {
  return Object.hasOwn(STATUS, state) ? state : 'stale';
}

/**
 * Direction-aware threshold helper (#74).
 * Returns 'ok' | 'warn' | 'crit' | 'stale'.
 *   non-finite value (undefined/null/NaN): 'stale' — absent data must never read as
 *     healthy on the Memory Health panel (§3.6). Callers that already guard presence
 *     still get the right answer; this makes the bare helper safe by default.
 *   dir 'high-bad' (default): value >= crit → crit, >= warn → warn, else ok  (latency, age, failures)
 *   dir 'low-bad':            value <= crit → crit, <= warn → warn, else ok  (coverage %)
 */
function statusFor(value, { warn, crit, dir = 'high-bad' } = {}) {
  if (!Number.isFinite(value)) return 'stale';
  if (dir === 'low-bad') {
    if (value <= crit) return 'crit';
    if (value <= warn) return 'warn';
    return 'ok';
  }
  // high-bad (default)
  if (value >= crit) return 'crit';
  if (value >= warn) return 'warn';
  return 'ok';
}

/** Derive a status from a 0–100 utilization value. */
function pctState(pct, warn = 80, crit = 92) {
  if (pct == null || Number.isNaN(pct)) return 'stale';
  return statusFor(pct, { warn, crit, dir: 'high-bad' });
}

/** Inline status indicator: shape glyph in the status color. */
function statusDot(state) {
  const s = normState(state);
  return `<span class="status-dot is-${s}" aria-hidden="true">${STATUS[s].glyph}</span>`;
}

/** Pill: shape glyph + text label, tinted background. */
function statusBadge(state, label) {
  const s = normState(state);
  const text = label != null ? label : STATUS[s].label;
  return `<span class="status-badge is-${s}"><span class="glyph" aria-hidden="true">${STATUS[s].glyph}</span>${esc(text)}</span>`;
}

/** Bare meter (track + fill). pct clamped 0–100; fill colored by state. */
function meter(pct, state) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const s = state ? normState(state) : pctState(v);
  const cls = s === 'ok' ? '' : ` is-${s}`;
  return `<div class="meter-track"><div class="meter-fill${cls}" style="width:${v.toFixed(1)}%"></div></div>`;
}

/** Labeled meter row: label, value, then a full-width track. */
function meterRow(label, valueText, pct, state) {
  return `<div class="meter-row">
    <span class="meter-label">${esc(label)}</span>
    <span class="meter-val">${esc(valueText)}</span>
    ${meter(pct, state)}
  </div>`;
}

function kpi(value, label, state, title) {
  const cls = state ? ` is-${normState(state)}` : '';
  const titleAttr = title ? ` title="${esc(title)}"` : '';
  return `<div class="kpi"${titleAttr}><span class="kpi-val${cls}">${esc(value)}</span><span class="kpi-label">${esc(label)}</span></div>`;
}

function metricRow(label, value) {
  return `<div class="metric-row"><span class="metric-label">${esc(label)}</span><span class="metric-val">${esc(value)}</span></div>`;
}

/**
 * Server-rendered sparkline SVG from an array of numbers.
 * Returns an empty placeholder if fewer than 2 finite points.
 */
function sparklineSvg(values, { width = 140, height = 30, pad = 2 } = {}) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return `<svg class="sparkline" width="${width}" height="${height}" aria-hidden="true"></svg>`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pts = nums.map((n, i) => {
    const x = pad + (i / (nums.length - 1)) * innerW;
    const y = pad + innerH - ((n - min) / span) * innerH;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `M${pts[0][0].toFixed(1)},${(height - pad).toFixed(1)} ` +
    pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1][0].toFixed(1)},${(height - pad).toFixed(1)} Z`;
  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path d="${line}"/></svg>`;
}

function emptyState(message, glyph = '—') {
  return `<div class="empty"><span class="glyph" aria-hidden="true">${esc(glyph)}</span>${esc(message)}</div>`;
}

/** Aggregate health strip — overview-first glanceability. */
function aggStrip(counts = {}) {
  const order = [
    ['crit', 'crit', '●'],
    ['warn', 'warn', '▲'],
    ['stale', 'stale', '?'],
    ['ok', 'ok', '✓'],
  ];
  const items = order
    .filter(([key]) => counts[key] != null)
    .map(([key, cls, glyph]) =>
      `<span class="agg-item"><span class="status-dot is-${cls}" aria-hidden="true">${glyph}</span><span class="n">${esc(counts[key])}</span></span>`)
    .join('');
  return `<div class="agg-strip" role="status" aria-label="Aggregate health">${items}</div>`;
}

/** Map fleet machine liveness → status view. */
const MACHINE_STATE = {
  online:   { cls: 'ok',    glyph: '✓', label: 'Online' },
  stale:    { cls: 'warn',  glyph: '▲', label: 'Stale' },
  offline:  { cls: 'crit',  glyph: '●', label: 'Offline' },
  sleeping: { cls: 'stale', glyph: '?', label: 'Sleeping' },
  'never-seen': { cls: 'stale', glyph: '?', label: 'Never seen' },
  'retired-unregistered': { cls: 'stale', glyph: '—', label: 'Retired / unregistered' },
};
const AGENT_VERSION_STATE = {
  current: { cls: 'ok', label: 'current' },
  drift: { cls: 'warn', label: 'drift' },
  unknown: { cls: 'stale', label: 'unknown' },
};

/**
 * Fleet machine card.
 * m: { hostname, label, ip, platform, state, cpu_pct, ram_used_pct,
 *      ram_used_mb, ram_total_mb, temp_cpu_c, uptime_s, lastSeen, spark[],
 *      tempSpark[], href }
 */
function machineCard(m) {
  const view = Object.hasOwn(MACHINE_STATE, m.state) ? MACHINE_STATE[m.state] : MACHINE_STATE.sleeping;
  const tag = (clsTxt) => clsTxt ? `<span class="mono">${esc(clsTxt)}</span>` : '';
  const tempStr = m.temp_cpu_c != null ? `${Number(m.temp_cpu_c).toFixed(0)}°C` : '—';
  const ramStr = (m.ram_used_mb != null && m.ram_total_mb != null)
    ? `${formatBytes(m.ram_used_mb * 1024 * 1024)} / ${formatBytes(m.ram_total_mb * 1024 * 1024)}`
    : (m.ram_used_pct != null ? `${Number(m.ram_used_pct).toFixed(0)}%` : '—');
  const offline = ['offline', 'sleeping', 'never-seen', 'retired-unregistered'].includes(m.state);
  const subBits = [
    tag(m.ip),
    tag(m.platform),
    m.temp_cpu_c != null ? `<span>${esc(tempStr)}</span>` : '',
  ].filter(Boolean);
  const agentState = Object.hasOwn(AGENT_VERSION_STATE, m.agentVersionState)
    ? AGENT_VERSION_STATE[m.agentVersionState]
    : AGENT_VERSION_STATE.unknown;
  const agentLine = `<div class="machine-sub machine-agent"><span class="mono">agent ${esc(m.agentVersion || 'unknown')}</span>${statusBadge(agentState.cls, agentState.label)}</div>`;
  const inner = `
    <div class="machine-head">
      <span class="machine-name">${esc(m.label || m.hostname)}</span>
      ${statusBadge(view.cls, view.label)}
    </div>
    ${subBits.length ? `<div class="machine-sub">${subBits.join(' ')}</div>` : ''}
    ${agentLine}
    <div class="machine-metrics">
      ${meterRow('CPU', offline ? '—' : `${Number(m.cpu_pct || 0).toFixed(0)}%`, offline ? 0 : m.cpu_pct, offline ? 'stale' : pctState(m.cpu_pct))}
      ${meterRow('RAM', offline ? '—' : ramStr, offline ? 0 : m.ram_used_pct, offline ? 'stale' : pctState(m.ram_used_pct))}
    </div>
    ${m.spark && m.spark.length >= 2 ? `<div class="machine-spark"><span class="spark-cap">CPU</span>${sparklineSvg(m.spark)}</div>` : ''}
    ${m.tempSpark && m.tempSpark.length >= 2 ? `<div class="machine-spark is-temp"><span class="spark-cap">Temp</span>${sparklineSvg(m.tempSpark)}</div>` : ''}
    <div class="machine-foot">
      <span>${offline
        ? (m.state === 'never-seen' ? 'never seen' : (m.state === 'retired-unregistered' ? 'historical' : 'offline'))
        : `up ${esc(formatUptime(m.uptime_s))}`}</span>
      <span>${m.lastSeen ? `seen ${esc(formatAge(m.lastSeen))}` : (m.state === 'never-seen' ? 'no telemetry yet' : '')}</span>
    </div>`;
  if (m.href) return `<a class="card machine-card" href="${esc(m.href)}">${inner}</a>`;
  return `<div class="card machine-card">${inner}</div>`;
}

/**
 * Service status header.
 * s: { label, version, kind, state, checkedAgo, latencyMs }
 */
function serviceStatusHeader(s) {
  const meta = [];
  if (s.version) meta.push(`<span class="tag">v${esc(s.version)}</span>`);
  if (s.kind) meta.push(`<span class="tag">${esc(s.kind)}</span>`);
  if (s.latencyMs != null) meta.push(`<span>${esc(s.latencyMs)} ms</span>`);
  if (s.checkedAgo) meta.push(`<span>${esc(s.checkedLabel || 'checked')} ${esc(s.checkedAgo)}</span>`);
  return `<div class="svc-head">
    <div class="svc-title-row">
      ${statusBadge(normState(s.state))}
      <span class="svc-title">${esc(s.label)}</span>
    </div>
    <div class="svc-meta">${meta.join('')}</div>
  </div>`;
}

/**
 * Deployment-status block.
 * d: { running, enabled, uptime_s, rss, deployed, latest, behind, dirty }
 */
function deployBlock(d) {
  const stateBits = [];
  if (d.running != null) stateBits.push(`${statusDot(d.running ? 'ok' : 'crit')} ${d.running ? 'Running' : 'Stopped'}`);
  if (d.enabled != null) stateBits.push(d.enabled ? 'enabled' : 'disabled');
  if (d.uptime_s != null) stateBits.push(`up ${esc(formatUptime(d.uptime_s))}`);
  if (d.rss != null) stateBits.push(`RSS ${esc(formatBytes(d.rss))}`);

  let commits = '';
  if (d.deployed) {
    const behind = d.behind || 0;
    const driftPill = behind > 0
      ? `<span class="drift behind">${behind} behind${d.dirty ? ' · dirty' : ''}</span>`
      : `<span class="drift ok">up to date${d.dirty ? ' · dirty' : ''}</span>`;
    const latest = (d.latest && d.latest !== d.deployed)
      ? `<span class="arrow">→</span><span class="commit">${esc(d.latest)}</span>` : '';
    commits = `<div class="deploy-commits"><span class="commit">${esc(d.deployed)}</span>${latest}${driftPill}</div>`;
  }
  return `<div class="deploy">
    ${stateBits.length ? `<div class="deploy-state">${stateBits.join(' · ')}</div>` : ''}
    ${commits}
  </div>`;
}

/**
 * Consolidated alert strip.
 * alerts: [{ id, severity('info'|'warn'|'crit'), source, title, body, count }]
 */
function alertStrip(alerts) {
  if (!alerts || !alerts.length) return '';
  const sevRank = { crit: 0, warn: 1, info: 2 };
  const items = [...alerts]
    .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))
    .map((a) => {
      const sev = ['crit', 'warn', 'info'].includes(a.severity) ? a.severity : 'info';
      const role = sev === 'crit' ? ' role="alert"' : '';
      const count = a.count > 1 ? `<span class="alert-count">${esc(a.count)}×</span>` : '';
      const src = a.source ? `<span class="alert-src">${esc(a.source)}</span>` : '';
      const dismiss = a.id != null
        ? `<button class="alert-dismiss" title="Dismiss" hx-delete="/api/alerts/${esc(a.id)}" hx-target="closest .alert" hx-swap="outerHTML">×</button>`
        : '';
      return `<div class="alert ${sev}"${role}>
        <span class="alert-sev">${esc(sev)}</span>
        <span class="alert-body"><strong>${esc(a.title)}</strong>${a.body ? ` — ${esc(a.body)}` : ''} ${src}</span>
        ${count}${dismiss}
      </div>`;
    }).join('');
  return `<div class="alert-strip" role="region" aria-label="Active alerts">${items}</div>`;
}

/**
 * Map persisted `alerts` rows (db schema: severity 'warning'/'critical'/…, `detail`,
 * `host`/`source`) onto the alertStrip view-model (severity 'crit'/'warn'/'info', `body`,
 * `source`). Bridges the v1 alert vocabulary to the v2 sticky strip. Pure.
 */
const ALERT_SEV_MAP = {
  critical: 'crit', crit: 'crit', error: 'crit', fail: 'crit',
  warning: 'warn', warn: 'warn', degraded: 'warn',
  info: 'info', notice: 'info',
};
function activeAlertsStrip(rows) {
  const model = (Array.isArray(rows) ? rows : []).map((r) => {
    const sev = ALERT_SEV_MAP[String((r && r.severity) || '').toLowerCase()] || 'info';
    const detail = r && r.detail ? String(r.detail) : '';
    const body = detail.length > 160 ? `${detail.slice(0, 157)}…` : detail;
    return {
      id: r && r.id != null ? r.id : null,
      severity: sev,
      title: (r && r.title) || 'Alert',
      body: body || null,
      source: (r && (r.source || r.host)) || null,
    };
  });
  return alertStrip(model);
}

module.exports = {
  STATUS,
  normState,
  statusFor,
  pctState,
  statusDot,
  statusBadge,
  meter,
  meterRow,
  kpi,
  metricRow,
  sparklineSvg,
  emptyState,
  aggStrip,
  machineCard,
  serviceStatusHeader,
  deployBlock,
  alertStrip,
  activeAlertsStrip,
};
