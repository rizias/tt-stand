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
import { GrafanaTransport, type RequestObserver } from '../grafanaTransport.ts';
import { requireGrafana, type Profile } from '../profile.ts';
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

type Operation =
  | { action: 'query'; options: Parameters<typeof runMetricsQuery>[1] }
  | { action: 'instant'; options: Parameters<typeof runMetricsInstant>[1] }
  | { action: 'labels'; options: Parameters<typeof runMetricsLabels>[1] }
  | { action: 'series'; options: Parameters<typeof runMetricsSeries>[1] };

export type PreparedMetrics = Operation & { known: MetricsKnownEcho };

function knownFromValues(values: ParsedValues): MetricsKnownEcho {
  return {
    query: values.query ?? null,
    queryFile: values['query-file'] ?? null,
    start: values.start ?? null,
    end: values.end ?? null,
    step: values.step ?? null,
    time: values.time ?? null,
    match: values.match ?? null,
    label: values.label ?? null,
  };
}

export async function buildMetricsContext(
  values: ParsedValues,
  observer?: RequestObserver,
  resolvedProfile?: Profile,
): Promise<MetricsContext> {
  const profile = resolvedProfile ?? resolveActiveProfile(values.config, values.profile ?? null);
  const grafana = requireGrafana(profile);
  const credentials = readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name);
  const transport = new GrafanaTransport({
    credentials,
    timeoutSeconds: grafana.timeoutSeconds,
    observer,
  });
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

function requiredQuery(values: ParsedValues, known: MetricsKnownEcho): string {
  const resolved = resolveQuery(values.query, values['query-file']);
  known.query = resolved.query;
  if (resolved.query === null) {
    throw new ToolError('bad_request', 'Не задан обязательный параметр --query или --query-file.');
  }
  return resolved.query;
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
        'сервер разрешит такой сегмент как ссылку на каталог, а не как имя метки. ' +
        'Задайте отличное от «.» и «..» непустое имя метки.',
    );
  }
}

function prepareOperation(action: string | undefined, values: ParsedValues, known: MetricsKnownEcho): Operation {
  if (action === 'query') {
    const query = requiredQuery(values, known);
    return {
      action,
      options: {
        query,
        queryFile: known.queryFile,
        start: required(values.start, 'start'),
        end: required(values.end, 'end'),
        step: known.step,
      },
    };
  }
  if (action === 'instant') {
    return {
      action,
      options: {
        query: requiredQuery(values, known),
        queryFile: known.queryFile,
        time: known.time,
      },
    };
  }
  if (action === 'labels') {
    validateLabelSegment(known.label);
    return {
      action,
      options: {
        label: known.label,
        match: known.match,
        start: known.start,
        end: known.end,
      },
    };
  }
  if (action === 'series') {
    known.match = values.match ?? [];
    if (known.match.length === 0) {
      throw new ToolError('bad_request', 'Для metrics series нужен хотя бы один --match.');
    }
    return {
      action,
      options: { match: known.match, start: known.start, end: known.end },
    };
  }
  throw new ToolError(
    'bad_request',
    `Неизвестная команда metrics: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
  );
}

function rethrowKnown(cause: unknown, known: MetricsKnownEcho): never {
  if (cause instanceof ToolError) throw cause.withEcho({ ...known, ...cause.echo });
  throw cause;
}

export function prepareMetrics(action: string | undefined, values: ParsedValues): PreparedMetrics {
  const known = knownFromValues(values);
  try {
    return { ...prepareOperation(action, values, known), known };
  } catch (cause) {
    return rethrowKnown(cause, known);
  }
}

export async function executeMetrics(
  request: PreparedMetrics,
  getContext: () => Promise<MetricsContext>,
): Promise<ToolResponse> {
  try {
    const context = await getContext();
    if (request.action === 'query') return await runMetricsQuery(context, request.options);
    if (request.action === 'instant') return await runMetricsInstant(context, request.options);
    if (request.action === 'labels') return await runMetricsLabels(context, request.options);
    return await runMetricsSeries(context, request.options);
  } catch (cause) {
    return rethrowKnown(cause, request.known);
  }
}

export async function dispatchMetrics(
  action: string | undefined,
  values: ParsedValues,
  loadProfile = (): Profile => resolveActiveProfile(values.config, values.profile ?? null),
): Promise<ToolResponse> {
  return await executeMetrics(prepareMetrics(action, values), () =>
    buildMetricsContext(values, undefined, loadProfile()),
  );
}
