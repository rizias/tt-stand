import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTime, readFinite, TIME_ENCODINGS } from './time-values.mjs';

export async function readJsonFile(file, kind) {
  const resolved = path.resolve(file);
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Не найден файл ${kind}: ${resolved}`);
    throw new Error(`Не удалось прочитать файл ${kind}: ${resolved}: ${error.message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    throw new Error(`Файл ${kind} содержит не JSON: ${resolved}`);
  }
}

function requestBroken(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return true;
  if (typeof request.id !== 'string' || request.id === '') return true;
  if (typeof request.responseFile !== 'string' || request.responseFile === '') return true;
  return false;
}

export async function loadManifest(manifestPath) {
  const file = path.resolve(manifestPath);
  const manifest = await readJsonFile(file, 'манифеста');
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.requests)) {
    throw new Error(`Манифест повреждён или не версии 1: ${file}`);
  }
  const requests = [];
  const seen = new Set();
  for (const request of manifest.requests) {
    if (requestBroken(request)) throw new Error(`В манифесте запись источника без id или responseFile: ${file}`);
    if (seen.has(request.id)) throw new Error(`В манифесте повторяется id источника: ${request.id}`);
    seen.add(request.id);
    requests.push(request);
  }
  return { path: file, dir: path.dirname(file), requests, grafana: manifest.grafana ?? null };
}

export async function readToolResponse(dir, request) {
  const file = path.isAbsolute(request.responseFile)
    ? path.resolve(request.responseFile)
    : path.resolve(dir, request.responseFile);
  try {
    const body = JSON.parse(await readFile(file, 'utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { file, broken: true };
    return { file, body };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, missing: true };
    return { file, broken: true };
  }
}

export async function loadEntries(manifestPath) {
  const bundle = await loadManifest(manifestPath);
  const list = [];
  const byId = new Map();
  for (const request of bundle.requests) {
    const entry = { request, loaded: await readToolResponse(bundle.dir, request) };
    list.push(entry);
    byId.set(request.id, entry);
  }
  return { path: bundle.path, list, byId, grafana: bundle.grafana };
}

export function reasonsOf(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  }
  if (typeof value === 'string' && value) return [value];
  return [];
}

export function sourceIssues(entry) {
  const issues = [];
  if (entry.request.ok === false) issues.push(manifestIssue(entry.request));
  if (entry.loaded.missing) issues.push('Файл ответа не найден.');
  else if (entry.loaded.broken) issues.push('Файл ответа повреждён.');
  else if (entry.loaded.body && entry.loaded.body.ok === false) issues.push(responseIssue(entry.loaded.body));
  return issues;
}

function manifestIssue(request) {
  const cls = request.errorClass ? ` Класс: ${request.errorClass}.` : '';
  return `Источник в манифесте помечен как ошибочный.${cls}`;
}

function responseIssue(body) {
  const text = typeof body.error === 'string' && body.error ? body.error : 'Ответ источника помечен как ошибочный.';
  const cls = body.errorClass ? ` Класс: ${body.errorClass}.` : '';
  return `${text}${cls}`;
}

export function sourceIdOf(panel) {
  const ref = panel.response;
  if (typeof ref !== 'string') return { error: 'У панели нет идентификатора response.' };
  const id = ref;
  if (!id) return { error: 'Пустой идентификатор источника.' };
  return { id };
}

export function recordsOf(data) {
  if (!Array.isArray(data)) return { error: 'Журнал должен быть массивом записей.' };
  const records = [];
  for (let i = 0; i < data.length; i += 1) {
    const row = data[i];
    if (!row || typeof row.record !== 'object' || row.record === null || Array.isArray(row.record)) {
      return { error: `В журнале нет объекта record у строки ${i}.` };
    }
    records.push(row.record);
  }
  return { records };
}

export function matrixSeries(data, dataset, sourceId, labelKeys) {
  const shape = matrixShape(data);
  if (shape.error) return shape;
  const series = [];
  const notes = [];
  for (let i = 0; i < data.result.length; i += 1) {
    const built = oneMatrixSeries(data.result[i], dataset, sourceId, i, labelKeys);
    if (built.error) return { error: built.error };
    notes.push(...built.notes);
    series.push(built.series);
  }
  return { series, notes };
}

function matrixShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Ответ матрицы не является объектом.' };
  if (histogramPayload(data)) return { error: 'Нативные гистограммы Prometheus не поддерживаются.' };
  if (data.resultType !== 'matrix' || !Array.isArray(data.result)) {
    return { error: 'Ожидалась матрица Prometheus с полем result.' };
  }
  return { ok: true };
}

function histogramPayload(data) {
  const kind = String(data.resultType || '');
  if (kind.includes('histogram')) return true;
  if (!Array.isArray(data.result)) return false;
  return data.result.some((item) => item && (Array.isArray(item.histograms) || item.histogram));
}

