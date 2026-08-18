'use strict';

const Fastify = require('fastify');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load env file so runtime config (HEIMDALL_BIND, HEIMDALL_NOTIFY_CHAT_ID, etc.) is available
const ENV_FILE = path.join(os.homedir(), '.heimdall', 'env');
try {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* env file not present */ }
const { resolveRuntimeVersion } = require('./version');
const { openDatabase, getLatestMetrics, getMetricHistoryWithRollup, getRecentEvents, searchEvents, getActiveAlerts, getUnacknowledgedAlerts, acknowledgeAlert, getLatestServiceVersions, getDriftHistory, getLastCollectionTime, getProcessSnapshot, isValidMetricHost, getMaintenanceExecutionResult } = require('./db');
const { alertsPage, alertsListFragment, alertsCountBadge } = require('./render/alerts');
const { handleAlertIngest } = require('./alert-ingest');
const { handlePanelIngest, PANEL_SCHEMA_DOC } = require('./panel-ingest');
const { handleMaintenanceExecutionIngest } = require('./maintenance-execution-ingest');
const { consolidationHealthCard, consolidationStatusCard, projectsListCard, taskHistoryCard, formatAgeWithTimestamp } = require('./html');
const { fetchLedger, fetchModels, summarizeModels, fetchMetrics, parseMetrics, summarizeUsageMetrics, ledgerToMatrix, tallyVerdicts, deriveRoutingFromLedger, generateFindings, STATIC_FINDINGS } = require('./m5');
const { listArticles, getArticle, isValidSlug, EXPORT_DIR } = require('./read-docs');
const { buildEpub } = require('./epub');
const { loadApiKey, fetchProjects, fetchLayout, buildProjectTree, fetchConsolidationHealth, fetchConsolidationDetail, fetchConsolidationActivity, fetchMemoryHealth, fetchMemoryAttention } = require('./munin-projects');
const { fetchLatestBriefing } = require('./skuld-briefing');
const { getDeploymentAudit } = require('./deployments');
const { prepareChartData, linearRegression } = require('./charts');
const { readHuginTasks, readHuginTaskFull, getTaskSuccessRate, getTaskQueueMetrics, getTimeoutCalibration, readHuginHeartbeat } = require('./hugin');
const { getState } = require('./nas-state');
const { computeOverallStatus } = require('./status');
const { detectCausalityHint } = require('./causality');
// v2 platform: fleet telemetry (push-agent ingest + fleet view)
const { reconcileFleetHostConfig } = require('./db');
const { handlePush } = require('./fleet/ingest');
const { checkFleetAuth } = require('./fleet/auth');
const { fleetPage, fleetGridFragment } = require('./fleet/render');
const { loadFleetConfig } = require('./fleet/config');
// v2 platform: self-describing service contract + discovery
const { pollAll } = require('./discovery');
const { loadServices, loadServicesWithMeta } = require('./config/services');
const { loadDiskThresholds } = require('./config/disk-thresholds');
const { assertSafeStartupTargets } = require('./config/live-config');
const { servicesIndexPage, servicesGridFragment, servicePage, buildSelfDescriptor, selfSnapshot, withPushedStatus } = require('./render/service-page');
const {
  overviewPage, overviewStatusSection, buildOverviewStatus, deploysGridFragment, overviewFleetMachines,
} = require('./render/overview');
const { buildMachines } = require('./fleet/render');
// v2 Read pages (replace the v1 readListPage/readArticlePage from html.js).
const { readListPage, readArticlePage } = require('./render/read');
// v2 Projects page (replaces the v1 projectsPage from html.js).
const { projectsPage: projectsPageV2 } = require('./render/projects');
const { consolidationPage } = require('./render/consolidation');
const { insightsPage } = require('./render/insights');
const { fetchInsightsRecords, buildTrend, buildObjective } = require('./insights');
const { upsertServiceSnapshot, getServiceSnapshots, getServiceSnapshot, getPanelsForService, listPanelServices, listPanels, pruneServiceSnapshots } = require('./db');
const { getPlugin } = require('./plugins');
const { panelAliasOwnerOf, panelServiceIdsFor } = require('./plugins/known-panels');
const { m5Snapshot } = require('./plugins/inference');
const { mcpSnapshot } = require('./mcp-probe');

// Service names of the synthetic snapshots written outside the polled registry:
// selfSnapshot → 'heimdall', m5Snapshot → 'm5-gateway', mcpSnapshot → 'munin-mcp'.
// Kept in the #93 reconcile keep-set so their rows are never pruned as orphans.
const SYNTHETIC_SERVICE_NAMES = ['heimdall', 'm5-gateway', 'munin-mcp'];

