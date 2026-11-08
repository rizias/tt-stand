import { formatTime, readFinite } from './time-values.mjs';

const HTTP_SUMMARY_COLUMNS = ['requests', 'response_seconds', 'mean_s', 'max_s'];

export function tableFromRecords(records, columns) {
  if (!Array.isArray(columns) || columns.some((column) => typeof column !== 'string' || column === '')) {
    return { error: 'У таблицы не заданы имена столбцов.' };
  }
  for (const column of columns) {
    if (records.some((record) => !Object.hasOwn(record, column))) return { error: `В таблице нет поля ${column}.` };
  }
  const rows = records.map((record) => rowFromRecord(record, columns));
  return { columns, rows };
}

function rowFromRecord(record, columns) {
  return Object.fromEntries(columns.map((column) => [column, cellValue(record[column])]));
}

function cellValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return JSON.stringify(value);
}

export function httpSummary(records, mapping) {
  const spec = summarySpec(mapping);
  if (spec.error) return spec;
  const groups = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const step = summaryStep(records[i], spec, i);
    if (step.error) return { error: step.error };
    const error = addSummary(groups, step);
    if (error) return { error };
  }
  return {
    columns: [...spec.groupFields, ...HTTP_SUMMARY_COLUMNS],
    ...summaryRows(groups, spec.groupFields),
  };
}

function summarySpec(mapping) {
  if (
    !mapping ||
    !Array.isArray(mapping.groupFields) ||
    mapping.groupFields.some((field) => typeof field !== 'string' || field === '')
  ) {
    return { error: 'В http-summary не заданы поля группы.' };
  }
  const conflict = mapping.groupFields.find((field) => HTTP_SUMMARY_COLUMNS.includes(field));
  if (conflict) return { error: `В http-summary поле группы ${conflict} совпадает с вычисляемым столбцом.` };
  if (!mapping.countField || !mapping.durationSumField || !mapping.maxField) {
    return { error: 'В http-summary не заданы поля числа, суммы длительности или максимума.' };
  }
  return {
    groupFields: mapping.groupFields,
    countField: mapping.countField,
    durationSumField: mapping.durationSumField,
    maxField: mapping.maxField,
  };
}

function summaryStep(record, spec, index) {
  const count = requiredNumber(record, spec.countField, index);
  if (count.error) return count;
  const duration = requiredNumber(record, spec.durationSumField, index);
  if (duration.error) return duration;
  const max = requiredNumber(record, spec.maxField, index);
  if (max.error) return max;
  const missing = spec.groupFields.find((field) => !Object.hasOwn(record, field));
  if (missing) return { error: `В строке ${index} нет поля группы ${missing}.` };
  const keyParts = spec.groupFields.map((field) => record[field]);
  return { keyParts, count: count.n, duration: duration.n, max: max.n };
}

function requiredNumber(record, field, index) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return { error: `В строке ${index} нет поля ${field}.` };
  const parsed = readFinite(record[field]);
  if (parsed.error) return { error: `Строка ${index}, поле ${field}: ${parsed.error}` };
  if (parsed.nonFinite) return { error: `Строка ${index}, поле ${field}: NaN или Inf нельзя сложить.` };
  return { n: parsed.n };
}

function addSummary(groups, step) {
  const key = JSON.stringify(step.keyParts);
  let group = groups.get(key);
  if (!group) {
    group = { keyParts: step.keyParts, requests: 0, response_seconds: 0, max_s: null };
    groups.set(key, group);
  }
  group.requests += step.count;
  group.response_seconds += step.duration;
  group.max_s = group.max_s === null ? step.max : Math.max(group.max_s, step.max);
  if (!Number.isFinite(group.requests)) return 'В http-summary переполнение суммы числа запросов.';
  if (!Number.isFinite(group.response_seconds)) return 'В http-summary переполнение суммы длительностей.';
  return null;
}

function summaryRows(groups, groupFields) {
  const rows = [];
  for (const group of groups.values()) {
    const mean = group.requests > 0 ? group.response_seconds / group.requests : null;
    if (mean !== null && !Number.isFinite(mean)) return { error: 'В http-summary переполнение среднего.' };
    rows.push({
      ...Object.fromEntries(groupFields.map((field, index) => [field, group.keyParts[index]])),
      requests: group.requests,
      response_seconds: group.response_seconds,
      mean_s: mean,
      max_s: group.max_s,
    });
  }
  return { rows };
}

export function seriesCsv(series) {
  const columns = ['dataset', 'source', 'labels', 'points', 'max', 'maxTime', 'meanOfObservedPoints'];
  return toCsv(columns, series.map(describeSeries));
}

export function describeSeries(series) {
  let max = null;
  let maxTime = null;
  let sum = 0;
  let observed = 0;
  for (const point of series.points) {
    if (!Number.isFinite(point.v)) continue;
    observed += 1;
    sum += point.v;
    if (max === null || point.v > max) {
      max = point.v;
      maxTime = point.t;
    }
  }
  let mean = observed ? sum / observed : null;
  if (!Number.isFinite(sum)) mean = meanAfterOverflow(series.points, observed);
  return {
    dataset: series.dataset,
    source: series.source,
    labels: JSON.stringify(series.labels ?? {}),
    points: series.points.length,
    max,
    maxTime: Number.isFinite(maxTime) ? formatTime(maxTime) : '',
    meanOfObservedPoints: mean,
  };
}

function meanAfterOverflow(points, count) {
  const view = new DataView(new ArrayBuffer(8));
  let sum = 0n;
  for (const point of points) {
    if (!Number.isFinite(point.v)) continue;
    view.setFloat64(0, point.v);
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & 0xfffffffffffffn;
    const significand = exponent === 0 ? fraction : fraction | (1n << 52n);
    const magnitude = significand << BigInt(Math.max(0, exponent - 1));
    sum += point.v < 0 ? -magnitude : magnitude;
  }
  return roundedScaledMean(sum, BigInt(count));
}

function roundedScaledMean(sum, count) {
  const magnitude = sum < 0n ? -sum : sum;
  let exponent = magnitude.toString(2).length - count.toString(2).length;
  if (exponent > 0 && magnitude < count << BigInt(exponent)) exponent -= 1;
  const shift = Math.max(0, exponent - 52);
  const divisor = count << BigInt(shift);
  let significand = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder * 2n > divisor || (remainder * 2n === divisor && significand % 2n !== 0n)) significand += 1n;
  const mean = Number(significand) * 2 ** (shift - 1074);
  return sum < 0n ? -mean : mean;
}

export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
