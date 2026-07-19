'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Ajv2020 = require('ajv/dist/2020');

const { muninRpc: muninRpcShared } = require('./munin-rpc');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedProjects = null;
let cacheTimestamp = 0;

function loadApiKey() {
  if (process.env.MUNIN_API_KEY) return process.env.MUNIN_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'munin-memory', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  return null;
}

const muninRpc = (method, args) => muninRpcShared(method, args, { apiKey: loadApiKey(), timeoutMs: 8000 });

/**
 * Parse structured sections from markdown content.
 * Looks for ## Vision, ## Roadmap, ## Next Steps, ## Current Work, ## Blockers
 * and optionally any extra headers passed in.
 */
function parseStructuredSections(content, extraHeaders = []) {
  if (!content) return null;
  const sectionHeaders = ['Vision', 'Roadmap', 'Next Steps', 'Current Work', 'Blockers', 'Milestones', ...extraHeaders];
  const sections = {};
  let found = false;

  for (const header of sectionHeaders) {
    // Match ## Header (case-insensitive) and capture until next ## or end
    const regex = new RegExp(`^##\\s+${header.replace(/\s+/g, '\\s+')}\\s*$`, 'im');
    const match = content.match(regex);
    if (match) {
      const startIdx = match.index + match[0].length;
      // Find next ## header or end of string
      const rest = content.slice(startIdx);
      const nextHeader = rest.match(/^##\s+/m);
      const sectionContent = nextHeader
        ? rest.slice(0, nextHeader.index).trim()
        : rest.trim();
      if (sectionContent) {
        sections[header] = sectionContent;
        found = true;
      }
    }
  }

  return found ? sections : null;
}

/**
 * Derive lifecycle status from tags.
 * Returns one of: active, maintenance, stopped, completed, archived
 */
function deriveLifecycle(tags) {
  if (!tags || !Array.isArray(tags)) return 'active';
  if (tags.includes('archived')) return 'archived';
  if (tags.includes('completed') || tags.includes('done')) return 'completed';
  if (tags.includes('stopped')) return 'stopped';
  if (tags.includes('maintenance')) return 'maintenance';
  return 'active';
}

/**
 * Title-case a slug: "munin-memory" → "Munin Memory"
 */
function titleFromSlug(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Parse ## Milestones section into structured objects.
 * Accepts lines like:
 *   - 2026-04-15 — Phase 7 launch
 *   - 2026-06 — v2 release
 *   - TBD — Public beta
 */
function parseMilestones(text) {
  if (!text) return null;
  const milestones = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^[-*]\s+(\d{4}-\d{2}(?:-\d{2})?|TBD)\s*[—–\-:]\s*(.+)/i);
    if (!m) continue;
    const rawDate = m[1].toUpperCase();
    const label = m[2].trim();
    let date = null;
    let isPast = false;
    if (rawDate !== 'TBD') {
      // Pad month-only to first of month
      const iso = rawDate.length === 7 ? rawDate + '-01' : rawDate;
      date = iso;
      isPast = new Date(iso) < new Date();
    }
    milestones.push({ date, label, isPast });
  }
  if (milestones.length === 0) return null;
  // Sort: upcoming first (by date asc), then TBD, then past
  milestones.sort((a, b) => {
    if (a.isPast !== b.isPast) return a.isPast ? 1 : -1;
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
  return milestones;
}

/**
 * Fetch the Heimdall layout config from meta/heimdall-layout.
 * Returns the parsed JSON or null on failure.
 */
let cachedLayout = null;
let layoutCacheTimestamp = 0;

async function fetchLayout() {
  if (cachedLayout && (Date.now() - layoutCacheTimestamp) < CACHE_TTL_MS) {
    return cachedLayout;
  }
  try {
    const result = await muninRpc('memory_read', { namespace: 'meta/heimdall-layout', key: 'config' });
    if (!result) return cachedLayout;
    const text = result.content?.[0]?.text;
    if (!text) return cachedLayout;
    const data = JSON.parse(text);
    if (data.found === false) return cachedLayout;
    const content = data.content || text;
    cachedLayout = JSON.parse(content);
    layoutCacheTimestamp = Date.now();
    return cachedLayout;
  } catch {
    return cachedLayout;
  }
}

/**
 * Build a hierarchical project tree from the flat project list and layout config.
 * Returns { groups: [...], uncategorized: [...], archived: [...] }
 */
function buildProjectTree(projects, layout) {
  if (!layout || !layout.groups) {
    // No layout config — return flat structure for backward compatibility
    return { groups: [], uncategorized: projects.filter(p => p.lifecycle !== 'archived'), archived: projects.filter(p => p.lifecycle === 'archived') };
  }

  const projectMap = new Map();
  for (const p of projects) projectMap.set(p.slug, p);

  const claimed = new Set(); // slugs claimed by a group
  const groups = [];

  for (const g of layout.groups) {
    if (g.kind === 'project-tree') {
      const root = projectMap.get(g.root_slug);
      const children = (g.children || [])
        .map(c => projectMap.get(c.slug))
        .filter(Boolean)
        .filter(p => p.lifecycle !== 'archived');
      // Sort children by updatedAt desc
      children.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

      if (g.root_slug) claimed.add(g.root_slug);
      for (const c of g.children || []) claimed.add(c.slug);

      groups.push({
        id: g.id,
        label: g.label,
        kind: 'project-tree',
        root: root || { slug: g.root_slug, name: titleFromSlug(g.root_slug), lifecycle: 'active' },
        children,
        roadmapUrl: g.roadmap_url || null,
      });
    } else if (g.kind === 'category') {
      const members = (g.members || [])
        .map(slug => projectMap.get(slug))
        .filter(Boolean)
        .filter(p => p.lifecycle !== 'archived');
      members.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

      for (const slug of g.members || []) claimed.add(slug);

      groups.push({
        id: g.id,
        label: g.label,
        kind: 'category',
        tagline: g.tagline || '',
        members,
      });
    }
  }

  // Uncategorized: not claimed by any group and not archived
  const uncategorized = projects
    .filter(p => !claimed.has(p.slug) && p.lifecycle !== 'archived')
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const archived = projects
    .filter(p => p.lifecycle === 'archived')
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  return { groups, uncategorized, archived, uncategorizedLabel: layout.uncategorized_label || 'Other Projects' };
}

/**
 * Fetch cross-reference metadata and synthesis timestamps from memory_orient.
 * Returns a map of namespace → { crossReferences, synthesisUpdatedAt }.
 */
async function fetchConsolidationMeta() {
  try {
    const result = await muninRpc('memory_orient', { detail: 'compact' });
    if (!result) return {};
    const data = JSON.parse(result.content?.[0]?.text || '{}');
    const dashboard = data.dashboard || {};
    const meta = {};
    for (const entries of Object.values(dashboard)) {
      for (const entry of entries) {
        if (entry.synthesis) {
          meta[entry.namespace] = {
            crossReferences: entry.synthesis.cross_references || [],
            synthesisUpdatedAt: entry.synthesis.updated_at,
          };
        }
      }
    }
    return meta;
  } catch { return {}; }
}

/**
 * Fetch consolidation worker health via memory_status.
 * Returns { available: bool } or null on failure.
 */
async function fetchConsolidationHealth() {
  try {
    const status = await muninRpc('memory_status', {});
    if (!status) return null;
    const data = JSON.parse(status.content?.[0]?.text || '{}');
    return {
      available: data.features?.consolidation ?? false,
    };
  } catch { return null; }
}

/**
 * Fetch all projects from Munin, filtering to projects/* namespace only.
 * Returns array of project objects grouped-ready.
 */
async function fetchProjects() {
  // Check cache
  if (cachedProjects && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedProjects;
  }

  // Query for project status entries — use filter-only (no search text) to avoid
  // hybrid search degradation when embeddings are unavailable (heimdall#9)
  const result = await muninRpc('memory_query', { namespace: 'projects/', entry_type: 'state', limit: 100 });
  if (!result) return cachedProjects || [];

  const contentArr = result.content || [];
  if (!contentArr.length) return cachedProjects || [];

  let parsed;
  try {
    parsed = JSON.parse(contentArr[0].text);
  } catch {
    return cachedProjects || [];
  }

  const entries = parsed.results || [];

  // Filter: only projects/* namespace, only state entries with key=status, skip tombstones
  const projectMap = new Map();

  for (const entry of entries) {
    const ns = entry.namespace || '';
    // Only projects/* — exclude clients/*, tasks/*, rituals/*, etc.
    if (!ns.startsWith('projects/')) continue;
    // Only status state entries
    if (entry.entry_type !== 'state' || entry.key !== 'status') continue;
    // Skip tombstones
    const content = entry.content_preview || '';
    if (content.startsWith('**TOMBSTONE**')) continue;

    const slug = ns.replace('projects/', '');
    const lifecycle = deriveLifecycle(entry.tags || []);
    const sections = parseStructuredSections(content);
    const needsAttention = (entry.tags || []).includes('needs_attention');

    projectMap.set(slug, {
      slug,
      name: titleFromSlug(slug),
      namespace: ns,
      lifecycle,
      tags: entry.tags || [],
      summary: content,
      sections,
      needsAttention,
      updatedAt: entry.updated_at || entry.created_at,
    });
  }

  // Also fetch full content for status entries to get structured sections
  // (content_preview may be truncated, so fetch full for active projects)
  const activeProjects = [...projectMap.values()].filter(p => p.lifecycle === 'active');
  for (const proj of activeProjects) {
    try {
      const full = await muninRpc('memory_read', { namespace: proj.namespace, key: 'status' });
      if (full) {
        const fullContent = full.content?.[0]?.text;
        if (fullContent) {
          const data = JSON.parse(fullContent);
          if (data.content && !data.content.startsWith('**TOMBSTONE**')) {
            proj.summary = data.content;
            proj.sections = parseStructuredSections(data.content);
            if (data.updated_at) proj.updatedAt = data.updated_at;
          }
        }
      }
    } catch { /* use preview as fallback */ }
  }

  // Fetch cross-reference metadata from orient (one call for all namespaces)
  const consolidationMeta = await fetchConsolidationMeta();

  // Fetch synthesis entries for all projects that have a status entry
  for (const proj of [...projectMap.values()]) {
    // Merge cross-reference data from orient response
    if (consolidationMeta[proj.namespace]) {
      const meta = consolidationMeta[proj.namespace];
      proj.crossReferences = meta.crossReferences;
    }
    // Fetch synthesis entry (optional — skip gracefully on error)
    try {
      const synthResult = await muninRpc('memory_read', { namespace: proj.namespace, key: 'synthesis' });
      if (synthResult) {
        const synthContent = synthResult.content?.[0]?.text;
        if (synthContent) {
          const data = JSON.parse(synthContent);
          if (data.found && data.content) {
            proj.synthesis = {
              content: data.content,
              updatedAt: data.updated_at,
              sections: parseStructuredSections(data.content, ['Key Decisions', 'Summary', 'Patterns', 'Recent Activity']),
            };
          }
        }
      }
    } catch { /* synthesis is optional */ }
  }

  // Enrich with milestones
  for (const proj of [...projectMap.values()]) {
    if (proj.sections && proj.sections['Milestones']) {
      const parsed = parseMilestones(proj.sections['Milestones']);
      if (parsed) {
        proj.milestones = parsed;
        proj.nextMilestone = parsed.find(m => !m.isPast) || null;
        proj.achievedMilestones = parsed.filter(m => m.isPast);
      }
    }
  }

  const projects = [...projectMap.values()];
  cachedProjects = projects;
  cacheTimestamp = Date.now();
  return projects;
}

/**
 * Fetch consolidation worker detail: health, coverage, backlog.
 * Returns { health, telemetry, coverage, backlog } — all fields may be empty on error.
 */
function consolidationBacklogFromHealth(result) {
  if (!result || result.status !== 'ok') return [];
  const rows = result.payload?.consolidation?.backlog;
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    namespace: typeof row.namespace === 'string' ? row.namespace : '',
    count: Number.isFinite(Number(row.unincorporated)) ? Number(row.unincorporated) : null,
  }));
}