// NOTE: the body below is intentionally left un-indented to keep this refactor's
// diff minimal/reviewable — buildApp() is a pure scope+lifecycle wrap (no logic change).
function buildApp(injectedDb, options = {}) {
const runtimeRoot = options.runtimeRoot || path.join(__dirname, '..');
const now = typeof options.now === 'function' ? options.now : Date.now;
let gitVersion = resolveRuntimeVersion(runtimeRoot);
const app = Fastify({ logger: false });

// Grimnir writes .deployed-commit after the service restart succeeds. Refresh
// on requests so the first post-deploy health/page read sees that authoritative
// stamp instead of keeping the pre-restart value for an entire process lifetime.
app.addHook('onRequest', async () => {
  gitVersion = resolveRuntimeVersion(runtimeRoot);
});

// Rate limiting — 100 requests per minute per IP
app.register(require('@fastify/rate-limit'), {
  max: 100,
  timeWindow: '1 minute',
});

const db = injectedDb || openDatabase();

// Reconcile fleet membership from Grimnir's canonical node registry. Observed-
// only rows stay in SQLite as historical telemetry and are marked retired
// instead of inflating the fleet. An unavailable/malformed registry must not be
// mistaken for an intentionally empty fleet: preserve lifecycle state until a
// valid authority is available.
const fleetConfig = loadFleetConfig(undefined, { grimnirPath: options.grimnirPath });
if (fleetConfig.authority.status === 'loaded') {
  try {
    reconcileFleetHostConfig(db, fleetConfig.hosts, fleetConfig.hostAliases);
  } catch (e) { console.error('fleet membership reconcile failed:', e.message); }
} else {
  console.error(`fleet membership authority ${fleetConfig.authority.status}; preserving existing lifecycle state`);
}

// Service discovery: load the service registry and seed Heimdall's own snapshot
// (dogfoods the contract) so /services is populated before the first poll.
// Derive the polled service list from grimnir services.json (single source of
// truth) merged with heimdall's overlay; falls back to the committed list if
// grimnir's file is unreadable. See src/config/services.js (#92).
let serviceConfigs = [];
try {
  serviceConfigs = loadServices();
} catch (e) { console.error('failed to load service registry:', e.message); }
try { upsertServiceSnapshot(db, selfSnapshot(gitVersion)); } catch (e) { console.error('self snapshot seed failed:', e.message); }
// M5 has no /heimdall.json yet — Heimdall self-describes it (kind "inference")
// from collected metrics, the same way it self-describes itself.
try { upsertServiceSnapshot(db, m5Snapshot(db)); } catch (e) { console.error('m5 snapshot seed failed:', e.message); }
// Munin MCP transport — Heimdall-built descriptor carrying its alert rule (engine-evaluated).
try { upsertServiceSnapshot(db, mcpSnapshot(db)); } catch (e) { console.error('mcp snapshot seed failed:', e.message); }

// Security headers
app.addHook('onRequest', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '0');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

// Static file routes — serve vendored assets from public/
const STATIC_FILES = {
  '/charts-client.js': { file: 'charts-client.js', ct: 'application/javascript; charset=utf-8' },
  '/htmx.min.js': { file: 'htmx.min.js', ct: 'application/javascript; charset=utf-8' },
  '/chart.umd.min.js': { file: 'chart.umd.min.js', ct: 'application/javascript; charset=utf-8' },
  '/chartjs-adapter-date-fns.bundle.min.js': { file: 'chartjs-adapter-date-fns.bundle.min.js', ct: 'application/javascript; charset=utf-8' },
  '/heimdall-logo.png': { file: 'heimdall-logo.png', ct: 'image/png' },
  // v2 design-system assets
  '/css/tokens.css': { file: 'css/tokens.css', ct: 'text/css; charset=utf-8' },
  '/css/layout.css': { file: 'css/layout.css', ct: 'text/css; charset=utf-8' },
  '/css/components.css': { file: 'css/components.css', ct: 'text/css; charset=utf-8' },
  '/css/inference.css': { file: 'css/inference.css', ct: 'text/css; charset=utf-8' },
  '/css/hugin.css': { file: 'css/hugin.css', ct: 'text/css; charset=utf-8' },
  '/css/skuld.css': { file: 'css/skuld.css', ct: 'text/css; charset=utf-8' },
  '/css/reader.css': { file: 'css/reader.css', ct: 'text/css; charset=utf-8' },
  '/css/projects.css': { file: 'css/projects.css', ct: 'text/css; charset=utf-8' },
  '/css/consolidation.css': { file: 'css/consolidation.css', ct: 'text/css; charset=utf-8' },
  '/css/insights.css': { file: 'css/insights.css', ct: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', ct: 'application/javascript; charset=utf-8' },
  '/reader.js': { file: 'reader.js', ct: 'application/javascript; charset=utf-8' },
};

for (const [route, { file, ct }] of Object.entries(STATIC_FILES)) {
  app.get(route, async (request, reply) => {
    const filePath = path.join(__dirname, '..', 'public', file);
    try {
      const content = fs.readFileSync(filePath);
      // Vendor JS files are immutable; app CSS changes with deploys
      const maxAge = file.endsWith('.min.js') ? 86400 * 30 : 3600;
      reply.header('Content-Type', ct).header('Cache-Control', `public, max-age=${maxAge}`).send(content);
    } catch {
      reply.code(404).send('Not found');
    }
  });
}

// Favicon fallback — inline SVG is in the HTML, this just silences 404s
app.get('/favicon.ico', async (request, reply) => {
  reply.code(204).send();
});

// Localhost-only guard for sensitive operator APIs. Verify the TCP peer rather
// than trusting request.ip or the absence of one provider-specific header.
// Forwarded headers are rejected as well: a reverse proxy commonly connects
// from loopback, but that does not make its remote caller local.
function localhostOnly(request, reply) {
  const peer = request.raw && request.raw.socket
    ? request.raw.socket.remoteAddress
    : null;
  const isLoopback = typeof peer === 'string' && (
    peer === '::1'
    || peer.startsWith('127.')
    || peer.startsWith('::ffff:127.')
  );
  const forwarded = [
    'forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip',
  ].some((name) => request.headers[name] != null);
  if (!isLoopback || forwarded) {
    reply.code(403).send({ error: 'localhost only' });
    return false;
  }
  return true;
}

// Health endpoint
app.get('/health', async () => {
  return { status: 'ok', uptime: process.uptime() };
});

app.get('/api/health', async () => {
  return { status: 'ok', version: gitVersion, service: 'heimdall' };
});

// Full infrastructure status — localhost only, for AI agent consumption
app.get('/api/status', async (request, reply) => {
  if (!localhostOnly(request, reply)) return;

  const huginMetrics = getLatestMetrics(db, 'control-node');
  const nasMetrics = getLatestMetrics(db, 'nas');
  const nasState = getState(db);
  const alerts = getActiveAlerts(db);
  const events = getRecentEvents(db, 10);
  const versions = getLatestServiceVersions(db);
  const tasks = readHuginTasks();
  const heartbeat = readHuginHeartbeat();
  const lastCollection = {
    'control-node': getLastCollectionTime(db, 'control-node'),
    nas: getLastCollectionTime(db, 'nas'),
  };

  function metricsToObj(rows) {
    const obj = {};
    for (const r of rows) {
      obj[r.metric] = {
        value: r.value,
        unit: r.unit,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        timestamp: r.timestamp,
      };
    }
    return obj;
  }

  const overallStatus = computeOverallStatus(db);

  // MCP transport status from latest metrics
  const hmMap = {};
  for (const r of huginMetrics) hmMap[r.metric] = r;
  const mcpHealthy = hmMap.mcp_healthy;
  const mcpLatency = hmMap.mcp_latency_ms;
  const mcpError = hmMap.mcp_error;
  const mcp = {
    healthy: mcpHealthy ? mcpHealthy.value === 1 : null,
    latency_ms: mcpLatency ? mcpLatency.value : null,
    last_checked: mcpHealthy ? mcpHealthy.timestamp : null,
    error: mcpError && mcpError.metadata ? (() => { try { return JSON.parse(mcpError.metadata).error; } catch { return null; } })() : null,
  };

  return {
    generated_at: new Date().toISOString(),
    overall_status: overallStatus,
    hosts: {
      'control-node': {
        metrics: metricsToObj(huginMetrics),
        last_collection: lastCollection['control-node'],
      },
      nas: {
        metrics: metricsToObj(nasMetrics),
        state: nasState,
        last_collection: lastCollection.nas,
      },
    },
    mcp,
    hugin_heartbeat: heartbeat,
    alerts,
    deploy: versions,
    tasks,
    recent_events: events,
  };
});

// Brief text summary — localhost only, for AI agents that prefer prose
app.get('/api/summary', async (request, reply) => {
  if (!localhostOnly(request, reply)) return;

  const huginMetrics = getLatestMetrics(db, 'control-node');
  const nasMetrics = getLatestMetrics(db, 'nas');
  const nasState = getState(db);
  const alerts = getActiveAlerts(db);
  const versions = getLatestServiceVersions(db);
  const tasks = readHuginTasks();
  const heartbeat = readHuginHeartbeat();

  const hm = {};
  for (const r of huginMetrics) hm[r.metric] = r;
  const nm = {};
  for (const r of nasMetrics) nm[r.metric] = r;

  const overallStatus = computeOverallStatus(db);
  const lines = [`# Infrastructure Status — ${new Date().toISOString()}\n`];

  // Overall status
  lines.push(`## Overall: ${overallStatus.state.toUpperCase()}`);
  for (const r of overallStatus.reasons) lines.push(`- ${r}`);
  lines.push('');

  // Host health
  lines.push('## Hugin-Munin (Pi)');
  if (hm.mem_used_pct) lines.push(`- RAM: ${Math.round(hm.mem_used_pct.value)}%`);
  if (hm.disk_used_pct_sd) lines.push(`- Disk: ${hm.disk_used_pct_sd.value}%`);
  if (hm.cpu_temp) lines.push(`- Temp: ${hm.cpu_temp.value}°C`);
  if (hm.load_1m) lines.push(`- Load: ${hm.load_1m.value}`);
  lines.push('');

  lines.push('## NAS');
  if (nm.mem_used_pct) lines.push(`- RAM: ${Math.round(nm.mem_used_pct.value)}%`);
  if (nm.disk_used_pct_nas) lines.push(`- Disk: ${nm.disk_used_pct_nas.value}%`);
  if (nm.cpu_temp) lines.push(`- Temp: ${nm.cpu_temp.value}°C`);
  lines.push(`- State: ${nasState.state || 'unknown'}${nasState.since ? ` (since ${nasState.since})` : ''}`);
  lines.push('');

  // Network quality
  if (hm.net_latency_nas_ms) lines.push(`- NAS latency: ${hm.net_latency_nas_ms.value}ms, loss: ${hm.net_loss_nas_pct?.value || 0}%`);
  if (hm.net_latency_internet_ms) lines.push(`- Internet latency: ${hm.net_latency_internet_ms.value}ms, loss: ${hm.net_loss_internet_pct?.value || 0}%`);
  lines.push('');

  // MCP transport status
  lines.push('## MCP Transport');
  if (hm.mcp_healthy) {
    const mcpOk = hm.mcp_healthy.value === 1;
    if (mcpOk) {
      lines.push(`- Status: healthy (${hm.mcp_latency_ms?.value || '?'}ms latency)`);
    } else {
      let mcpErr = 'unknown';
      try { mcpErr = hm.mcp_error?.metadata ? JSON.parse(hm.mcp_error.metadata).error || 'unknown' : 'unknown'; } catch { /* ok */ }
      lines.push(`- Status: DOWN — Claude sessions on this Pi cannot access Munin tools`);
      lines.push(`- Error: ${mcpErr}`);
    }
  } else {
    lines.push('- Status: no data yet');
  }
  lines.push('');

  // Hugin dispatcher
  lines.push('## Hugin Dispatcher');
  if (heartbeat) {
    const { formatUptime } = require('./html');
    lines.push(`- Status: ${heartbeat.status}`);
    lines.push(`- Uptime: ${formatUptime(heartbeat.uptime_s)}`);
    lines.push(`- Last poll: ${heartbeat.polled_at || 'never'}`);
    lines.push(`- Queue depth: ${heartbeat.queue_depth ?? '?'}`);
    lines.push(`- Current task: ${heartbeat.current_task || 'idle'}`);
  } else {
    lines.push('- No heartbeat data');
  }
  lines.push('');

  // Capacity trends
  lines.push('## Capacity Trends');
  try {
    for (const [label, host, diskMetric, diskTotalMetric] of [
      ['Hugin-Munin SD', 'control-node', 'disk_used_pct_sd', 'disk_total_sd'],
      ['NAS', 'nas', 'disk_used_pct_nas', 'disk_total_nas'],
    ]) {
      const thirtyDaysAgoStr = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
      const dHistory = getMetricHistoryWithRollup(db, host, diskMetric, thirtyDaysAgoStr, new Date().toISOString(), fleetConfig.hostAliases);
      if (dHistory.length >= 10) {
        const t0 = new Date(dHistory[0].timestamp).getTime();
        const pts = dHistory.map(d => ({ x: (new Date(d.timestamp).getTime() - t0) / 86400000, y: d.value }));
        const reg = linearRegression(pts);
        const pts7d = pts.filter(p => p.x >= (pts[pts.length - 1].x - 7));
        const reg7 = pts7d.length >= 5 ? linearRegression(pts7d) : null;
        const decelRatio = (reg7 && reg && reg.slope > 0) ? reg7.slope / reg.slope : null;
        if (reg && reg.slope > 0) {
          const currentPct = pts[pts.length - 1].y;
          const totalRow = host === 'nas' ? nm : hm;
          const totalBytes = totalRow[diskTotalMetric]?.value;
          // Detect trend
          if (reg7 && (reg7.slope <= 0 || decelRatio < 0.3)) {
            const growthSlope = reg7.slope > 0 ? reg7.slope : 0;
            const growthStr = totalBytes ? `${Math.round((growthSlope / 100) * totalBytes / (1024 * 1024))} MB/day` : `${growthSlope.toFixed(2)}%/day`;
            lines.push(`- ${label}: stabilizing (${growthStr}, growth slowing)`);
          } else if (decelRatio != null && decelRatio < 0.7 && reg7.slope > 0) {
            const daysLeft = (100 - currentPct) / reg7.slope;
            const growthStr = totalBytes ? `${Math.round((reg7.slope / 100) * totalBytes / (1024 * 1024))} MB/day` : `${reg7.slope.toFixed(2)}%/day`;
            lines.push(`- ${label}: growing ${growthStr} (decelerating), full in ~${Math.round(daysLeft)}d`);
          } else {
            const daysLeft = (100 - currentPct) / reg.slope;
            const growthStr = totalBytes ? `${Math.round((reg.slope / 100) * totalBytes / (1024 * 1024))} MB/day` : `${reg.slope.toFixed(2)}%/day`;
            lines.push(`- ${label}: growing ${growthStr}, full in ~${Math.round(daysLeft)}d`);
          }
        } else {
          lines.push(`- ${label}: stable or decreasing`);
        }
      }
    }
    // Memory trend
    const memH = getMetricHistoryWithRollup(db, 'control-node', 'mem_used_pct', new Date(Date.now() - 7 * 24 * 3600000).toISOString(), new Date().toISOString(), fleetConfig.hostAliases);
    if (memH.length >= 10) {
      const t0m = new Date(memH[0].timestamp).getTime();
      const memPts = memH.map(d => ({ x: (new Date(d.timestamp).getTime() - t0m) / 86400000, y: d.value }));
      const memReg = linearRegression(memPts);
      if (memReg && Math.abs(memReg.slope) >= 0.1) {
        lines.push(`- Pi RAM: ${memReg.slope > 0 ? 'rising' : 'falling'} ${Math.abs(memReg.slope).toFixed(1)}%/day`);
      }
    }
  } catch { /* capacity trends are best-effort */ }
  lines.push('');

  // Alerts
  if (alerts.length > 0) {
    lines.push(`## Alerts (${alerts.length} active)`);
    for (const a of alerts) lines.push(`- [${a.severity}] ${a.title}: ${a.detail || ''}`);
    lines.push('');
  } else {
    lines.push('## Alerts: none\n');
  }

  // Deploy
  if (versions.length > 0) {
    lines.push('## Deploy Versions');
    for (const v of versions) {
      const drift = v.deployed_commit !== v.latest_commit && v.deployed_commit && v.latest_commit ? ' ⚠ DRIFT (GitHub ahead)' : '';
      lines.push(`- ${v.service}: running=${v.deployed_commit || '?'} github=${v.latest_commit || '?'}${drift}`);
    }
    lines.push('');
  }

  // Tasks
  const activeTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'done');
  if (activeTasks.length > 0) {
    lines.push(`## Active Tasks (${activeTasks.length})`);
    for (const t of activeTasks) lines.push(`- [${t.status}] ${t.name}`);
    lines.push('');
  }

  reply.header('Content-Type', 'text/plain; charset=utf-8').send(lines.join('\n'));
});

// Dashboard page
app.get('/', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8').send(overviewPage(gitVersion, {
    db,
    now: Date.now(),
    thresholds: fleetConfig.thresholds,
    snapshots: snapshotsWithPushedOnly(),
    alertCount: getActiveAlerts(db).length,
    versions: getLatestServiceVersions(db),
    overallStatus: computeOverallStatus(db),
  }));
});

