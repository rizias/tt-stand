import {
  runMetricsInstant,
  runMetricsLabels,
  runMetricsQuery,
  runMetricsSeries,
  type MetricsContext,
} from '../commands/metrics.ts';
import { readCredentials } from '../credentials.ts';
import { METRICS_DATASOURCE_TYPES, resolveDatasource } from '../datasource.ts';
import { ToolError } from '../errors.ts';
import { GrafanaTransport } from '../grafanaTransport.ts';
import { requireGrafana } from '../profile.ts';
import { resolveActiveProfile } from '../profiles.ts';
import { resolveQuery } from '../queryFile.ts';
import type { ToolResponse } from '../response.ts';
import { type ParsedValues, required } from './args.ts';

interface MetricsKnownEcho {
  query: string | null;
  queryFile: string | null;
  start: string | null;
  end: string | null;
  step: string | null;
  time: string | null;
  match: string[] | null;
  label: string | null;
}

function knownFromValues(values: ParsedValues): MetricsKnownEcho {
  return {
    query: optional(values.query),
    queryFile: optional(values['query-file']),
    start: optional(values.start),
    end: optional(values.end),
    step: optional(values.step),
    time: optional(values.time),
    match: values.match ?? null,
    label: optional(values.label),
  };
}

async function buildMetricsContext(values: ParsedValues): Promise<MetricsContext> {
  const profile = resolveActiveProfile(values.config, values.profile ?? null);
  const grafana = requireGrafana(profile);
  const credentials = readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name);
  const transport = new GrafanaTransport({ credentials, timeoutSeconds: grafana.timeoutSeconds });
  const datasource = await resolveDatasource(
    transport,
    grafana.metricsDatasourceUid,
    METRICS_DATASOURCE_TYPES,
    'grafana.metricsDatasourceUid',
  );
  return {
    transport,
    baseUrl: credentials.baseUrl,
    datasource,
    profile: profile.name,
    namespaceScope: profile.namespaceScope,
  };
}

function requiredQuery(values: ParsedValues): { query: string; queryFile: string | null } {
  const resolved = resolveQuery(values.query, values['query-file']);
  if (resolved.query === null) {
    throw new ToolError(
      'bad_request',
      'Не задан обязательный параметр --query или --query-file.',
    );
  }
  return { query: resolved.query, queryFile: resolved.queryFile };
}

function optional(value: string | undefined): string | null {
  return value ?? null;
}

function validateLabelSegment(label: string | null): void {
  if (label === null) return;
  if (label === '') {
    throw new ToolError(
      'bad_request',
      'Пустое имя метки нельзя передать сегментом пути api/v1/label/<имя>/values: ' +
        'путь станет api/v1/label//values.',
    );
  }
  if (label === '.' || label === '..') {
    throw new ToolError(
      'bad_request',
      `Имя метки «${label}» нельзя передать сегментом пути api/v1/label/<имя>/values: ` +
        `сервер разрешит такой сегмент как ссылку на каталог, а не как имя метки. ` +
        `Задайте отличное от «.» и «..» непустое имя метки.`,
    );
  }
}

async function actionQuery(values: ParsedValues, known: MetricsKnownEcho): Promise<ToolResponse> {
  known.query = optional(values.query);
  known.queryFile = optional(values['query-file']);
  known.start = optional(values.start);
  known.end = optional(values.end);
  known.step = optional(values.step);
  const { query, queryFile } = requiredQuery(values);
  known.query = query;
  known.queryFile = queryFile;
  const start = required(values.start, 'start');
  const end = required(values.end, 'end');
  return await runMetricsQuery(await buildMetricsContext(values), {
    query,
    queryFile,
    start,
    end,
    step: known.step,
  });
}

async function actionInstant(
  values: ParsedValues,
  known: MetricsKnownEcho,
): Promise<ToolResponse> {
  known.query = optional(values.query);
  known.queryFile = optional(values['query-file']);
  known.time = optional(values.time);
  const { query, queryFile } = requiredQuery(values);
  known.query = query;
  known.queryFile = queryFile;
  return await runMetricsInstant(await buildMetricsContext(values), {
    query,
    queryFile,
    time: known.time,
  });
}

async function actionLabels(values: ParsedValues, known: MetricsKnownEcho): Promise<ToolResponse> {
  const label = optional(values.label);
  known.label = label;
  known.match = values.match ?? null;
  known.start = optional(values.start);
  known.end = optional(values.end);
  validateLabelSegment(label);
  return await runMetricsLabels(await buildMetricsContext(values), {
    label,
    match: known.match,
    start: known.start,
    end: known.end,
  });
}

async function actionSeries(values: ParsedValues, known: MetricsKnownEcho): Promise<ToolResponse> {
  const match = values.match ?? [];
  known.match = match;
  known.start = optional(values.start);
  known.end = optional(values.end);
  if (match.length === 0) {
    throw new ToolError('bad_request', 'Для metrics series нужен хотя бы один --match.');
  }
  return await runMetricsSeries(await buildMetricsContext(values), {
    match,
    start: known.start,
    end: known.end,
  });
}

export async function dispatchMetrics(
  action: string | undefined,
  values: ParsedValues,
): Promise<ToolResponse> {
  const known = knownFromValues(values);
  try {
    if (action === 'query') return await actionQuery(values, known);
    if (action === 'instant') return await actionInstant(values, known);
    if (action === 'labels') return await actionLabels(values, known);
    if (action === 'series') return await actionSeries(values, known);

    throw new ToolError(
      'bad_request',
      `Неизвестная команда metrics: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
    );
  } catch (cause) {
    if (cause instanceof ToolError) throw cause.withEcho({ ...known, ...cause.echo });
    throw cause;
  }
}
