import { dirname, resolve } from 'node:path';
import type { ParsedValues } from '../cli/args.ts';
import { ToolError } from '../errors.ts';
import { normalizePath, normalizePathFrom } from '../paths.ts';
import { readQueryFile } from '../queryFile.ts';
import type { PreparedBatch } from './plan.ts';
import { publicGrafanaUrl } from './grafanaOrigin.ts';

export interface ReportOptions {
  viewPath: string;
  baselineManifestPath: string | null;
}
export interface ReportResult {
  reportFile: string;
  analysisFile?: string;
  tableFiles: string[];
  panelErrors: Array<{ id: string; text: string }>;
  incompleteReasons: unknown[];
}
interface Renderer {
  renderReport(options: {
    manifestPath: string;
    viewPath: string;
    outputDirectory: string;
    baselineManifestPath: string | null;
  }): Promise<ReportResult>;
}

function document(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readQueryFile(file));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('требуется объект');
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new ToolError('bad_request', `Файл ${file}: ${(cause as Error).message}`);
  }
}

function panelDocument(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('bad_request', 'Панель view должна быть объектом.');
  }
  return raw as Record<string, unknown>;
}

function checkPanel(raw: unknown, batch: PreparedBatch, base: string): void {
  const panel = panelDocument(raw);
  if (!['line', 'table', 'interval'].includes(String(panel.kind))) {
    throw new ToolError('bad_request', `Неизвестный kind панели: ${String(panel.kind)}.`);
  }
  if (panel.kind === 'line') {
    stringField(panel, 'unit');
    if (!(panel.unit as string).trim()) throw new ToolError('bad_request', 'Линейная панель требует непустой unit.');
  }
  checkProjection(panel);
  checkPresentation(panel);
  if (panel.kind === 'interval') {
    if (panel.format !== 'rows-file' || typeof panel.file !== 'string') {
      throw new ToolError('bad_request', 'Интервалы требуют format rows-file и file.');
    }
    let rows: unknown;
    try {
      rows = JSON.parse(readQueryFile(normalizePathFrom(base, panel.file)));
    } catch (cause) {
      throw new ToolError('bad_request', `Файл интервалов: ${(cause as Error).message}`);
    }
    if (!Array.isArray(rows)) throw new ToolError('bad_request', 'Файл интервалов должен содержать массив.');
    return;
  }
  if (typeof panel.response !== 'string' || !batch.requests.some((item) => item.id === panel.response)) {
    throw new ToolError('bad_request', `Источник панели не входит в пакет: ${String(panel.response)}.`);
  }
  if (panel.format !== 'prometheus-matrix' && panel.format !== 'logs-records') {
    throw new ToolError('bad_request', `Неизвестный format панели: ${String(panel.format)}.`);
  }
}

function stringField(panel: Record<string, unknown>, key: string): void {
  if (typeof panel[key] !== 'string' || String(panel[key]).length === 0) {
    throw new ToolError('bad_request', `Панель требует строковое поле ${key}.`);
  }
}

function stringList(panel: Record<string, unknown>, key: string, requiredList = true): void {
  if (panel[key] === undefined && !requiredList) return;
  const value = panel[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new ToolError('bad_request', `Поле панели ${key} должно быть массивом строк.`);
  }
}

function timeFields(panel: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) stringField(panel, field);
  if (!['rfc3339', 'unixSeconds', 'unixMilliseconds'].includes(String(panel.timeEncoding))) {
    throw new ToolError('bad_request', 'Панель требует допустимое timeEncoding.');
  }
}

function checkProjection(panel: Record<string, unknown>): void {
  if (panel.kind === 'interval') {
    timeFields(panel, ['startField', 'endField', 'labelField']);
    return;
  }
  if (panel.kind === 'line' && panel.format === 'prometheus-matrix') {
    stringList(panel, 'labelKeys', false);
    return;
  }
  if (panel.kind === 'line') {
    timeFields(panel, ['timeField', 'valueField']);
    stringList(panel, 'groupFields');
    return;
  }
  if (panel.format !== 'logs-records') throw new ToolError('bad_request', 'Таблица требует logs-records.');
  if (panel.transform === undefined) {
    stringList(panel, 'columns');
    return;
  }
  if (panel.transform !== 'http-summary') throw new ToolError('bad_request', 'Неизвестный transform панели.');
  const mapping = panelDocument(panel.mapping);
  stringList(mapping, 'groupFields');
  const conflict = (mapping.groupFields as string[]).find((field) =>
    ['requests', 'response_seconds', 'mean_s', 'max_s'].includes(field),
  );
  if (conflict) {
    throw new ToolError('bad_request', `В http-summary поле группы ${conflict} совпадает с вычисляемым столбцом.`);
  }
  for (const field of ['countField', 'durationSumField', 'maxField']) stringField(mapping, field);
}

