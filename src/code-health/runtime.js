'use strict';

const { collectObjectiveReports } = require('./objective-collector');
const { reconcileSubjectiveEvidence } = require('./munin-export');
const { createGitHubTransport } = require('./github-transport');

async function runCodeHealthCollection(db, runtimeConfig, {
  githubTransport,
  muninRpc,
  clock = () => new Date(),
} = {}) {
  if (!db) throw new TypeError('database is required');
  if (!runtimeConfig || typeof runtimeConfig !== 'object') throw new TypeError('runtime config is required');

  if (runtimeConfig.status === 'rejected' && runtimeConfig.gateEnabled === true) {
    return { status: 'rejected', reason: 'invalid-source-configuration', objective: null, subjective: [] };
  }

  const enabled = runtimeConfig.enabled === true;
  let objective;
  try {
    const transport = enabled ? (githubTransport || createGitHubTransport()) : null;
    objective = await collectObjectiveReports({ db, config: { enabled }, transport, clock });
  } catch {
    objective = { status: 'unavailable', reason: 'source-collection-failed' };
  }

  const subjective = [];
  for (const source of Array.isArray(runtimeConfig.sources) ? runtimeConfig.sources : []) {
    const config = { ...source, enabled };
    try {
      subjective.push(await reconcileSubjectiveEvidence(db, config, { rpc: muninRpc, now: clock() }));
    } catch {
      subjective.push({ status: 'incomplete', reason: 'export-not-reconciled' });
    }
  }
  const collectionStatuses = [objective?.status, ...subjective.map((item) => item.status)];
  const partial = collectionStatuses.some((status) => !['committed', 'no-artifacts'].includes(status));
  return {
    status: enabled ? (partial ? 'partial' : 'completed') : runtimeConfig.status === 'rejected' ? 'rejected' : 'disabled',
    objective,
    subjective,
  };
}

module.exports = { runCodeHealthCollection };
