'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { muninRpc: muninRpcShared } = require('./munin-rpc');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedBriefing = null;
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
 * Fetch the latest briefing from Munin (briefings/latest).
 * Returns parsed briefing object or null if unavailable.
 */
async function fetchLatestBriefing() {
  if (cachedBriefing && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedBriefing;
  }

  const result = await muninRpc('memory_read', { namespace: 'briefings', key: 'latest' });
  if (!result) return cachedBriefing || null;

  const contentArr = result.content || [];
  if (!contentArr.length) return cachedBriefing || null;

  let parsed;
  try {
    parsed = JSON.parse(contentArr[0].text);
  } catch {
    return cachedBriefing || null;
  }

  const content = parsed.content || '';
  if (!content || content.startsWith('**TOMBSTONE**')) return cachedBriefing || null;

  // Parse metadata from markdown header written by skuld's munin-writer
  const dateMatch = content.match(/^# Daily Briefing — (\S+)/m);
  const generatedMatch = content.match(/\*Generated: ([^*\n]+)\*/);
  const sourcesMatch = content.match(/\*Sources: ([^*\n]+)\*/);
  const eventsMatch = content.match(/\*Events today: (\d+)\*/);

  // Extract narrative (everything after the ---)
  const sepIdx = content.indexOf('\n---\n');
  const narrative = sepIdx >= 0 ? content.slice(sepIdx + 5).trim() : content;

  const briefing = {
    date: dateMatch ? dateMatch[1] : null,
    generatedAt: generatedMatch ? generatedMatch[1].trim() : null,
    sources: sourcesMatch ? sourcesMatch[1].split(', ') : [],
    eventsToday: eventsMatch ? parseInt(eventsMatch[1], 10) : null,
    narrative,
    updatedAt: parsed.updated_at || null,
  };

  cachedBriefing = briefing;
  cacheTimestamp = Date.now();
  return briefing;
}

module.exports = { fetchLatestBriefing };