function checkPresentation(panel: Record<string, unknown>): void {
  if (panel.title !== undefined) stringField(panel, 'title');
  if (panel.description !== undefined) stringField(panel, 'description');
  if (panel.fields !== undefined) stringList(panel, 'fields');
  checkRankAndScale(panel);
}

function checkRankAndScale(panel: Record<string, unknown>): void {
  if (panel.rankField !== undefined) {
    stringField(panel, 'rankField');
    if (panel.transform === undefined && !Array.isArray(panel.columns)) {
      throw new ToolError('bad_request', 'rankField требует columns таблицы.');
    }
    if (Array.isArray(panel.columns) && !panel.columns.includes(panel.rankField)) {
      throw new ToolError('bad_request', 'rankField должен входить в columns таблицы.');
    }
  }
  if (panel.yMin === undefined && panel.yMax === undefined) return;
  if (
    typeof panel.yMin !== 'number' ||
    typeof panel.yMax !== 'number' ||
    !Number.isFinite(panel.yMin) ||
    !Number.isFinite(panel.yMax) ||
    panel.yMin >= panel.yMax
  ) {
    throw new ToolError('bad_request', 'yMin и yMax требуют двух конечных возрастающих чисел.');
  }
}

export function prepareReport(values: ParsedValues, batch: PreparedBatch): ReportOptions | null {
  if (values.view === undefined) {
    if (values.baseline !== undefined) throw new ToolError('bad_request', '--baseline требует --view.');
    return null;
  }
  const viewPath = resolve(normalizePath(values.view));
  const view = document(viewPath);
  if (view.version !== 1 || !Array.isArray(view.panels)) {
    throw new ToolError('bad_request', 'View должен содержать version: 1 и panels.');
  }
  if (view.title !== undefined) stringField(view, 'title');
  checkGrafana(view.grafana);
  if (typeof view.timezone !== 'string' || !/^[A-Za-z_][A-Za-z0-9_+./-]*$/u.test(view.timezone)) {
    throw new ToolError('bad_request', 'View.timezone требует явного часового пояса IANA.');
  }
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: view.timezone }).format(0);
  } catch {
    throw new ToolError('bad_request', `Неизвестный часовой пояс: ${String(view.timezone)}.`);
  }
  for (const panel of view.panels) checkPanel(panel, batch, dirname(viewPath));
  const baselineManifestPath = values.baseline === undefined ? null : resolve(normalizePath(values.baseline));
  if (baselineManifestPath !== null) {
    const baseline = document(baselineManifestPath);
    if (baseline.version !== 1 || !Array.isArray(baseline.requests)) {
      throw new ToolError('bad_request', 'Baseline должен быть manifest версии 1.');
    }
  }
  return { viewPath, baselineManifestPath };
}

function checkGrafana(raw: unknown): void {
  if (raw === undefined) return;
  const grafana = panelDocument(raw);
  if (typeof grafana.baseUrl !== 'string' || !publicGrafanaUrl(grafana.baseUrl))
    throw new ToolError('bad_request', 'grafana.baseUrl требует http(s) без учётных данных, query и fragment.');
  if (
    grafana.orgId !== undefined &&
    (typeof grafana.orgId !== 'number' || !Number.isSafeInteger(grafana.orgId) || grafana.orgId <= 0)
  )
    throw new ToolError('bad_request', 'grafana.orgId требует положительного целого числа.');
}

export async function renderBatchReport(
  options: ReportOptions,
  manifestPath: string,
  outputDirectory: string,
): Promise<ReportResult> {
  try {
    const renderer = (await import(
      new URL('../../skills/tt-stand/references/analysis/render.mjs', import.meta.url).href
    )) as Renderer;
    return await renderer.renderReport({ ...options, manifestPath, outputDirectory });
  } catch (cause) {
    throw new ToolError('report_render_failed', `Представление не построено: ${(cause as Error).message}`);
  }
}
