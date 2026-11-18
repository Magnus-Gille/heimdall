'use strict';

/**
 * plane.js — read-only Plane CE (ticket system) data layer for the /tickets view.
 *
 * Heimdall runs on the Pi; Plane runs on M5. Like src/m5.js this pulls LIVE over the
 * tailnet and degrades gracefully. Config (all optional; unset PLANE_API_KEY = disabled):
 *   PLANE_BASE_URL         e.g. http://192.0.2.30:8082 (no trailing slash needed)
 *   PLANE_API_KEY          use a dedicated viewer-role bot user: Plane keys carry the
 *                          owning user's rights, so never reuse an admin key here
 *   PLANE_WORKSPACE_SLUG   default "gille"
 *   PLANE_PROJECTS         comma list of project identifiers (default: core set below)
 *
 * Only aggregates leave this module — no ticket titles/descriptions — so there is no
 * untrusted-string or private-content surface on the page.
 */

const DEFAULT_PROJECTS = [
  'GRIM', 'MUNIN', 'HUGIN', 'INFER', 'BROKKR', 'GOPS', 'CCONF', 'HEIM', 'MIMIR',
  'SKULD', 'RATA', 'MZERO', 'SKILLS', 'SKILLSP', 'NOX', 'CBATTLE', 'SWARM',
];
const GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
const REQUEST_TIMEOUT_MS = 8000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;          // 3000 issues/project ceiling; marks the project truncated
const CONCURRENCY = 3;         // Plane's default limit is ~60 req/min per key
const CACHE_TTL_MS = 5 * 60 * 1000;
const WEEKS = 12;
const DAY = 86400000;

// Endpoint noun is one constant: newer Plane versions rename /issues/ to /work-items/.
const ISSUES_PATH = 'issues';