async function fetchConsolidationDetail() {
  const [statusResult, synthesisResult, healthResult] = await Promise.all([
    muninRpc('memory_status', {}),
    muninRpc('memory_query', { tags: ['source:synthesis'], entry_type: 'state', limit: 50 }),
    fetchMemoryHealth(),
  ]);

  // Parse health + telemetry from memory_status
  let health = null;
  let telemetry = null;
  if (statusResult) {
    try {
      const data = JSON.parse(statusResult.content?.[0]?.text || '{}');
      health = data.consolidation_health || null;
      telemetry = data.telemetry || null;
    } catch { /* ok */ }
  }

  // Parse coverage from synthesis state entries
  let coverage = [];
  if (synthesisResult) {
    try {
      const data = JSON.parse(synthesisResult.content?.[0]?.text || '{}');
      const results = data.results || [];
      coverage = results.map(r => ({
        namespace: r.namespace || '',
        lastConsolidated: r.updated_at || r.created_at || null,
        logsIncorporated: null, // not exposed in query results
      }));
    } catch { /* ok */ }
  }

  // Parse the complete, structured backlog from the canonical memory_health
  // contract. The old memory_orient(detail=standard) path was capped and forced
  // Heimdall to scrape counts from prose, hiding most actionable namespaces.
  const backlog = consolidationBacklogFromHealth(healthResult);

  // Map pending backlog counts onto coverage rows by namespace (clean 1:1 map).
  const backlogByNs = new Map(backlog.map(b => [b.namespace, b.count]));
  coverage = coverage.map(c => ({ ...c, backlog: backlogByNs.get(c.namespace) ?? 0 }));

  return { health, telemetry, coverage, backlog };
}

