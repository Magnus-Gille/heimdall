'use strict';

const LOCAL_SELF_HEAL_HOST = 'control-node';

function restartMetricName(serviceName) {
  return `service_restarts_24h_${serviceName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function buildRestartMetricRows({
  timestamp,
  services,
  getRestartCount,
  localHost = LOCAL_SELF_HEAL_HOST,
} = {}) {
  if (typeof timestamp !== 'string' || !Array.isArray(services) || typeof getRestartCount !== 'function') {
    return [];
  }

  const rows = [];
  for (const service of services) {
    if (!service || service.host !== localHost || typeof service.systemd_unit !== 'string' || service.systemd_unit === '') {
      continue;
    }
    rows.push({
      timestamp,
      host: localHost,
      metric: restartMetricName(service.name),
      value: getRestartCount(service.systemd_unit),
      unit: 'count',
      metadata: null,
    });
  }
  return rows;
}

module.exports = {
  LOCAL_SELF_HEAL_HOST,
  buildRestartMetricRows,
  restartMetricName,
};