// Overview status hero — self-refreshing fragment.
app.get('/api/overview/status', async (request, reply) => {
  const status = buildOverviewStatus({
    machines: overviewFleetMachines(
      buildMachines(db, Date.now(), fleetConfig.thresholds, { baselineVersion: gitVersion }),
    ),
    snapshots: snapshotsWithPushedOnly(),
    alertCount: getActiveAlerts(db).length,
    versions: getLatestServiceVersions(db),
    overallStatus: computeOverallStatus(db),
  });
  reply.header('Content-Type', 'text/html; charset=utf-8').send(overviewStatusSection(status));
});

// Overview fleet attention excludes M5: its authoritative live state is the gateway panel above.
app.get('/api/overview/fleet', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(fleetGridFragment(db, Date.now(), fleetConfig.thresholds, {
      exceptionsOnly: true,
      excludeHostnames: ['m5'],
      baselineVersion: gitVersion,
    }));
});

// Overview Deployments section — self-refreshing fragment.
app.get('/api/overview/deploys', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(deploysGridFragment(getLatestServiceVersions(db), {
      exceptionsOnly: request.query.mode === 'exceptions',
    }));
});

app.get('/projects', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8').send(projectsPageV2(gitVersion));
});

app.get('/read', async (request, reply) => {
  const articles = await listArticles();
  reply.header('Content-Type', 'text/html; charset=utf-8').send(readListPage(gitVersion, articles));
});