/**
 * Fetch synthesis activity for the past 30 days, bucketed by calendar day.
 * Primary: parses memory_history for synthesis key writes (key === 'synthesis', action !== 'delete').
 * Fallback: buckets synthesis state entries by their updated_at date if history yields nothing.
 * Returns [{ x: 'YYYY-MM-DD', y: count }, ...] sorted ascending.
 */
async function fetchConsolidationActivity() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const historyResult = await muninRpc('memory_history', { since, limit: 500 });
    if (historyResult) {
      const data = JSON.parse(historyResult.content?.[0]?.text || '{}');
      // memory_history may use 'entries' or 'results' as the array key
      const entries = data.entries || data.results || [];

      // Filter to synthesis writes: key === 'synthesis', action is not a delete
      const synthEntries = entries.filter(e =>
        e.key === 'synthesis' && e.action !== 'delete'
      );

      if (synthEntries.length > 0) {
        const buckets = {};
        for (const entry of synthEntries) {
          const day = (entry.created_at || entry.timestamp || '').slice(0, 10);
          if (!day) continue;
          buckets[day] = (buckets[day] || 0) + 1;
        }
        const points = Object.entries(buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, count]) => ({ x: day, y: count }));
        if (points.length > 0) return points;
      }
    }
  } catch { /* fall through to fallback */ }

  // Fallback: use synthesis query results, bucket by updated_at date.
  // Not true activity-over-time but gives a useful namespace-by-date view.
  try {
    const synthesisResult = await muninRpc('memory_query', { tags: ['source:synthesis'], entry_type: 'state', limit: 50 });
    if (synthesisResult) {
      const data = JSON.parse(synthesisResult.content?.[0]?.text || '{}');
      const results = data.results || [];
      const buckets = {};
      for (const r of results) {
        const day = (r.updated_at || '').slice(0, 10);
        if (!day) continue;
        buckets[day] = (buckets[day] || 0) + 1;
      }
      return Object.entries(buckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ x: day, y: count }));
    }
  } catch { /* ok */ }

  return [];
}

