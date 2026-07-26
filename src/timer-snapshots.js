'use strict';

/**
 * Refresh config-only timer snapshots after drift has persisted the timer_*
 * metrics for a collector cycle. Keeping this explicit prevents the dashboard's
 * independent discovery interval from showing the previous timer outcome.
 */
const { pollAll } = require('./discovery');

async function refreshTimerSnapshots(db, services, deps = {}) {
  const timers = (services || []).filter((service) => service && service.type === 'timer');
  if (timers.length === 0) return [];
  return pollAll(db, timers, deps);
}

module.exports = { refreshTimerSnapshots };
