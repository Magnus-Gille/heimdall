'use strict';

const { openDatabase } = require('../src/db');
const { loadCodeHealthRuntimeConfig } = require('../src/code-health/runtime-config');
const { runCodeHealthCollection } = require('../src/code-health/runtime');

async function main() {
  const runtimeConfig = loadCodeHealthRuntimeConfig();
  if (runtimeConfig.status !== 'enabled') {
    console.log(`Code health collection: ${runtimeConfig.status}`);
    return;
  }
  const db = openDatabase();
  try {
    const result = await runCodeHealthCollection(db, runtimeConfig);
    console.log(`Code health collection: ${result.status}`);
    console.log(`Objective source: ${result.objective?.status ?? 'skipped'}`);
    console.log(`Subjective sources: ${result.subjective.map((item) => item.status).join(', ') || 'none configured'}`);
  } finally {
    db.close();
  }
}

main().catch(() => {
  console.error('Code health collection failed');
  process.exitCode = 1;
});
