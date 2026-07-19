'use strict';

/**
 * Server-side LTTB (Largest Triangle Three Buckets) downsampling.
 * Reduces time-series data to a target number of points while
 * preserving visual shape.
 */
function lttbDownsample(data, targetPoints) {
  if (!data || data.length <= targetPoints) return data;
  if (targetPoints < 3) return data;

  const result = [];
  const bucketSize = (data.length - 2) / (targetPoints - 2);

  // Always include first point
  result.push(data[0]);

  let prevIndex = 0;

  for (let i = 1; i < targetPoints - 1; i++) {
    const bucketStart = Math.floor((i - 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1, data.length - 1);
    const nextBucketStart = Math.floor(i * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, data.length - 1);

    // Calculate average of next bucket for the triangle
    let avgX = 0, avgY = 0, count = 0;
    for (let j = nextBucketStart; j <= nextBucketEnd; j++) {
      avgX += j;
      avgY += (data[j].value || 0);
      count++;
    }
    if (count > 0) { avgX /= count; avgY /= count; }

    // Find point in current bucket with largest triangle area
    let maxArea = -1;
    let maxIndex = bucketStart;
    const prevX = prevIndex;
    const prevY = data[prevIndex].value || 0;

    for (let j = bucketStart; j <= bucketEnd; j++) {
      const area = Math.abs(
        (prevX - avgX) * ((data[j].value || 0) - prevY) -
        (prevX - j) * (avgY - prevY)
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }

    result.push(data[maxIndex]);
    prevIndex = maxIndex;
  }

  // Always include last point
  result.push(data[data.length - 1]);
  return result;
}

function prepareChartData(rawData, targetPoints = 200) {
  const downsampled = lttbDownsample(rawData, targetPoints);
  return downsampled.map(d => ({
    x: d.timestamp,
    y: d.value,
  }));
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

module.exports = { lttbDownsample, prepareChartData, linearRegression };
