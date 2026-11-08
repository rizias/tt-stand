import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readJsonFile } from './response-data.mjs';
import { buildModel, openBundles } from './panels.mjs';
import { seriesCsv, toCsv } from './tables.mjs';
import { buildOverview } from './overview.mjs';
import { embedJson, writeDetails } from './detail-files.mjs';
import { attachAnalysis } from './analysis-index.mjs';
import { grafanaOrigin } from './grafana-links.mjs';

export async function renderReport({ manifestPath, viewPath, outputDirectory, baselineManifestPath = null } = {}) {
  const manifest = requiredPath(manifestPath, 'манифеста');
  const viewFile = requiredPath(viewPath, 'представления');
  const output = requiredPath(outputDirectory, 'каталога вывода');
  const view = await readJsonFile(viewFile, 'представления');
  assertView(view, viewFile);
  const bundles = await openBundles(manifest, baselineManifestPath || null);
  const outDir = await prepareOutput(output);
  const model = await buildModel(view, path.dirname(path.resolve(viewFile)), bundles.current, bundles.baseline);
  const reportFile = path.join(outDir, 'report.html');
  const details = await writeDetails(outDir, model);
  const tableFiles = [];
  const seriesFile = path.join(outDir, 'series.csv');
  await writeNew(seriesFile, seriesCsv(model.series));
  tableFiles.push(seriesFile);
  for (const table of model.tables) {
    const file = path.join(outDir, table.name);
    await writeNew(file, toCsv(table.columns, table.rows));
    tableFiles.push(file);
  }
  const overview = buildOverview(model, view);
  overview.tableFiles = tableFiles.map((file) => path.basename(file));
  overview.baseline = Boolean(bundles.baseline);
  const analysisFile = path.join(outDir, 'analysis.json');
  const analysis = attachAnalysis(overview, view, bundles, outDir);
  await writeNew(analysisFile, JSON.stringify(analysis, null, 2) + '\n');
  overview.analysisFile = 'analysis.json';
  const html = await renderHtml(overview, sourceLinks(bundles, outDir));
  await writeNew(reportFile, html);
  return {
    reportFile,
    analysisFile,
    tableFiles,
    ...details,
    overviewBytes: Buffer.byteLength(html),
    panelErrors: model.panelErrors,
    incompleteReasons: model.incomplete,
  };
}

