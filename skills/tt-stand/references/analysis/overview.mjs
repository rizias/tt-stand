import { describeSeries } from './tables.mjs';
import { samplePoints, timeRange, valueRange } from './sampling.mjs';

export function wireSeries(item, points = item.points) {
  return {
    id: item.id,
    dataset: item.dataset,
    source: item.source,
    label: item.label,
    labels: item.labels,
    points: points.map((point) => [point.t, point.v]),
  };
}

function labelKey(item) {
  return JSON.stringify(
    Object.keys(item.labels ?? {})
      .sort()
      .map((key) => [key, item.labels[key]]),
  );
}

function statistics(item, index, panelIndex) {
  const stats = describeSeries(item);
  const peak = item.points.find((point) => Number.isFinite(point.v) && point.v === stats.max);
  return {
    id: item.id,
    dataset: item.dataset,
    source: item.source,
    label: item.label,
    labels: item.labels,
    max: stats.max,
    maxTime: peak?.t ?? null,
    mean: stats.meanOfObservedPoints,
    count: stats.points,
    finiteCount: item.points.filter((point) => Number.isFinite(point.v)).length,
    key: labelKey(item),
    duplicate: false,
    detailKey: `series:${panelIndex}:${index}`,
    detailFile: `detail/series/${panelIndex}/${index}.js`,
  };
}

function rankRows(rows, field) {
  return [...rows].sort((a, b) => compareValue(a[field], b[field]));
}

function compareValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  const number = (value) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  const na = number(a),
    nb = number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
  return String(b).localeCompare(String(a));
}

function tagDuplicates(catalog) {
  const counts = new Map();
  for (const item of catalog) {
    const key = `${item.dataset}:${item.key}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of catalog) item.duplicate = counts.get(`${item.dataset}:${item.key}`) > 1;
}

function leaders(catalog) {
  const current = rankRows(
    catalog.filter((item) => item.dataset === 'current'),
    'max',
  ).slice(0, 10);
  const baseline = catalog.filter((item) => item.dataset === 'baseline');
  const selected = [...current];
  let unmatched = current.length === 0 && baseline.length > 0;
  for (const item of current) {
    const matches = baseline.filter((other) => other.key === item.key && !other.duplicate);
    if (!item.duplicate && matches.length === 1) selected.push(matches[0]);
    else if (baseline.length) unmatched = true;
  }
  if (unmatched) {
    for (const item of rankRows(baseline, 'max').slice(0, 10))
      if (!selected.some((other) => other.id === item.id)) selected.push(item);
  }
  return { selected, unmatched };
}

function compactLine(panel, config, index, range) {
  const catalog = panel.series.map((item, itemIndex) => statistics(item, itemIndex, index));
  tagDuplicates(catalog);
  const chosen = leaders(catalog);
  const selected = new Set(chosen.selected.map((item) => item.id));
  const series = panel.series
    .filter((item) => selected.has(item.id))
    .map((item) => wireSeries(item, samplePoints(item.points, range)));
  return {
    ...panel,
    series,
    catalog,
    unmatched: chosen.unmatched,
    yDomain: valueRange(panel.series, config),
    fullPoints: panel.series.reduce((sum, item) => sum + item.points.length, 0),
    sampled: panel.series.some((item) => item.points.length > 600),
  };
}

function compactTable(panel, config, index) {
  const blocks = panel.blocks.map((block, blockIndex) => {
    const rankField = block.kind === 'http-summary' ? 'response_seconds' : config.rankField;
    const rows = rankField ? rankRows(block.rows, rankField) : block.rows;
    return {
      ...block,
      rows: rows.slice(0, 20),
      totalRows: rows.length,
      rankField: rankField ?? null,
      detailKey: `table:${index}:${blockIndex}`,
      detailFile: `detail/tables/${index}-${blockIndex}.js`,
    };
  });
  return { ...panel, blocks };
}

export function buildOverview(model, view) {
  const range = timeRange(model);
  const panels = model.panels.map((panel, index) => {
    const config = view.panels[index] ?? {};
    if (panel.type === 'line') return compactLine(panel, config, index, range);
    if (panel.type === 'table') return compactTable(panel, config, index);
    return panel;
  });
  return {
    title: view.title ?? 'Отчёт',
    range,
    timezone: view.timezone ?? 'UTC',
    panels,
    sources: model.sources,
    errors: model.panelErrors,
    incomplete: model.incomplete,
    fullSeries: model.series.length,
    fullPoints: model.series.reduce((sum, item) => sum + item.points.length, 0),
  };
}
