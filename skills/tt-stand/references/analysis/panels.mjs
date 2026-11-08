import path from 'node:path';
import {
  loadEntries,
  matrixSeries,
  logSeries,
  recordsOf,
  readJsonFile,
  reasonsOf,
  sourceIdOf,
  sourceIssues,
} from './response-data.mjs';
import { parseTime } from './time-values.mjs';
import { httpSummary, tableFromRecords } from './tables.mjs';

const DATASET_TITLE = { current: 'Текущий набор', baseline: 'Базовый набор' };

export async function buildModel(view, viewDir, current, baseline) {
  const panelErrors = [];
  const panels = [];
  const series = [];
  const tables = [];
  for (let index = 0; index < view.panels.length; index += 1) {
    const raw = view.panels[index];
    const configured =
      raw && typeof raw === 'object' ? { ...raw, id: raw.id || `panel-${index + 1}`, type: raw.kind } : raw;
    const built = await buildPanel(configured, index, viewDir, current, baseline);
    panels.push(built.panel);
    panelErrors.push(...built.errors);
    series.push(...built.series);
    tables.push(...built.tables);
  }
  return {
    panelErrors,
    panels,
    series,
    tables,
    incomplete: incompleteAll(current, baseline),
    sources: sourceCards(current, 'current').concat(baseline ? sourceCards(baseline, 'baseline') : []),
  };
}

export async function openBundles(manifestPath, baselineManifestPath) {
  const current = await loadEntries(manifestPath);
  const baseline = baselineManifestPath ? await loadEntries(baselineManifestPath) : null;
  return { current, baseline };
}

async function buildPanel(panel, index, viewDir, current, baseline) {
  if (!panel || typeof panel !== 'object' || Array.isArray(panel))
    return fail(`panel-${index}`, {}, 'Панель не является объектом.');
  const id = typeof panel.id === 'string' && panel.id ? panel.id : '';
  if (!id) return fail(`panel-${index}`, panel, 'У панели нет id.');
  if (panel.type === 'line') return buildLine(panel, current, baseline);
  if (panel.type === 'table') return buildTable(panel, index, current, baseline);
  if (panel.type === 'interval') return buildInterval(panel, viewDir);
  return fail(id, panel, `Неизвестный тип панели: ${panel.type || ''}`);
}

async function buildLine(panel, current, baseline) {
  const currentPart = await takeLine(panel, current, 'current');
  const baselinePart = baseline ? await takeLine(panel, baseline, 'baseline') : { errors: [], series: [] };
  const series = [...currentPart.series, ...baselinePart.series];
  const errors = named(panel.id, [...currentPart.errors, ...baselinePart.errors]);
  return {
    errors,
    series,
    tables: [],
    panel: linePanel(panel, series, errors),
  };
}

function linePanel(panel, series, errors) {
  return {
    id: panel.id,
    type: 'line',
    title: panel.title || panel.id,
    unit: typeof panel.unit === 'string' ? panel.unit : '',
    message: series.length ? '' : 'Пустые данные.',
    messages: errors.map((item) => item.text),
    series,
  };
}

async function takeLine(panel, bundle, dataset) {
  const found = locate(panel, bundle, dataset);
  if (found.error) return { series: [], errors: [found.error] };
  const errors = sourceIssues(found.entry);
  const data = found.entry.loaded.body ? found.entry.loaded.body.data : undefined;
  if (data === undefined || data === null) {
    if (!errors.length) errors.push('В ответе нет поля data.');
    return { series: [], errors };
  }
  const parsed =
    panel.format === 'prometheus-matrix'
      ? matrixSeries(data, dataset, found.id, panel.labelKeys)
      : panel.format === 'logs-records'
        ? logsLine(data, panel, dataset, found.id)
        : { error: `Формат линии не поддерживается: ${panel.format || ''}` };
  if (parsed.error) return { series: [], errors: [...errors, parsed.error] };
  return { series: parsed.series, errors: [...errors, ...(parsed.notes || [])] };
}

function logsLine(data, panel, dataset, sourceId) {
  const records = recordsOf(data);
  if (records.error) return records;
  return logSeries(records.records, panel, dataset, sourceId);
}

function locate(panel, bundle, dataset) {
  const src = sourceIdOf(panel);
  if (src.error) return src;
  const entry = bundle.byId.get(src.id);
  if (!entry) return { error: `Нет источника ${src.id} в наборе «${DATASET_TITLE[dataset]}».` };
  return { id: src.id, entry };
}

async function buildTable(panel, index, current, baseline) {
  const currentPart = takeTable(panel, current, 'current');
  const baselinePart = baseline ? takeTable(panel, baseline, 'baseline') : { errors: [], block: null, summary: null };
  const errors = named(panel.id, [...currentPart.errors, ...baselinePart.errors]);
  const blocks = [currentPart.block, baselinePart.block].filter(Boolean);
  return {
    errors,
    series: [],
    tables: summaryFiles(panel, index, currentPart.summary, baselinePart.summary),
    panel: {
      id: panel.id,
      type: 'table',
      title: panel.title || panel.id,
      message: blocks.length ? '' : 'Пустые данные.',
      messages: errors.map((item) => item.text),
      blocks,
    },
  };
}

function takeTable(panel, bundle, dataset) {
  const found = locate(panel, bundle, dataset);
  if (found.error) return { errors: [found.error], block: null, summary: null };
  const errors = sourceIssues(found.entry);
  const records = tableRecords(found.entry, panel);
  if (records.error) return { errors: [...errors, records.error], block: null, summary: null };
  const built = panel.transform
    ? transformed(records.records, panel)
    : tableFromRecords(records.records, panel.columns);
  if (built.error) return { errors: [...errors, built.error], block: null, summary: null };
  const block = {
    dataset,
    title: DATASET_TITLE[dataset],
    kind: panel.transform || 'rows',
    columns: built.columns,
    rows: built.rows,
  };
  const summary = panel.transform === 'http-summary' ? { columns: built.columns, rows: built.rows } : null;
  return { errors, block, summary };
}

