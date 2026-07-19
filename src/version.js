'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function shortCommit(value) {
  const commit = String(value || '').trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7).toLowerCase() : null;
}

/**
 * Resolve the code version actually running in this directory.
 * Grimnir's rsync deploy intentionally excludes .git and writes the deployed
 * source commit to .deployed-commit, so that stamp is authoritative in prod.
 */
function resolveRuntimeVersion(rootDir = path.join(__dirname, '..')) {
  try {
    const stamped = shortCommit(fs.readFileSync(path.join(rootDir, '.deployed-commit'), 'utf8'));
    if (stamped) return stamped;
  } catch { /* local checkout or pre-stamp deployment */ }

  try {
    return shortCommit(execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })) || 'dev';
  } catch {
    return 'dev';
  }
}

module.exports = { resolveRuntimeVersion, shortCommit };
