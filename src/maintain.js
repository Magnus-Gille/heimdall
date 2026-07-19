'use strict';

const { openDatabase, pruneFleetMetrics } = require('./db');

function run() {
  const db = openDatabase();
  const now = new Date().toISOString();
  console.log(`[${now}] Starting daily maintenance`);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Wrap rollup + delete in a transaction for atomicity (Issue 6)
  const rollupAndClean = db.transaction(() => {
    // 1. Aggregate raw metrics older than 7 days into hourly buckets
    console.log('  Aggregating hourly rollups for data older than 7 days...');
    db.prepare(`
      INSERT OR REPLACE INTO metrics_rollup (period, bucket, host, metric, min_value, max_value, avg_value, sample_count, unit, metadata)
      SELECT
        'hourly',
        strftime('%Y-%m-%dT%H:00:00Z', timestamp),
        host,
        metric,
        MIN(value),
        MAX(value),
        AVG(value),
        COUNT(*),
        MIN(unit),
        NULL
      FROM metrics
      WHERE timestamp < ?
        AND value IS NOT NULL
      GROUP BY strftime('%Y-%m-%dT%H:00:00Z', timestamp), host, metric
    `).run(sevenDaysAgo);
    console.log('  Hourly rollups aggregated');

    // 2. Aggregate hourly metrics older than 90 days into daily buckets
    console.log('  Aggregating daily rollups for hourly data older than 90 days...');
    db.prepare(`
      INSERT OR REPLACE INTO metrics_rollup (period, bucket, host, metric, min_value, max_value, avg_value, sample_count, unit, metadata)
      SELECT
        'daily',
        strftime('%Y-%m-%d', bucket),
        host,
        metric,
        MIN(min_value),
        MAX(max_value),
        SUM(avg_value * sample_count) / SUM(sample_count),
        SUM(sample_count),
        MIN(unit),
        NULL
      FROM metrics_rollup
      WHERE period = 'hourly'
        AND bucket < ?
      GROUP BY strftime('%Y-%m-%d', bucket), host, metric
    `).run(ninetyDaysAgo);

    // 3. Delete raw data older than 7 days
    console.log('  Deleting raw metrics older than 7 days...');
    const deleteRaw = db.prepare('DELETE FROM metrics WHERE timestamp < ?').run(sevenDaysAgo);
    console.log(`  Deleted ${deleteRaw.changes} raw metric rows`);

    // 4. Delete hourly rollups older than 90 days (now covered by daily)
    console.log('  Deleting hourly rollups older than 90 days...');
    const deleteHourly = db.prepare(
      "DELETE FROM metrics_rollup WHERE period = 'hourly' AND bucket < ?"
    ).run(ninetyDaysAgo);
    console.log(`  Deleted ${deleteHourly.changes} hourly rollup rows`);

    // 5. Delete events older than 1 year
    console.log('  Deleting events older than 1 year...');
    const deleteEvents = db.prepare('DELETE FROM events WHERE timestamp < ?').run(oneYearAgo);
    console.log(`  Deleted ${deleteEvents.changes} old event rows`);

    // 6. Delete old service_versions (keep 30 days)
    const deleteSV = db.prepare('DELETE FROM service_versions WHERE checked_at < ?').run(thirtyDaysAgo);
    console.log(`  Deleted ${deleteSV.changes} old service version rows`);

    // 7. Prune raw fleet_metrics older than 7 days (dense 30s push data; the
    //    scalar fan-out into `metrics` is already rolled up above for history).
    const deleteFleet = pruneFleetMetrics(db, sevenDaysAgo);
    console.log(`  Deleted ${deleteFleet} raw fleet_metrics rows`);
  });

  rollupAndClean();

  // VACUUM outside the transaction (cannot run inside one)
  console.log('  Running VACUUM...');
  db.exec('VACUUM');

  db.close();
  console.log(`[${new Date().toISOString()}] Maintenance complete`);
}

run();