function oneMatrixSeries(item, dataset, sourceId, index, labelKeys) {
  if (!item || typeof item !== 'object' || !Array.isArray(item.values)) {
    return { error: `Серия ${index} матрицы не содержит values.` };
  }
  if (labelKeys !== undefined && !Array.isArray(labelKeys)) return { error: 'labelKeys должен быть массивом.' };
  const metric = plainObject(item.metric);
  const points = [];
  const notes = [];
  for (let k = 0; k < item.values.length; k += 1) {
    const sample = readSample(item.values[k]);
    if (sample.error) return { error: `Серия ${index}, точка ${k}: ${sample.error}` };
    if (sample.nonFinite)
      notes.push(`Серия ${dataset}/${sourceId}/${index}, точка ${k}: NaN или Inf заменены разрывом, не нулём.`);
    points.push({ t: sample.t, v: sample.v });
  }
  points.sort((a, b) => a.t - b.t);
  if (points.some((point, k) => k > 0 && point.t === points[k - 1].t))
    return { error: `Серия ${index}: повторяется время точки.` };
  return { notes, series: seriesItem(dataset, sourceId, index, metric, caption(metric, labelKeys), points) };
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function caption(metric, labelKeys) {
  const keys = labelKeys === undefined ? Object.keys(metric) : labelKeys;
  return keys
    .map((key) => `${key}=${typeof metric[key] === 'object' ? JSON.stringify(metric[key]) : (metric[key] ?? '')}`)
    .join(', ');
}

function readSample(pair) {
  if (pair && typeof pair === 'object' && !Array.isArray(pair)) {
    return { error: 'Нативные гистограммы Prometheus не поддерживаются.' };
  }
  if (!Array.isArray(pair) || pair.length < 2) return { error: 'Точка матрицы должна быть парой время-значение.' };
  if (pair[1] && typeof pair[1] === 'object') return { error: 'Нативные гистограммы Prometheus не поддерживаются.' };
  const time = parseTime(pair[0], 'unixSeconds');
  if (!time.ok) return { error: time.error };
  const parsed = readFinite(pair[1]);
  if (parsed.error) return parsed;
  return { t: time.ms, v: parsed.nonFinite ? null : parsed.n, nonFinite: parsed.nonFinite };
}

export function logSeries(records, panel, dataset, sourceId) {
  const spec = logSpec(panel);
  if (spec.error) return spec;
  const buckets = new Map();
  const notes = [];
  for (let i = 0; i < records.length; i += 1) {
    const step = logPoint(records[i], spec, i);
    if (step.error) return { error: step.error };
    if (step.nonFinite) notes.push(`Строка ${i}: NaN или Inf заменены разрывом, не нулём.`);
    const placed = placePoint(buckets, step);
    if (placed.error) return placed;
  }
  return { series: packBuckets(buckets, dataset, sourceId, spec.groupFields), notes };
}

function logSpec(panel) {
  if (!panel.timeField || !panel.valueField || !Array.isArray(panel.groupFields)) {
    return { error: 'Для линии по журналу не заданы время, значение или поля группы.' };
  }
  if (!TIME_ENCODINGS.has(panel.timeEncoding)) return { error: `Неизвестная кодировка времени: ${panel.timeEncoding}` };
  return {
    timeField: panel.timeField,
    timeEncoding: panel.timeEncoding,
    valueField: panel.valueField,
    groupFields: panel.groupFields,
  };
}

function logPoint(record, spec, index) {
  if (!Object.prototype.hasOwnProperty.call(record, spec.timeField))
    return { error: `В строке ${index} нет поля времени.` };
  if (!Object.prototype.hasOwnProperty.call(record, spec.valueField))
    return { error: `В строке ${index} нет поля значения.` };
  const time = parseTime(record[spec.timeField], spec.timeEncoding);
  if (!time.ok) return { error: `Строка ${index}: ${time.error}` };
  const parsed = readFinite(record[spec.valueField]);
  if (parsed.error) return { error: `Строка ${index}: ${parsed.error}` };
  const missing = spec.groupFields.find((field) => !Object.hasOwn(record, field));
  if (missing !== undefined) return { error: `В строке ${index} нет поля группы ${missing}.` };
  const labels = Object.fromEntries(spec.groupFields.map((field) => [field, record[field]]));
  return { t: time.ms, v: parsed.nonFinite ? null : parsed.n, nonFinite: parsed.nonFinite, labels };
}

function placePoint(buckets, step) {
  const key = JSON.stringify(step.labels);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { labels: step.labels, points: [], times: new Set() };
    buckets.set(key, bucket);
  }
  if (bucket.times.has(step.t)) return { error: 'Повторяются группа и время. Строки не складываются и не заменяются.' };
  bucket.times.add(step.t);
  bucket.points.push({ t: step.t, v: step.v });
  return { ok: true };
}

function packBuckets(buckets, dataset, sourceId, groupFields) {
  const series = [];
  let index = 0;
  for (const bucket of buckets.values()) {
    bucket.points.sort((a, b) => a.t - b.t);
    const label = groupFields.map((field) => `${field}=${bucket.labels[field] ?? ''}`).join(', ');
    series.push(seriesItem(dataset, sourceId, index, bucket.labels, label, bucket.points));
    index += 1;
  }
  return series;
}

function seriesItem(dataset, sourceId, index, labels, label, points) {
  return { id: `${dataset}/${sourceId}/${index}`, dataset, source: sourceId, labels, label, points };
}
