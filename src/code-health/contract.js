'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CONTRACT_ROOT } = require('./registry');

let loaded;

async function loadContract() {
  if (!loaded) {
    loaded = (async () => {
      const objectivePath = path.join(CONTRACT_ROOT, 'scripts/lib/code-health-objective.mjs');
      const policyPath = path.join(CONTRACT_ROOT, 'scripts/lib/code-health-policy.mjs');
      const agentPath = path.join(CONTRACT_ROOT, 'scripts/lib/code-health-agent.mjs');
      const [objective, policy, agent] = await Promise.all([
        import(pathToFileURL(objectivePath).href),
        import(pathToFileURL(policyPath).href),
        import(pathToFileURL(agentPath).href),
      ]);
      return Object.freeze({
        objectiveSchema: JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'docs/code-health-objective-v1.schema.json'), 'utf8')),
        agentSchema: JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'docs/code-health-agent-v1.schema.json'), 'utf8')),
        validateObjective: objective.validateObjective,
        validateObjectiveSeries: objective.validateObjectiveSeries,
        currentMetricStatus: policy.currentMetricStatus,
        seriesKey: policy.seriesKey,
        validateRecord: agent.validateRecord,
        validateRecords: agent.validateRecords,
        aggregateRecords: agent.aggregateRecords,
      });
    })();
  }
  return loaded;
}

module.exports = { loadContract };