app.get('/read/:slug', async (request, reply) => {
  const { slug } = request.params;
  if (!isValidSlug(slug)) return reply.code(404).send('Not found');
  const articles = await listArticles();
  const idx = articles.findIndex(a => a.slug === slug);
  if (idx === -1) return reply.code(404).send('Not found');
  const article = articles[idx];
  const prev = articles[idx - 1] || null;
  const next = articles[idx + 1] || null;
  reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(readArticlePage(gitVersion, article, { prev, next }));
});

app.get('/read/:slug.epub', async (request, reply) => {
  const { slug } = request.params;
  if (!isValidSlug(slug)) return reply.code(404).send('Not found');
  const article = await getArticle(slug);
  if (!article) return reply.code(404).send('Not found');
  const epub = await buildEpub({
    title: article.title,
    markdown: article.markdown,
    author: 'Heimdall',
    source: `heimdall:/read/${article.slug}`,
    modified: new Date(article.mtime),
  });
  // Archive a copy into ~/mimir/reading/ so the file is shareable and preserved.
  try {
    await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
    const exportPath = path.join(EXPORT_DIR, `${article.slug}.epub`);
    await fs.promises.writeFile(exportPath, epub);
  } catch (err) {
    request.log?.warn?.({ err }, 'failed to archive EPUB to mimir');
  }
  reply
    .header('Content-Type', 'application/epub+zip')
    .header('Content-Disposition', `attachment; filename="${article.slug}.epub"`)
    .header('Content-Length', String(epub.length))
    .send(epub);
});