function requiredPath(value, kind) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Не задан путь ${kind}.`);
  return value;
}

function assertView(view, file) {
  const resolved = path.resolve(file);
  if (!view || view.version !== 1 || !Array.isArray(view.panels)) {
    throw new Error(`Представление повреждено или не версии 1: ${resolved}`);
  }
  if (typeof view.timezone !== 'string' || !/^[A-Za-z_][A-Za-z0-9_+./-]*$/u.test(view.timezone))
    throw new Error('View.timezone требует явного часового пояса IANA.');
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: view.timezone }).format(0);
  } catch {
    throw new Error(`Неизвестный часовой пояс: ${view.timezone}`);
  }
  if (view.title !== undefined && (typeof view.title !== 'string' || !view.title.length))
    throw new Error('title требует непустой строки.');
  assertGrafana(view.grafana);
  for (const panel of view.panels) assertPresentation(panel);
}

function assertGrafana(grafana) {
  if (grafana === undefined) return;
  if (!grafanaOrigin(grafana?.baseUrl))
    throw new Error('grafana.baseUrl требует http(s) без учётных данных, query и fragment.');
  if (grafana.orgId !== undefined && (!Number.isSafeInteger(grafana.orgId) || grafana.orgId <= 0))
    throw new Error('grafana.orgId требует положительного целого числа.');
}

function assertPresentation(panel) {
  if (!panel || typeof panel !== 'object') throw new Error('Панель должна быть объектом.');
  if (panel.kind === 'line' && (typeof panel.unit !== 'string' || !panel.unit.trim()))
    throw new Error('Линейная панель требует unit, для безразмерного показателя используйте none.');
  if (
    panel.fields !== undefined &&
    (!Array.isArray(panel.fields) || panel.fields.some((key) => typeof key !== 'string' || !key.length))
  ) {
    throw new Error('fields должен быть массивом непустых строк.');
  }
  if (panel.yMin === undefined && panel.yMax === undefined) return;
  if (!Number.isFinite(panel.yMin) || !Number.isFinite(panel.yMax) || panel.yMin >= panel.yMax) {
    throw new Error('yMin и yMax требуют двух конечных возрастающих чисел.');
  }
}

async function prepareOutput(dir) {
  const resolved = path.resolve(dir);
  try {
    const entries = await readdir(resolved);
    if (entries.length) throw new Error(`Каталог вывода не пуст, файлы не затираются: ${resolved}`);
    return resolved;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (String(error.message || '').startsWith('Каталог вывода не пуст')) throw error;
      throw new Error(`Каталог вывода недоступен: ${resolved}: ${error.message}`);
    }
  }
  try {
    await mkdir(resolved, { recursive: true });
  } catch (error) {
    throw new Error(`Не удалось создать каталог вывода: ${resolved}: ${error.message}`);
  }
  return resolved;
}

function sourceLinks(bundles, directory) {
  const entries = [...bundles.current.list, ...(bundles.baseline?.list ?? [])];
  return entries.map((entry) => ({
    name: entry.request.id,
    file: path.relative(directory, entry.loaded.file).split(path.sep).join('/'),
  }));
}

function htmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fileHref(file) {
  if (path.isAbsolute(file)) return pathToFileURL(file).href;
  return file.split('/').map(encodeURIComponent).join('/');
}

async function renderHtml(payload, sources) {
  const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-template.html');
  let template;
  try {
    template = await readFile(templatePath, 'utf8');
  } catch (error) {
    throw new Error(`Не найден шаблон отчёта: ${templatePath}: ${error.message}`);
  }
  const token = '__REPORT_DATA__';
  if (!template.includes(token)) throw new Error('В шаблоне отчёта нет места для данных.');
  const names = [
    'metric-format.mjs',
    'grafana-links.mjs',
    'ui-shared.mjs',
    'line-controller.mjs',
    'chart-controls.mjs',
    'line-view.mjs',
    'page.mjs',
    'chart.mjs',
    'timeline.mjs',
    'detail-ui.mjs',
  ];
  const scripts = await Promise.all(names.map((name) => readFile(path.join(path.dirname(templatePath), name), 'utf8')));
  const links = [...payload.tableFiles.map((file) => ({ name: file, file })), ...sources];
  const linkHtml = links
    .map((item) => `<li><a href="${htmlText(fileHref(item.file))}">${htmlText(item.name)}</a></li>`)
    .join('');
  const base = template
    .replace('__REPORT_SCRIPT__', () => `${scripts.join('\n')}\nif (payload) mount();`)
    .replace('__REPORT_LINKS__', () => linkHtml);
  const embedded = embedJson(payload);
  const plain = base.replace(token, () => embedded);
  if (Buffer.byteLength(plain) <= 1048576) return plain;
  const envelope = { encoding: 'gzip', data: gzipSync(embedded, { level: 9 }).toString('base64') };
  return base.replace(token, () => embedJson(envelope));
}

async function writeNew(file, content) {
  try {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Файл уже существует и не затирается: ${file}`);
    throw new Error(`Не удалось записать файл: ${file}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) throw new Error(`Неизвестный аргумент: ${key}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`У аргумента ${key} нет значения.`);
    if (key === '--manifest') out.manifestPath = value;
    else if (key === '--view') out.viewPath = value;
    else if (key === '--out') out.outputDirectory = value;
    else if (key === '--baseline') out.baselineManifestPath = value;
    else throw new Error(`Неизвестный аргумент: ${key}`);
    i += 1;
  }
  if (!out.manifestPath || !out.viewPath || !out.outputDirectory) {
    throw new Error('Нужны аргументы --manifest, --view и --out.');
  }
  return out;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  try {
    const result = await renderReport(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.panelErrors.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

if (invokedDirectly()) await main();