function settings(env = process.env) {
  const list = (env.PLANE_PROJECTS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    baseUrl: (env.PLANE_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.PLANE_API_KEY || '',
    workspace: env.PLANE_WORKSPACE_SLUG || 'gille',
    projects: list.length ? list : DEFAULT_PROJECTS,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(cfg, urlPath, query, fetchImpl) {
  const qs = new URLSearchParams(query).toString();
  const url = `${cfg.baseUrl}/api/v1/workspaces/${encodeURIComponent(cfg.workspace)}/${urlPath}/${qs ? `?${qs}` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers: { 'X-API-Key': cfg.apiKey, Accept: 'application/json' }, signal: ctrl.signal });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(res.headers?.get?.('retry-after')) || 5, 10);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Plane HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Plane rate limited');
}

/** Follow Plane's cursor pagination; tolerate a bare array. Returns { items, truncated }. */
async function listAll(cfg, urlPath, fetchImpl, maxPages = MAX_PAGES) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await request(cfg, urlPath, { per_page: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, fetchImpl);
    if (Array.isArray(body)) return { items: items.concat(body), truncated: false };
    items.push(...(Array.isArray(body?.results) ? body.results : []));
    if (!body?.next_page_results || !body?.next_cursor) return { items, truncated: false };
    cursor = body.next_cursor;
  }
  return { items, truncated: true };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch raw per-project data. A failing project is recorded, not fatal. */
async function fetchRaw(cfg, fetchImpl) {
  const all = await listAll(cfg, 'projects', fetchImpl);
  const wanted = new Set(cfg.projects);
  const projects = all.items.filter((p) => p && wanted.has(String(p.identifier).toUpperCase()) && !p.archived_at);
  const errors = [];
  const raw = await mapLimit(projects, CONCURRENCY, async (p) => {
    const base = `projects/${encodeURIComponent(p.id)}`;
    try {
      const [states, issues, cycles, modules] = await Promise.all([
        listAll(cfg, `${base}/states`, fetchImpl),
        listAll(cfg, `${base}/${ISSUES_PATH}`, fetchImpl),
        listAll(cfg, `${base}/cycles`, fetchImpl),
        listAll(cfg, `${base}/modules`, fetchImpl),
      ]);
      return {
        identifier: String(p.identifier).toUpperCase(), name: String(p.name || p.identifier),
        states: states.items, issues: issues.items, cycles: cycles.items, modules: modules.items,
        truncated: issues.truncated,
      };
    } catch (err) {
      errors.push({ project: String(p.identifier).toUpperCase(), error: err.message });
      return null;
    }
  });
  return { raw: raw.filter(Boolean), errors };
}

const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Pure: raw per-project data -> aggregate snapshot used by the page and JSON API. */
function buildSnapshot(raw, now = Date.now()) {
  const thisWeek = weekStart(now);
  const weekly = Array.from({ length: WEEKS }, (_, i) => ({ weekStart: thisWeek - (WEEKS - 1 - i) * 7 * DAY, closed: 0 }));
  const totals = { total: 0, open: 0, closed7d: 0, closed30d: 0, inCycle: 0 };
  const projects = [];
  const cycles = [];
  const modules = [];

  for (const p of raw) {
    const groupOf = new Map((p.states || []).map((s) => [s.id, s.group]));
    const groups = { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0, other: 0 };
    for (const issue of p.issues || []) {
      if (issue.archived_at) continue;
      let g = groupOf.get(typeof issue.state === 'object' ? issue.state?.id : issue.state);
      if (!GROUPS.includes(g)) g = 'other';
      groups[g]++;
      totals.total++;
      if (g !== 'completed' && g !== 'cancelled') totals.open++;
      if (g === 'completed') {
        const done = ts(issue.completed_at);
        if (done !== null) {
          if (now - done <= 7 * DAY) totals.closed7d++;
          if (now - done <= 30 * DAY) totals.closed30d++;
          const bucket = weekly.find((w) => done >= w.weekStart && done < w.weekStart + 7 * DAY);
          if (bucket) bucket.closed++;
        }
      }
    }
    const count = Object.values(groups).reduce((a, b) => a + b, 0);
    const finished = groups.completed + groups.cancelled;
    projects.push({
      identifier: p.identifier, name: p.name, groups, total: count, open: count - finished,
      pct: count ? Math.round((groups.completed / count) * 100) : 0, truncated: !!p.truncated,
    });

    for (const c of p.cycles || []) {
      const start = ts(c.start_date), end = ts(c.end_date);
      if (start === null || end === null || now < start || now > end + DAY) continue; // current only
      const total = num(c.total_issues) ?? 0;
      const completed = num(c.completed_issues) ?? 0;
      const cancelled = num(c.cancelled_issues) ?? 0;
      totals.inCycle += Math.max(0, total - completed - cancelled);
      cycles.push({
        project: p.identifier, name: String(c.name || 'Cycle'), start, end, total, completed, cancelled,
        pct: total ? Math.round((completed / total) * 100) : 0,
        elapsedPct: Math.max(0, Math.min(100, Math.round(((now - start) / (end + DAY - start)) * 100))),
        daysLeft: Math.max(0, Math.ceil((end + DAY - now) / DAY)),
      });
    }

    for (const m of p.modules || []) {
      if (m.archived_at || ['completed', 'cancelled'].includes(String(m.status || '').toLowerCase())) continue;
      const total = num(m.total_issues), completed = num(m.completed_issues);
      modules.push({
        project: p.identifier, name: String(m.name || 'Module'), status: String(m.status || 'unknown'),
        start: ts(m.start_date), target: ts(m.target_date), total, completed,
        pct: total ? Math.round(((completed ?? 0) / total) * 100) : null,
      });
    }
  }

  projects.sort((a, b) => b.open - a.open || a.identifier.localeCompare(b.identifier));
  cycles.sort((a, b) => a.project.localeCompare(b.project));
  modules.sort((a, b) => (a.target ?? Infinity) - (b.target ?? Infinity));
  return { totals, projects, cycles, modules, weekly };
}

// ── cache: single-flight, stale-on-error, never fetch inside a warm page request ──
function createPlaneClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = CACHE_TTL_MS } = {}) {
  let cache = null;       // { snapshot, errors, fetchedAt }
  let lastError = null;
  let inflight = null;

  function refresh() {
    const cfg = settings(env);
    inflight ||= (async () => {
      try {
        const { raw, errors } = await fetchRaw(cfg, fetchImpl);
        cache = { snapshot: buildSnapshot(raw, now()), errors, fetchedAt: now() };
        lastError = null;
      } catch (err) {
        lastError = err.message;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** Returns { configured, snapshot|null, errors, fetchedAt, stale, error }. */
  async function get() {
    const cfg = settings(env);
    if (!cfg.baseUrl || !cfg.apiKey || typeof fetchImpl !== 'function') {
      return { configured: false, snapshot: null, errors: [], fetchedAt: null, stale: false, error: null };
    }
    if (!cache) await refresh();
    else if (now() - cache.fetchedAt > ttlMs) refresh(); // background; serve what we have
    return {
      configured: true,
      snapshot: cache?.snapshot || null,
      errors: cache?.errors || [],
      fetchedAt: cache?.fetchedAt || null,
      stale: !!cache && (lastError !== null || now() - cache.fetchedAt > ttlMs),
      error: lastError,
    };
  }

  return { get, refresh };
}

module.exports = { createPlaneClient, buildSnapshot, listAll, settings, weekStart, DEFAULT_PROJECTS, GROUPS };
