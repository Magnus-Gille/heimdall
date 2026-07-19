'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Check Microsoft MCP token health from the synced health file.
 * The keepalive script on the laptop writes to ~/mimir/.health/microsoft-mcp.json
 * which syncs to the Pi via rsync.
 */
function collectMicrosoftMcpHealth() {
  const healthFile = path.join(os.homedir(), 'mimir', '.health', 'microsoft-mcp.json');

  try {
    const raw = fs.readFileSync(healthFile, 'utf8');
    const data = JSON.parse(raw);

    const checkedAt = new Date(data.checked_at);
    const ageHours = (Date.now() - checkedAt.getTime()) / (1000 * 60 * 60);
    const allHealthy = data.accounts.every(a => a.healthy);

    return {
      healthy: allHealthy && ageHours < 96, // stale after 4 days (runs every 3)
      age_hours: Math.round(ageHours * 10) / 10,
      accounts: data.accounts,
      checked_at: data.checked_at,
    };
  } catch (err) {
    return {
      healthy: false,
      age_hours: null,
      accounts: [],
      checked_at: null,
      error: err.code === 'ENOENT' ? 'Health file not found (keepalive never ran?)' : err.message,
    };
  }
}

module.exports = { collectMicrosoftMcpHealth };