// ─── Memory Health typed fetch (§2) ──────────────────────────────────────────

const SUPPORTED_SCHEMA_VERSION = 2;

// Load and compile the JSON Schema once at module init.
const _memHealthSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'docs', 'memory-health.schema.json'), 'utf8')
);
const _ajv2020 = new Ajv2020({ allErrors: true, strict: false });
// Register no-op date-time format to silence "unknown format ignored" warnings.
// Producer correctness is assumed for date string content.
_ajv2020.addFormat('date-time', () => true);
const _validateMemoryHealth = _ajv2020.compile(_memHealthSchema);

// Last-good cache (module-level — one entry, no TTL — evicted on next successful fetch).
let _lastGoodCache = null;

/** Reset the cache — intended for tests only. */
function _resetMemoryHealthCache() {
  _lastGoodCache = null;
}

/**
 * Unwrap a v2 wire payload into the canonical consumer shape.
 * Spreads `wire.sections` to top-level, carrying schema_version / generated_at / partial.
 * The render layer and last-good cache always receive this unwrapped shape.
 *
 * @param {object} wire  A schema-valid v2 wire payload.
 * @returns {object}     Canonical consumer shape with sections at top level.
 */
function unwrapMemoryHealth(wire) {
  // Spread sections FIRST, then top-level metadata, so a future additive section
  // named schema_version/generated_at/partial can't shadow the envelope metadata.
  return {
    ...wire.sections,
    schema_version: wire.schema_version,
    generated_at: wire.generated_at,
    partial: wire.partial,
  };
}