// Card: projects list for /projects page
app.get('/api/card/projects-list', async () => {
  const [projects, layout] = await Promise.all([fetchProjects(), fetchLayout()]);
  const tree = buildProjectTree(projects, layout);
  return { html: projectsListCard(projects, tree) };
});

// Card: Hugin task history (kept — the v2 Services/hugin panel reuses taskHistoryCard,
// whose pagination buttons hx-get this route).
app.get('/api/card/task-history', async (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const tasks = readHuginTasks({ limit: 1000 });
  return { html: taskHistoryCard(tasks, page) };
});

// Card: memory consolidation health
app.get('/api/card/consolidation-health', async () => {
  const [health, projects] = await Promise.all([
    fetchConsolidationHealth(),
    fetchProjects(),
  ]);
  const synthesizedCount = projects.filter(p => p.synthesis).length;
  return { html: consolidationHealthCard(health, synthesizedCount) };
});

// Consolidation dashboard page — now a sub-view of the munin-memory service
// rather than a top-level tab.
app.get('/services/munin-memory/consolidation', async (request, reply) => {
  let detail = { health: null, telemetry: null, coverage: [], backlog: [] };
  try {
    detail = await fetchConsolidationDetail();
  } catch { /* degrade gracefully — show page with empty data */ }
  reply.header('Content-Type', 'text/html; charset=utf-8').send(consolidationPage(gitVersion, detail));
});

// Old top-level URL kept as a redirect so existing bookmarks/links still work.
app.get('/consolidation', async (request, reply) => {
  reply.redirect('/services/munin-memory/consolidation', 301);
});

// Card: consolidation worker status (live-refreshing HTMX fragment)
app.get('/api/card/consolidation-status', async () => {
  let detail = { health: null, telemetry: null, coverage: [], backlog: [] };
  try {
    detail = await fetchConsolidationDetail();
  } catch { /* degrade gracefully */ }
  return { html: consolidationStatusCard(detail) };
});

// API: consolidation activity chart data (30d synthesis events bucketed by day)
app.get('/api/consolidation/activity', async (request, reply) => {
  try {
    const data = await fetchConsolidationActivity();
    return data;
  } catch {
    return [];
  }
});

// ── Insights — Claude Code usage-insights panel + agent self-improvement endpoints ──────────

// Page: /insights
app.get('/insights', async (request, reply) => {
  try {
    const records = await fetchInsightsRecords({ apiKey: loadApiKey() });
    const trend = buildTrend(records);
    const objective = buildObjective(records);
    reply.header('Content-Type', 'text/html; charset=utf-8')
      .send(insightsPage(gitVersion, { records, trend, objective }));
  } catch {
    reply.header('Content-Type', 'text/html; charset=utf-8')
      .send(insightsPage(gitVersion, {}));
  }
});

// Agent API: current self-improvement objective
app.get('/api/insights/objective', async () => {
  try {
    const records = await fetchInsightsRecords({ apiKey: loadApiKey() });
    if (!records || records.length === 0) {
      return { data_points: 0, note: 'No insights data yet.' };
    }
    return buildObjective(records);
  } catch {
    return { data_points: 0, note: 'No insights data yet.' };
  }
});

// Agent API: weekly trend series
app.get('/api/insights/trend', async () => {
  try {
    const records = await fetchInsightsRecords({ apiKey: loadApiKey() });
    return buildTrend(records);
  } catch {
    return [];
  }
});

// ── M5 — "What We've Learned" page cards ───────────────────────────────────────────────────
// These prefer LIVE calls to the M5 gateway (capability map, generated findings) over local
// files; all degrade gracefully when the gateway is unreachable from Heimdall's host.

// Card: last updated timestamp
app.get('/api/card/last-updated', async () => {
  const lastControlNode = getLastCollectionTime(db, 'control-node');
  const lastNas = getLastCollectionTime(db, 'nas');
  const latest = lastControlNode && lastNas
    ? (lastControlNode > lastNas ? lastControlNode : lastNas)
    : lastControlNode || lastNas;
  return { html: `Collector cycle: ${formatAgeWithTimestamp(latest)}` };
});

// Metrics API for charts
const VALID_RANGES = ['24h', '7d', '30d'];
const METRIC_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

