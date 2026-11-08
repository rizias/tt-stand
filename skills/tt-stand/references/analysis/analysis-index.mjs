import path from 'node:path';
import { grafanaOrigin, grafanaQuery, grafanaLink } from './grafana-links.mjs';

function sourceInfo(bundle, id, dataset, view, outDir) {
  const entry = bundle?.byId.get(id);
  if (!entry) return { id, dataset, available: false, error: 'Источник отсутствует' };
  const response = entry.loaded.body;
  const echo = response?.echo ?? {};
  const settings = view.grafana ?? bundle.grafana ?? {};
  return {
    id,
    dataset,
    available: Boolean(response),
    ok: response?.ok === true,
    baseUrl: grafanaOrigin(settings.baseUrl),
    orgId: settings.orgId ?? null,
    queryModel: grafanaQuery(echo),
    ...echoInfo(echo),
    ...responseState(response),
    purpose: entry.request.why ?? null,
    responseFile: path.relative(outDir, entry.loaded.file).split(path.sep).join('/'),
  };
}

function echoInfo(echo) {
  return {
    query: echo.query ?? null,
    datasourceUid: echo.datasourceUid ?? null,
    datasourceType: echo.datasourceType ?? null,
    requestedPeriod: { from: echo.start ?? null, to: echo.end ?? null, step: echo.step ?? null },
    namespaceScope: echo.namespaceScope ?? null,
  };
}

function responseState(response) {
  return {
    incomplete: response?.incomplete ?? true,
    incompleteReasons: response?.incompleteReasons ?? ['Ответ недоступен'],
    error: response?.error ?? null,
  };
}

export function attachAnalysis(overview, view, bundles, outDir) {
  const panels = overview.panels.map((panel, index) => {
    const config = view.panels[index];
    const sources = config.response ? [sourceInfo(bundles.current, config.response, 'current', view, outDir)] : [];
    if (config.response && bundles.baseline)
      sources.push(sourceInfo(bundles.baseline, config.response, 'baseline', view, outDir));
    Object.assign(panel, { description: config.description ?? null, sources });
    return {
      id: panel.id,
      name: panel.title,
      unit: panel.unit ?? null,
      description: panel.description,
      kind: panel.type,
      availablePeriod: overview.range,
      sources,
      objects: panel.catalog ?? [],
      messages: panel.messages ?? [],
      grafanaUrl: grafanaLink(sources[0], overview.range),
      tables: (panel.blocks ?? []).map((block) => ({
        dataset: block.dataset,
        rows: block.totalRows,
        columns: block.columns,
      })),
    };
  });
  return {
    version: 1,
    title: overview.title,
    timezone: overview.timezone,
    availablePeriod: overview.range,
    definitions: {
      statisticsPeriod: 'Весь сохранённый период; выбор участка в HTML не меняет эту статистику.',
      max: 'Наибольшее конечное измеренное значение; maxTime — его время в миллисекундах Unix.',
      mean: 'Арифметическое среднее конечных измерений, без взвешивания по времени; пропуски исключены.',
      count: 'Число исходных точек, включая пропуски. finiteCount — конечные значения.',
    },
    incomplete: overview.incomplete,
    errors: overview.errors,
    panels,
    csvFiles: overview.tableFiles,
    fullData: 'Источники в sources[].responseFile содержат полные ответы без округления и уменьшения графиков.',
  };
}