/**
 * Pure function: classify a raw RPC text response into a typed result object.
 * No network, no cache reads or writes — fully testable without mocking.
 *
 * @param {string|null} rawText  The `.content[0].text` from a muninRpc result, or null if
 *                               the RPC itself returned null (transport error).
 * @returns {{ status: string, payload?: object, generatedAt?: string, reason?: string }}
 */
function classifyMemoryHealth(rawText, opts = {}) {
  if (rawText === null || rawText === undefined) {
    return { status: 'transport_error' };
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { status: 'invalid_schema', reason: 'parse' };
  }

  // Guard non-object JSON (literal `null`, numbers, strings, arrays). JSON `null`
  // parses cleanly, so without this the version gate below would dereference null
  // and throw — and fetchMemoryHealth calls us outside its try, so it would escape
  // the "never throws" contract.
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'invalid_schema', reason: 'not-an-object' };
  }

  // Gate on version BEFORE schema validation: a well-formed payload announcing a
  // version we don't support must read as `unsupported_version` ("upgrade heimdall"),
  // not `invalid_schema` ("corrupt payload"). The schema's `schema_version: {const: 2}`
  // would otherwise reject other integers as invalid first (§1.3).
  // Only an INTEGER version other than the supported one short-circuits here; a missing,
  // non-numeric, or non-integer (e.g. 1.5) version falls through to ajv → `invalid_schema`.
  if (Number.isInteger(payload.schema_version)
      && payload.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return { status: 'unsupported_version' };
  }

  const valid = _validateMemoryHealth(payload);
  if (!valid) {
    const errors = (_validateMemoryHealth.errors || [])
      .slice(0, 3)
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    return { status: 'invalid_schema', reason: errors || 'schema' };
  }

  // Freshness gate (spec §3.2): a schema-valid payload whose producer-side
  // `generated_at` is older than the configured window is `stale_payload`, not `ok`
  // — a frozen producer must not render as healthy. The window (`opts.maxAgeMs`) is
  // supplied by the sampling slice once the poll cadence is wired; when omitted, no
  // freshness check runs (preserving current behavior). The payload still rides along
  // so the panel can show dimmed last-known values.
  const unwrapped = unwrapMemoryHealth(payload);
  if (typeof opts.maxAgeMs === 'number') {
    const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    const genMs = Date.parse(payload.generated_at);
    if (Number.isNaN(genMs) || nowMs - genMs > opts.maxAgeMs) {
      return { status: 'stale_payload', payload: unwrapped, generatedAt: payload.generated_at,
               reason: Number.isNaN(genMs) ? 'unparsable-generated_at' : 'expired' };
    }
  }

  return { status: 'ok', payload: unwrapped, generatedAt: payload.generated_at };
}