app.get('/api/metrics/:host/:metric', async (request, reply) => {
  const { host, metric } = request.params;
  const range = request.query.range || '24h';

  if (!isValidMetricHost(db, host)) {
    reply.code(400);
    return { error: 'Invalid host' };
  }
  if (!METRIC_PATTERN.test(metric)) {
    reply.code(400);
    return { error: 'Invalid metric name' };
  }
  if (!VALID_RANGES.includes(range)) {
    reply.code(400);
    return { error: 'Invalid range (use 24h, 7d, or 30d)' };
  }

  let fromTime;
  const now = new Date();
  switch (range) {
    case '7d': fromTime = new Date(now - 7 * 24 * 3600000).toISOString(); break;
    case '30d': fromTime = new Date(now - 30 * 24 * 3600000).toISOString(); break;
    default: fromTime = new Date(now - 24 * 3600000).toISOString();
  }

  const raw = getMetricHistoryWithRollup(db, host, metric, fromTime, now.toISOString(), fleetConfig.hostAliases);
  return prepareChartData(raw, 200);
});

// Sanitize event for public consumption — strip internal detail field
function sanitizeEvent(event) {
  return {
    timestamp: event.timestamp,
    host: event.host,
    category: event.category,
    severity: event.severity,
    title: event.title,
  };
}

// Events API
app.get('/api/events', async (request) => {
  const { category, severity, from, to, limit } = request.query;
  const events = searchEvents(db, {
    category,
    severity,
    from,
    to,
    limit: limit ? parseInt(limit) : 50,
  });
  return events.map(sanitizeEvent);
});

// Events search
app.get('/api/events/search', async (request) => {
  const { category, severity, from, to, limit } = request.query;
  const events = searchEvents(db, {
    category,
    severity,
    from,
    to,
    limit: limit ? parseInt(limit) : 50,
  });
  return events.map(sanitizeEvent);
});

// Alerts API
app.get('/api/alerts', async () => {
  return getActiveAlerts(db);
});

// v2 alert bus (§6.2): service-pushed alert ingest. Fail-closed Bearer auth
// (HEIMDALL_ALERT_TOKEN), Tailscale-bound — same posture as fleet push.
app.post('/api/alerts', async (request, reply) => {
  const insecureLoopback = process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK === '1'
    || process.env.HEIMDALL_ALERT_ALLOW_INSECURE_LOOPBACK === 'true';
  const result = handleAlertIngest(db, {
    authHeader: request.headers['authorization'] || '',
    token: process.env.HEIMDALL_ALERT_TOKEN || '',
    bindHost: process.env.HEIMDALL_BIND || '127.0.0.1',
    allowInsecureLoopback: insecureLoopback,
    body: request.body,
  });
  reply.code(result.status).send(result.body);
});

// #57 generic typed-panel ingest: a producer POSTs ONE JSON blob and a
// number/trend/table/status appears on its service page — zero Heimdall code per
// panel. Fail-closed Bearer auth, reusing the fleet token (no new credential).
// Explicit per-route bodyLimit (256 KiB) — generous for legit panels, far below
// the 1 MiB Fastify default. Bodies exceeding this return 413.
app.post('/api/panels', { bodyLimit: 256 * 1024 }, async (request, reply) => {
  const insecureLoopback = process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === '1'
    || process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === 'true';
  const result = handlePanelIngest(db, {
    authHeader: request.headers['authorization'] || '',
    token: process.env.HEIMDALL_FLEET_TOKEN || '',
    bindHost: process.env.HEIMDALL_BIND || '127.0.0.1',
    allowInsecureLoopback: insecureLoopback,
    body: request.body,
  });
  reply.code(result.status).send(result.body);
});

// Closed Brokkr #79 observation seam. It is distinct from generic panels so
// malformed/partial evidence cannot be normalized into an apparently healthy card.
app.post('/api/maintenance-execution-results', { bodyLimit: 64 * 1024 }, async (request, reply) => {
  const result = handleMaintenanceExecutionIngest(db, {
    authHeader: request.headers.authorization || '', token: process.env.HEIMDALL_MAINTENANCE_RESULT_TOKEN || '',
    bindHost: process.env.HEIMDALL_BIND || '127.0.0.1', body: request.body, now: now(),
  });
  reply.code(result.status).send(result.body);
});

// Discoverable schema doc for the typed-panel ingest (kinds + canonical example).
app.get('/api/panels/schema', async () => PANEL_SCHEMA_DOC);

// Read-back for producers (#102): what actually landed. Summary rows (no data
// payloads) are open like the other read APIs, but FULL data payloads share the
// fleet trust boundary with POST — the UI renders only sparklines/latest values,
// so raw point history is not otherwise public. ?service= + valid fleet Bearer →
// that service's full panels; without auth it degrades to that service's summary.
app.get('/api/panels', async (request, reply) => {
  const service = typeof request.query.service === 'string' ? request.query.service : '';
  const authHeader = request.headers['authorization'] || '';
  let full = false;
  if (service && authHeader) {
    const insecureLoopback = process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === '1'
      || process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === 'true';
    const auth = checkFleetAuth(authHeader, process.env.HEIMDALL_FLEET_TOKEN || '',
      process.env.HEIMDALL_BIND || '127.0.0.1', insecureLoopback);
    // A presented-but-wrong token fails loudly rather than silently degrading.
    if (!auth.ok) { reply.code(auth.code || 401).send({ error: 'invalid fleet token' }); return; }
    full = true;
  }
  if (service) {
    const rows = getPanelsForService(db, service);
    return full
      ? rows.map(({ service: s, panel, kind, label, unit, data, updated_at }) => ({ service: s, panel, kind, label, unit, data, updated_at }))
      : rows.map(({ service: s, panel, kind, label, unit, updated_at }) => ({ service: s, panel, kind, label, unit, updated_at }));
  }
  return listPanels(db);
});

