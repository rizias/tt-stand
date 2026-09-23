import type { Datasource } from '../datasource.ts';
import { ToolError } from '../errors.ts';
import type { GrafanaTransport } from '../grafanaTransport.ts';
import type { MetricsCall } from '../metrics.ts';
import { ECHO_CONSTANTS, type Echo, ResponseBuilder, type ToolResponse } from '../response.ts';
import type { NamespaceScope } from '../scope.ts';

export interface MetricsContext {
  transport: GrafanaTransport;
  baseUrl: string;
  datasource: Datasource;
  profile: string;
  namespaceScope: NamespaceScope;
}

export interface MetricsEchoFields {
  query: string | null;
  queryFile: string | null;
  match: string[] | null;
  label: string | null;
  start: string | null;
  end: string | null;
  step: string | null;
  time: string | null;
  serverChosen: string[];
}

export const METRICS_LIMIT_NOTE = 'у команд метрик лимита нет — инструмент своего не подставляет';
export const METRICS_ORDER =
  'порядок рядов и значений — как отдал сервер; инструмент их не переставляет';

export function metricsDatasourceNote(datasource: Datasource): string | null {
  if (datasource.candidates.length === 0) return null;
  if (datasource.candidates.length === 1) {
    return 'источник выбран автоматически: единственный подходящий по типу';
  }
  return `подходящих источников несколько (${datasource.candidates
    .map((item) => `${item.name} (${item.type})`)
    .join(', ')}), взят первый; задать явно — grafana.metricsDatasourceUid`;
}

export async function callWithEcho<T>(
  context: MetricsContext,
  fields: MetricsEchoFields,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (!(cause instanceof ToolError)) throw cause;
    throw cause.withEcho({
      query: fields.query,
      queryFile: fields.queryFile,
      match: fields.match,
      label: fields.label,
      start: fields.start,
      end: fields.end,
      step: fields.step,
      time: fields.time,
      serverChosen: fields.serverChosen,
      datasource: context.datasource.name,
      datasourceType: context.datasource.type,
      datasourceUid: context.datasource.uid,
      datasourceNote: metricsDatasourceNote(context.datasource),
      profile: context.profile,
      namespaceScope: context.namespaceScope,
      limit: null,
      limitNote: METRICS_LIMIT_NOTE,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seriesCounts(data: unknown): { seriesCount: number; pointCount: number } {
  if (data === null || typeof data !== 'object') return { seriesCount: 0, pointCount: 0 };
  const shape = data as { resultType?: string; result?: unknown[] };
  if (shape.resultType === 'matrix' && Array.isArray(shape.result)) {
    const items = shape.result.filter(isRecord);
    const pointCount = items.reduce((sum: number, item) => {
      const values = item.values;
      const histograms = item.histograms;
      return (
        sum + (Array.isArray(values) ? values.length : 0) + (Array.isArray(histograms) ? histograms.length : 0)
      );
    }, 0);
    return { seriesCount: items.length, pointCount };
  }
  if (shape.resultType === 'vector' && Array.isArray(shape.result)) {
    const items = shape.result.filter(isRecord);
    return { seriesCount: items.length, pointCount: items.length };
  }
  return { seriesCount: 0, pointCount: 0 };
}

export interface BuildResponseInput {
  command: string;
  context: MetricsContext;
  call: MetricsCall;
  data: unknown;
  recordsOutOfScope: number;
  recordsOutOfScopeReason: 'seriesOutOfScope' | 'labelValuesOutOfScope';
  seriesWithoutNamespace: number;
  valuesHiddenByScope: number;
  responseShapeHidden: boolean;
  summaryMode: 'series' | 'values';
  echo: MetricsEchoFields;
}

function hasNonEmptyWarnings(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function incompletenessReasons(input: BuildResponseInput): ResponseBuilder {
  const builder = new ResponseBuilder();
  const envelope = input.call.envelope;
  if (envelope.isPartial === true) builder.addReason('serverPartial');
  if (hasNonEmptyWarnings(envelope.warnings)) {
    builder.addReason('serverWarnings');
  }
  if (input.recordsOutOfScope > 0) builder.addReason(input.recordsOutOfScopeReason);
  if (input.seriesWithoutNamespace > 0) builder.addReason('seriesWithoutNamespace');
  if (input.valuesHiddenByScope > 0) {
    builder.addReason('labelValuesHiddenByScope', ` (скрыто: ${input.valuesHiddenByScope})`);
  }
  if (input.responseShapeHidden) builder.addReason('responseShapeHiddenByScope');
  return builder;
}

function metricsCounts(
  summaryMode: 'series' | 'values',
  data: unknown,
): { counts: Record<string, number>; recordsReturned: number } {
  if (summaryMode === 'series') {
    const counts = seriesCounts(data);
    return { counts, recordsReturned: counts.seriesCount };
  }
  const valueCount = Array.isArray(data) ? data.length : 0;
  return { counts: { valueCount }, recordsReturned: valueCount };
}

export function buildMetricsResponse(input: BuildResponseInput): ToolResponse {
  const builder = incompletenessReasons(input);
  const server: Record<string, unknown> = { ...input.call.envelope };
  delete server.status;
  delete server.data;
  const { counts, recordsReturned } = metricsCounts(input.summaryMode, input.data);
  const datasource = input.context.datasource;

  const echo: Echo = {
    command: input.command,
    query: input.echo.query,
    queryFile: input.echo.queryFile,
    request: input.call.request,
    start: input.echo.start,
    end: input.echo.end,
    limit: null,
    limitNote: METRICS_LIMIT_NOTE,
    datasource: datasource.name,
    datasourceNote: metricsDatasourceNote(datasource),
    recordsReturned,
    hitLimit: false,
    unparsableLines: 0,
    order: METRICS_ORDER,
    unavailableSources: [],
    valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
    identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
    profile: input.context.profile,
    namespaceScope: input.context.namespaceScope,
    recordsOutOfScope: input.recordsOutOfScope,
    match: input.echo.match,
    label: input.echo.label,
    step: input.echo.step,
    time: input.echo.time,
    serverChosen: input.echo.serverChosen,
    datasourceType: datasource.type,
    datasourceUid: datasource.uid,
    seriesWithoutNamespace: input.seriesWithoutNamespace,
    valuesHiddenByScope: input.valuesHiddenByScope,
  };

  return {
    ok: true,
    command: input.command,
    data: input.data,
    summary: { ...counts, server },
    echo,
    incomplete: builder.incomplete,
    incompleteReasons: builder.reasonTexts,
    errorClass: null,
    error: null,
  };
}
