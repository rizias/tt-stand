import { callMetrics } from '../metrics.ts';
import {
  filterMatrixOrVector,
  filterNamespaceValues,
  filterSeriesList,
  hideOtherLabelValues,
} from '../metricsScope.ts';
import type { ToolResponse } from '../response.ts';
import {
  buildMetricsResponse,
  callWithEcho,
  type MetricsContext,
  type MetricsEchoFields,
} from './metricsEcho.ts';

export type { MetricsContext } from './metricsEcho.ts';

function timeParams(
  start: string | null,
  end: string | null,
): { params: URLSearchParams; serverChosen: string[] } {
  const params = new URLSearchParams();
  const serverChosen: string[] = [];
  if (start !== null) params.set('start', start);
  else serverChosen.push('start');
  if (end !== null) params.set('end', end);
  else serverChosen.push('end');
  return { params, serverChosen };
}

function withMatch(params: URLSearchParams, match: string[] | null): void {
  for (const selector of match ?? []) params.append('match[]', selector);
}

interface QueryOptions {
  query: string;
  queryFile: string | null;
  start: string;
  end: string;
  step: string | null;
}

export async function runMetricsQuery(
  context: MetricsContext,
  options: QueryOptions,
): Promise<ToolResponse> {
  const params = new URLSearchParams({
    query: options.query,
    start: options.start,
    end: options.end,
  });
  const serverChosen: string[] = [];
  if (options.step !== null) params.set('step', options.step);
  else serverChosen.push('step');

  const echo: MetricsEchoFields = {
    query: options.query,
    queryFile: options.queryFile,
    match: null,
    label: null,
    start: options.start,
    end: options.end,
    step: options.step,
    time: null,
    serverChosen,
  };

  const call = await callWithEcho(context, echo, () =>
    callMetrics(
      context.transport,
      context.baseUrl,
      context.datasource,
      'POST',
      'api/v1/query_range',
      params,
    ),
  );

  const { data, outOfScope, withoutNamespace, shapeHidden } = filterMatrixOrVector(
    call.envelope.data,
    context.namespaceScope,
  );

  return buildMetricsResponse({
    command: 'metrics query',
    context,
    call,
    data,
    recordsOutOfScope: outOfScope,
    recordsOutOfScopeReason: 'seriesOutOfScope',
    seriesWithoutNamespace: withoutNamespace,
    valuesHiddenByScope: 0,
    responseShapeHidden: shapeHidden,
    summaryMode: 'series',
    echo,
  });
}

interface InstantOptions {
  query: string;
  queryFile: string | null;
  time: string | null;
}

export async function runMetricsInstant(
  context: MetricsContext,
  options: InstantOptions,
): Promise<ToolResponse> {
  const params = new URLSearchParams({ query: options.query });
  const serverChosen: string[] = [];
  if (options.time !== null) params.set('time', options.time);
  else serverChosen.push('time');

  const echo: MetricsEchoFields = {
    query: options.query,
    queryFile: options.queryFile,
    match: null,
    label: null,
    start: null,
    end: null,
    step: null,
    time: options.time,
    serverChosen,
  };

  const call = await callWithEcho(context, echo, () =>
    callMetrics(
      context.transport,
      context.baseUrl,
      context.datasource,
      'POST',
      'api/v1/query',
      params,
    ),
  );

  const { data, outOfScope, withoutNamespace, shapeHidden } = filterMatrixOrVector(
    call.envelope.data,
    context.namespaceScope,
  );

  return buildMetricsResponse({
    command: 'metrics instant',
    context,
    call,
    data,
    recordsOutOfScope: outOfScope,
    recordsOutOfScopeReason: 'seriesOutOfScope',
    seriesWithoutNamespace: withoutNamespace,
    valuesHiddenByScope: 0,
    responseShapeHidden: shapeHidden,
    summaryMode: 'series',
    echo,
  });
}

interface LabelsOptions {
  label: string | null;
  match: string[] | null;
  start: string | null;
  end: string | null;
}

function filterLabelsData(
  label: string | null,
  data: unknown,
  scope: MetricsContext['namespaceScope'],
): { data: unknown; outOfScope: number; hidden: number; shapeHidden: boolean } {
  if (label === null) return { data, outOfScope: 0, hidden: 0, shapeHidden: false };
  if (label === 'namespace') {
    const filtered = filterNamespaceValues(data, scope);
    return {
      data: filtered.data,
      outOfScope: filtered.outOfScope,
      hidden: 0,
      shapeHidden: filtered.shapeHidden,
    };
  }
  const filtered = hideOtherLabelValues(data, scope);
  return {
    data: filtered.data,
    outOfScope: 0,
    hidden: filtered.hidden,
    shapeHidden: filtered.shapeHidden,
  };
}

export async function runMetricsLabels(
  context: MetricsContext,
  options: LabelsOptions,
): Promise<ToolResponse> {
  const { params, serverChosen } = timeParams(options.start, options.end);
  withMatch(params, options.match);
  if (options.match === null || options.match.length === 0) serverChosen.push('match[]');

  const echo: MetricsEchoFields = {
    query: null,
    queryFile: null,
    match: options.match,
    label: options.label,
    start: options.start,
    end: options.end,
    step: null,
    time: null,
    serverChosen,
  };

  const path =
    options.label === null
      ? 'api/v1/labels'
      : `api/v1/label/${encodeURIComponent(options.label)}/values`;
  const method = options.label === null ? 'POST' : 'GET';

  const call = await callWithEcho(context, echo, () =>
    callMetrics(context.transport, context.baseUrl, context.datasource, method, path, params),
  );

  const { data, outOfScope, hidden, shapeHidden } = filterLabelsData(
    options.label,
    call.envelope.data,
    context.namespaceScope,
  );

  return buildMetricsResponse({
    command: 'metrics labels',
    context,
    call,
    data,
    recordsOutOfScope: outOfScope,
    recordsOutOfScopeReason: 'labelValuesOutOfScope',
    seriesWithoutNamespace: 0,
    valuesHiddenByScope: hidden,
    responseShapeHidden: shapeHidden,
    summaryMode: 'values',
    echo,
  });
}

interface SeriesOptions {
  match: string[];
  start: string | null;
  end: string | null;
}

export async function runMetricsSeries(
  context: MetricsContext,
  options: SeriesOptions,
): Promise<ToolResponse> {
  const { params, serverChosen } = timeParams(options.start, options.end);
  withMatch(params, options.match);

  const echo: MetricsEchoFields = {
    query: null,
    queryFile: null,
    match: options.match,
    label: null,
    start: options.start,
    end: options.end,
    step: null,
    time: null,
    serverChosen,
  };

  const call = await callWithEcho(context, echo, () =>
    callMetrics(
      context.transport,
      context.baseUrl,
      context.datasource,
      'POST',
      'api/v1/series',
      params,
    ),
  );

  const { data, outOfScope, withoutNamespace, shapeHidden } = filterSeriesList(
    call.envelope.data,
    context.namespaceScope,
  );

  return buildMetricsResponse({
    command: 'metrics series',
    context,
    call,
    data,
    recordsOutOfScope: outOfScope,
    recordsOutOfScopeReason: 'seriesOutOfScope',
    seriesWithoutNamespace: withoutNamespace,
    valuesHiddenByScope: 0,
    responseShapeHidden: shapeHidden,
    summaryMode: 'values',
    echo,
  });
}