// v2 alert surface: the dedicated Alerts tab (moved off the per-page sticky strip).
app.get('/alerts', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(alertsPage(gitVersion, getUnacknowledgedAlerts(db)));
});

// The self-refreshing alerts list fragment (returned as HTML, not the {html} envelope).
app.get('/api/alerts/list', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(alertsListFragment(getUnacknowledgedAlerts(db)));
});

// The nav count badge fragment — empty when nothing is pending.
app.get('/api/alerts/count', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(alertsCountBadge(getUnacknowledgedAlerts(db)));
});

// Dismiss a single alert by id — backs the list's × button. We ACKNOWLEDGE rather
// than resolve: engine-driven alerts (e.g. deploy drift) re-fire every collector
// cycle, so a resolve would bounce straight back ("the × doesn't close them").
// Acknowledge persists across re-fires, so a dismissed alert stays hidden until the
// condition genuinely clears and recurs. Empty body + hx-swap=outerHTML removes the
// row immediately.
app.delete('/api/alerts/:id', async (request, reply) => {
  if (!localhostOnly(request, reply)) return;
  // Require an all-digits id: Number.parseInt('12abc') would silently yield 12 and
  // acknowledge the wrong alert, so validate the raw param before converting.
  if (!/^[0-9]+$/.test(request.params.id)) {
    reply.code(400);
    return { error: 'invalid id' };
  }
  const id = Number(request.params.id);
  acknowledgeAlert(db, id);
  reply.header('Content-Type', 'text/html; charset=utf-8').send('');
});

// NAS state API — reads persisted state from DB
app.get('/api/nas-state', async () => {
  return getState(db);
});

// --- Fleet (v2 push-agent telemetry) ---
app.get('/fleet', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(fleetPage(gitVersion, db, Date.now(), fleetConfig.thresholds));
});

app.get('/api/fleet/grid', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(fleetGridFragment(db, Date.now(), fleetConfig.thresholds, {
      exceptionsOnly: request.query.mode === 'exceptions',
      baselineVersion: gitVersion,
    }));
});

app.post('/api/fleet/push', { bodyLimit: 64 * 1024 }, async (request, reply) => {
  const insecureLoopback = process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === '1'
    || process.env.HEIMDALL_FLEET_ALLOW_INSECURE_LOOPBACK === 'true';
  const result = handlePush(db, {
    authHeader: request.headers['authorization'] || '',
    sourceIp: request.ip,
    token: process.env.HEIMDALL_FLEET_TOKEN || '',
    bindHost: process.env.HEIMDALL_BIND || '127.0.0.1',
    allowInsecureLoopback: insecureLoopback,
    body: request.body,
    now: Date.now(),
    // Only a successfully loaded Grimnir registry can authorize lifecycle
    // transitions. An intentionally empty valid node projection is still
    // passed as [] and is therefore deliberately authoritative.
    configuredHostnames: fleetConfig.authority.status === 'loaded'
      ? fleetConfig.hosts.map((host) => host.hostname)
      : undefined,
    aliases: fleetConfig.hostAliases,
  });
  reply.code(result.status).send(result.body);
});

// --- Service contract + discovery (v2) ---
// Heimdall's own self-describing descriptor — dogfoods the contract.
app.get('/heimdall.json', async () => {
  return buildSelfDescriptor(gitVersion, { activeAlerts: getActiveAlerts(db).length });
});

// Snapshots for the /services index: discovered/synthetic snapshots PLUS a
// minimal card for every pushed-panels-only service (#102) — otherwise a
// producer's POST /api/panels data lands in a page nothing links to. Aliased
// producer ids are skipped (their panels render on the owning page).
function snapshotsWithPushedOnly() {
  const panelsFor = (service) => panelServiceIdsFor(service).flatMap((id) => getPanelsForService(db, id));
  const snapshots = getServiceSnapshots(db).map((snap) => withPushedStatus(snap, panelsFor(snap.service)));
  const have = new Set(snapshots.map((s) => s.service));
  for (const row of listPanelServices(db)) {
    if (have.has(row.service) || panelAliasOwnerOf(row.service)) continue;
    const synthetic = {
      service: row.service, kind: null, status: null,
      descriptor: { service: { name: row.service, label: row.service } },
      reachable: false, source: 'pushed',
      fetchedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
    snapshots.push(withPushedStatus(synthetic, panelsFor(row.service)));
  }
  return snapshots;
}

app.get('/services', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(servicesIndexPage(gitVersion, snapshotsWithPushedOnly()));
});

app.get('/api/services/grid', async (request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(servicesGridFragment(snapshotsWithPushedOnly(), {
      exceptionsOnly: request.query.mode === 'exceptions',
    }));
});

app.get('/services/:name', async (request, reply) => {
  const name = request.params.name;
  // An aliased producer id (#102, e.g. m5-inference) has its panels rendered on
  // the owning page — send the visitor there instead of a duplicate drawer page.
  const aliasOwner = panelAliasOwnerOf(name);
  if (aliasOwner && getServiceSnapshot(db, aliasOwner)) {
    reply.redirect(`/services/${encodeURIComponent(aliasOwner)}`, 302);
    return;
  }
  let snap = getServiceSnapshot(db, name);
  // A page shows its own pushed panels plus those of producer ids it owns (#102).
  const pushedPanels = panelServiceIdsFor(name).flatMap((id) => getPanelsForService(db, id));
  // A service may have pushed panels (POST /api/panels) without a discovered
  // descriptor snapshot — render a minimal page so the panels still show.
  if (!snap && pushedPanels.length) {
    snap = { service: name, kind: null, status: null, descriptor: { service: { name, label: name } }, reachable: false, source: 'pushed' };
  }
  if (!snap) {
    reply.code(404).header('Content-Type', 'text/html; charset=utf-8')
      .send('<!doctype html><meta charset=utf-8><p style="font-family:sans-serif;padding:2rem">Unknown service. <a href="/services">← Services</a></p>');
    return;
  }
  // munin-memory carries the Memory Health panel (#73) — fetch its typed result.
  // A failure degrades to the "unavailable" card (never 500s the page).
  let memHealth = null;
  let memAttention = null;
  if (name === 'munin-memory') {
    [memHealth, memAttention] = await Promise.all([
      fetchMemoryHealth().catch(() => ({ status: 'transport_error' })),
      fetchMemoryAttention().catch(() => ({ status: 'transport_error' })),
    ]);
  }
  reply.header('Content-Type', 'text/html; charset=utf-8')
    .send(servicePage(gitVersion, snap, pushedPanels, memHealth, memAttention,
      name === 'brokkr' ? require('./render/maintenance-execution-result').renderMaintenanceExecutionResult(getMaintenanceExecutionResult(db), now()) : null));
});