/**
 * Fetch the memory_health payload from Munin and return a typed result.
 * Never throws; on any error returns the last-good cached payload (if any) with servedFromCache:true.
 *
 * @param {Function} [_rpcFn]  Optional injection seam for tests. When provided, called as
 *                             `_rpcFn()` instead of the real muninRpc transport.
 *                             Must return the same shape as muninRpc (result or null).
 * @returns {Promise<{ status: string, payload?: object, reason?: string, generatedAt?: string, servedFromCache?: boolean }>}
 */
async function fetchMemoryHealth(_rpcFn, opts = {}) {
  // Historical chart sampling is intentionally not implied here: the UI shows no
  // trend until Heimdall has a real sampler. opts.maxAgeMs remains available for
  // a future centralized poller to enforce producer freshness.
  let result;
  try {
    result = typeof _rpcFn === 'function'
      ? await _rpcFn()
      : await muninRpcShared('memory_health', {}, { apiKey: loadApiKey(), timeoutMs: 5000 });
  } catch {
    result = null;
  }

  const rawText = result != null ? (result.content?.[0]?.text ?? null) : null;
  const classified = classifyMemoryHealth(rawText, opts);

  if (classified.status !== 'ok') {
    if (_lastGoodCache) {
      return { ...classified, payload: _lastGoodCache.payload, servedFromCache: true };
    }
    return classified;
  }

  // Cache the good payload.
  _lastGoodCache = { payload: classified.payload };
  return classified;
}

const MEMORY_ATTENTION_ARGS = Object.freeze({
  include_blocked: false,
  include_stale: true,
  include_upcoming_events: false,
  include_temporal_stale: true,
  include_expiring: false,
  include_missing_status: true,
  include_conflicting_lifecycle: false,
  include_missing_lifecycle: false,
  limit: 50,
});

/** Validate the small memory_attention contract used by the operator page. */
function classifyMemoryAttention(rawText) {
  if (rawText == null) return { status: 'transport_error' };
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return { status: 'invalid_schema', reason: 'parse' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.ok !== true || parsed.action !== 'attention' || !Array.isArray(parsed.items)) {
    return { status: 'invalid_schema', reason: 'shape' };
  }
  const validItems = parsed.items.every((item) => item && typeof item === 'object'
    && typeof item.namespace === 'string' && typeof item.category === 'string'
    && typeof item.updated_at === 'string' && typeof item.preview === 'string'
    && typeof item.suggested_action === 'string');
  if (!validItems) return { status: 'invalid_schema', reason: 'item_shape' };
  return { status: 'ok', payload: parsed, generatedAt: parsed.generated_at };
}

/** Fetch the exact, resolvable status-maintenance queue. Never throws. */
async function fetchMemoryAttention(_rpcFn) {
  let result;
  try {
    result = typeof _rpcFn === 'function'
      ? await _rpcFn()
      : await muninRpcShared('memory_attention', MEMORY_ATTENTION_ARGS, { apiKey: loadApiKey(), timeoutMs: 5000 });
  } catch {
    result = null;
  }
  const rawText = result != null ? (result.content?.[0]?.text ?? null) : null;
  return classifyMemoryAttention(rawText);
}

module.exports = { loadApiKey, fetchProjects, fetchLayout, buildProjectTree, parseMilestones, parseStructuredSections, titleFromSlug, deriveLifecycle, fetchConsolidationHealth, fetchConsolidationDetail, consolidationBacklogFromHealth, fetchConsolidationActivity, classifyMemoryHealth, fetchMemoryHealth, classifyMemoryAttention, fetchMemoryAttention, unwrapMemoryHealth, SUPPORTED_SCHEMA_VERSION, _resetMemoryHealthCache };
