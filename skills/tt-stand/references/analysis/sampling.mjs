export function samplePoints(points, range, limit = 600) {
  if (!range) return points;
  if (points.length <= limit) return separateEmptyBuckets(points, range, limit);
  const count = Math.floor(limit / 2) - 1;
  const width = (range.max - range.min) / count;
  const buckets = Array.from({ length: count }, () => ({ min: null, max: null, gaps: [] }));
  for (const point of points) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((point.t - range.min) / width)));
    const bucket = buckets[index];
    if (!Number.isFinite(point.v)) {
      bucket.gaps.push(point);
      continue;
    }
    if (bucket.min === null || point.v < bucket.min.v) bucket.min = point;
    if (bucket.max === null || point.v > bucket.max.v) bucket.max = point;
  }
  const selected = [points[0], points.at(-1)];
  buckets.forEach((bucket, index) => {
    if (bucket.min) selected.push(bucket.min, bucket.max);
    else selected.push({ t: range.min + (index + 0.5) * width, v: null });
    selected.push(...bucket.gaps);
  });
  const byTime = new Map(selected.filter(Boolean).map((point) => [point.t, point]));
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function separateEmptyBuckets(points, range, limit) {
  const width = (range.max - range.min) / (Math.floor(limit / 2) - 1);
  const result = [];
  let previous = null;
  for (const point of points) {
    const bucket = Math.floor((point.t - range.min) / width);
    if (previous !== null && bucket - previous > 1) result.push({ t: range.min + (previous + 1.5) * width, v: null });
    result.push(point);
    previous = bucket;
  }
  return result;
}

export function timeRange(model) {
  let min = Infinity,
    max = -Infinity;
  const include = (value) => {
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  };
  for (const series of model.series) for (const point of series.points) include(point.t);
  for (const panel of model.panels)
    for (const interval of panel.intervals ?? []) {
      include(interval.start);
      include(interval.end);
    }
  if (!Number.isFinite(min)) return null;
  return min === max ? { min: min - 1000, max: max + 1000 } : { min, max };
}

export function valueRange(series, config) {
  if (config.yMin !== undefined && config.yMax !== undefined) return { min: config.yMin, max: config.yMax };
  let min = Infinity,
    max = -Infinity;
  for (const item of series)
    for (const point of item.points) {
      if (Number.isFinite(point.v)) {
        min = Math.min(min, point.v);
        max = Math.max(max, point.v);
      }
    }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  min = min >= 0 ? 0 : min;
  return { min, max: max === min ? max + 1 : max };
}