// v2 plugin panels: render a descriptor's plugin panel as a live HTMX fragment.
// Returns { html } (the onSend hook unwraps it to text/html for HTMX requests).
app.get('/api/plugins/:plugin/:service/:panel', async (request, reply) => {
  const { plugin: pluginName, service, panel: panelId } = request.params;
  const plugin = getPlugin(pluginName);
  if (!plugin || typeof plugin.renderPanel !== 'function') {
    reply.code(404);
    return { html: '' };
  }
  const snap = getServiceSnapshot(db, service);
  const panel = snap && snap.descriptor && Array.isArray(snap.descriptor.panels)
    ? snap.descriptor.panels.find((p) => p && p.id === panelId)
    : null;
  if (!panel) {
    reply.code(404);
    return { html: '' };
  }
  // Enforce descriptor intent: the panel must explicitly declare THIS plugin. A panel with no
  // `plugin` (or a different one) is not routable here — mirrors what service-page.js emits and
  // avoids triggering plugin work for unintended panels via a direct request.
  if (panel.plugin !== pluginName) {
    reply.code(404);
    return { html: '' };
  }
  try {
    const html = await plugin.renderPanel(panel, { db, descriptor: snap.descriptor });
    return { html };
  } catch (err) {
    request?.log?.warn?.({ err }, 'plugin panel render failed');
    return { html: '<div class="m5-note">Panel failed to render.</div>' };
  }
});

// HTMX middleware: if request has HX-Request header, return just the html field
app.addHook('onSend', async (request, reply, payload) => {
  if (request.headers['hx-request'] && payload) {
    try {
      const parsed = JSON.parse(payload);
      if (parsed.html !== undefined) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return parsed.html;
      }
    } catch { /* not JSON, pass through */ }
  }
  return payload;
});

return { app, db, serviceConfigs, getRuntimeVersion: () => gitVersion };
} // end buildApp

module.exports = { buildApp };

if (require.main === module) {
// Validate and start server

const HOST = process.env.HEIMDALL_BIND || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3033');

if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(HOST) || HOST.split('.').some(n => parseInt(n) > 255)) {
  console.error(`Invalid HEIMDALL_BIND address: ${HOST}`);
  process.exit(1);
}
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

// Do this before opening the listener. A dashboard that probes public
// documentation targets is worse than a failed startup: it looks operational.
const startupRegistry = loadServicesWithMeta();
assertSafeStartupTargets(startupRegistry.services);
loadDiskThresholds();

const { app, db, serviceConfigs, getRuntimeVersion } = buildApp();

app.listen({ host: HOST, port: PORT }, (err, address) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`Heimdall dashboard running at ${address}`);

  // Service discovery: poll the registry shortly after boot, then every 60s.
  // The registry is reloaded each tick so a grimnir services.json change is
  // reflected without a restart; `currentServices` holds the last-known-good.
  let currentServices = serviceConfigs;
  const runDiscovery = async () => {
    // Adopt an authoritative (grimnir) reload; on a fallback read keep the
    // last-known-good list and skip pruning below — a transient grimnir-read
    // failure must not delete grimnir-derived rows.
    let authoritative = false;
    try {
      const { services, source } = loadServicesWithMeta();
      if (source === 'grimnir' && services.length) {
        currentServices = services;
        authoritative = true;
      } else if (!currentServices.length && services.length) {
        currentServices = services; // boot-time fallback — have something to show
      }
    } catch { /* keep last-known-good */ }

    try {
      await pollAll(db, currentServices);
      // Synthetic snapshots for services not in the polled registry.
      const synthetic = [];
      try { synthetic.push(selfSnapshot(getRuntimeVersion())); } catch { /* ignore */ }
      try { synthetic.push(m5Snapshot(db)); } catch { /* ignore */ }
      try { synthetic.push(mcpSnapshot(db)); } catch { /* ignore */ }
      for (const s of synthetic) { try { upsertServiceSnapshot(db, s); } catch { /* ignore */ } }
      // Reconcile snapshots to the current set (#93) — but ONLY against the
      // authoritative grimnir registry. Never prune while on a fallback list
      // (would delete the grimnir-derived cards we just can't see this cycle).
      if (authoritative && currentServices.length > 0) {
        // Keep the synthetic services (self/m5/mcp) via a stable constant, NOT
        // from `synthetic` above — a transient m5/mcp rebuild failure must not
        // prune their still-valid rows.
        const keep = new Set(currentServices.map((s) => s.name));
        for (const n of SYNTHETIC_SERVICE_NAMES) keep.add(n);
        for (const s of synthetic) keep.add(s.service);
        try { pruneServiceSnapshots(db, [...keep]); } catch { /* best-effort reconcile */ }
      }
    } catch (e) { console.error('discovery error:', e.message); }
  };
  setTimeout(runDiscovery, 3000);
  const discoveryTimer = setInterval(runDiscovery, 60000);
  if (discoveryTimer.unref) discoveryTimer.unref();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  app.close().then(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  app.close().then(() => {
    db.close();
    process.exit(0);
  });
});
} // end if (require.main === module)