function tableRecords(entry, panel) {
  if (panel.format !== 'logs-records') return { error: `Формат таблицы не поддерживается: ${panel.format || ''}` };
  if (!entry.loaded.body) return { error: 'Нет тела ответа для таблицы.' };
  const data = entry.loaded.body.data;
  if (data === undefined || data === null) {
    if (entry.loaded.body.ok === false) return { error: 'В ошибочном ответе нет данных таблицы.' };
    return { error: 'В ответе нет поля data.' };
  }
  return recordsOf(data);
}

function transformed(records, panel) {
  if (panel.transform !== 'http-summary') return { error: `Преобразование не поддерживается: ${panel.transform}` };
  return httpSummary(records, panel.mapping);
}

function summaryFiles(panel, index, current, baseline) {
  const files = [];
  const stem = `http-summary-${index}-${safeName(panel.id)}`;
  if (current) files.push({ name: `${stem}.csv`, columns: current.columns, rows: current.rows });
  if (baseline) files.push({ name: `${stem}-baseline.csv`, columns: baseline.columns, rows: baseline.rows });
  return files;
}

function safeName(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned || 'panel';
}

async function buildInterval(panel, viewDir) {
  const loaded = await intervalRows(panel, viewDir);
  if (loaded.error) return fail(panel.id, panel, loaded.error);
  const intervals = [];
  const errors = [];
  loaded.rows.forEach((row, index) => {
    const built = oneInterval(row, panel, index);
    if (built.error) errors.push({ id: panel.id, text: built.error });
    else intervals.push(built.interval);
  });
  return {
    errors,
    series: [],
    tables: [],
    panel: {
      id: panel.id,
      type: 'interval',
      title: panel.title || panel.id,
      message: intervals.length ? '' : 'Пустые данные.',
      messages: errors.map((item) => item.text),
      intervals,
    },
  };
}

async function intervalRows(panel, viewDir) {
  if (panel.format !== 'rows-file') return { error: `Формат интервалов не поддерживается: ${panel.format || ''}` };
  if (!panel.file || !panel.startField || !panel.endField || !panel.labelField || !panel.timeEncoding) {
    return { error: 'У интервалов не заданы файл, поля границ, подпись или кодировка времени.' };
  }
  const file = path.resolve(viewDir, panel.file);
  try {
    const rows = await readJsonFile(file, 'интервалов');
    if (!Array.isArray(rows)) return { error: 'Файл интервалов должен быть массивом.' };
    return { rows };
  } catch (error) {
    return { error: error.message };
  }
}

function oneInterval(row, panel, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: `Строка интервала ${index} не объект.` };
  const start = parseTime(row[panel.startField], panel.timeEncoding);
  if (!start.ok) return { error: `Строка интервала ${index}: ${start.error}` };
  const end = parseTime(row[panel.endField], panel.timeEncoding);
  if (!end.ok) return { error: `Строка интервала ${index}: ${end.error}` };
  if (end.ms < start.ms) return { error: `Строка интервала ${index}: конец раньше начала.` };
  if (!Object.hasOwn(row, panel.labelField)) return { error: `Строка интервала ${index}: нет подписи.` };
  const missing = (panel.fields ?? []).find((key) => !Object.hasOwn(row, key));
  if (missing) return { error: `Строка интервала ${index}: нет поля ${missing}.` };
  const label = row[panel.labelField];
  const fields = Object.fromEntries((panel.fields ?? []).map((key) => [key, row[key]]));
  return { interval: { index, label: label == null ? '' : String(label), start: start.ms, end: end.ms, fields } };
}

function fail(id, panel, text) {
  return {
    errors: [{ id, text }],
    series: [],
    tables: [],
    panel: {
      id,
      type: panel.type || 'error',
      title: panel.title || id,
      unit: '',
      message: text,
      messages: [text],
      series: [],
      blocks: [],
      intervals: [],
    },
  };
}

function named(id, texts) {
  return texts.map((text) => ({ id, text }));
}

function incompleteAll(current, baseline) {
  const rows = bundleIncomplete(current, 'current');
  if (baseline) rows.push(...bundleIncomplete(baseline, 'baseline'));
  return rows;
}

function bundleIncomplete(bundle, dataset) {
  const rows = [];
  for (const entry of bundle.list) rows.push(...entryIncomplete(entry, dataset));
  return rows;
}

function entryIncomplete(entry, dataset) {
  const rows = [];
  pushIncomplete(rows, dataset, entry.request.id, 'manifest', entry.request);
  if (entry.loaded.body) pushIncomplete(rows, dataset, entry.request.id, 'response', entry.loaded.body);
  return rows;
}

function pushIncomplete(rows, dataset, id, where, holder) {
  const reasons = reasonsOf(holder.incompleteReasons);
  if (holder.incomplete === true || reasons.length) {
    rows.push({ dataset, id, where, incomplete: holder.incomplete === true, reasons });
  }
}

function sourceCards(bundle, dataset) {
  return bundle.list.map((entry) => ({
    dataset,
    id: entry.request.id,
    manifestOk: entry.request.ok !== false,
    responseOk: Boolean(entry.loaded.body) && entry.loaded.body.ok !== false,
    errorClass: entry.request.errorClass || entry.loaded.body?.errorClass || '',
    error: sourceErrorText(entry),
    issues: sourceIssues(entry),
  }));
}

function sourceErrorText(entry) {
  if (typeof entry.loaded.body?.error === 'string') return entry.loaded.body.error;
  return '';
}
