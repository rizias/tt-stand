import {
  hasIngressUpstream,
  type LabelledRecord,
  labelRecords,
  NAMESPACE_FIELD,
  summarizeLabelled,
  UNKNOWN_ENVIRONMENT,
} from '../environment.ts';
import { ToolError } from '../errors.ts';
import { type Datasource, GrafanaClient } from '../grafana.ts';
import { parseHttpRecord } from '../http.ts';
import { ECHO_CONSTANTS, ResponseBuilder, type ToolResponse } from '../response.ts';
import { matchesScope, type NamespaceScope, scopeExtraFilter } from '../scope.ts';

export interface LogsContext {
  client: GrafanaClient;
  datasource: Datasource;
  profile: string;
  namespaceScope: NamespaceScope;
}

export function buildSearchQuery(values: string[]): string {
  if (values.length === 0) {
    throw new ToolError('bad_request', 'Не передано ни одного искомого значения.');
  }
  const terms = values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return terms.length === 1 ? (terms[0] as string) : `(${terms.join(' OR ')})`;
}

function datasourceNote(datasource: Datasource): string | undefined {
  if (datasource.candidates.length <= 1) return undefined;
  return `источников этого типа несколько (${datasource.candidates.join(', ')}), взят первый; задать явно — grafana.datasourceUid`;
}

function applyScope(params: URLSearchParams, scope: NamespaceScope, allowMissing: boolean): void {
  const filter = scopeExtraFilter(scope, NAMESPACE_FIELD, { allowMissing });
  if (filter !== null) params.set('extra_filters', filter);
}

function applyNamespaceScope(
  labelled: LabelledRecord[],
  scope: NamespaceScope,
): { kept: LabelledRecord[]; droppedCount: number } {
  if (scope === null) return { kept: labelled, droppedCount: 0 };
  const kept = labelled.filter((item) => {
    if (item.environmentSource !== 'upstream') return true;
    if (item.environment === UNKNOWN_ENVIRONMENT) return true;
    return matchesScope(item.environment, scope);
  });
  return { kept, droppedCount: labelled.length - kept.length };
}

interface RunOptions {
  command: string;
  query: string;
  start: string;
  end: string;
  limit: number | null;
  searchValues?: string[];
}

async function queryWithEcho(
  context: LogsContext,
  options: RunOptions,
  params: URLSearchParams,
): Promise<Awaited<ReturnType<GrafanaClient['queryLogs']>>> {
  try {
    return await context.client.queryLogs(context.datasource, params, options.limit);
  } catch (cause) {
    if (!(cause instanceof ToolError)) throw cause;
    throw cause.withEcho({
      query: options.query,
      start: options.start,
      end: options.end,
      limit: options.limit,
      request: GrafanaClient.describeRequest('select/logsql/query', params),
      datasource: context.datasource.name,
      datasourceNote: datasourceNote(context.datasource) ?? null,
      profile: context.profile,
      namespaceScope: context.namespaceScope,
    });
  }
}

type QueryResult = Awaited<ReturnType<GrafanaClient['queryLogs']>>;

function addResultReasons(builder: ResponseBuilder, result: QueryResult): void {
  if (result.hitLimit) builder.addReason('truncatedByLimit');
  if (result.unparsableLines > 0) builder.addReason('unparsableLines');
  if (result.aborted) builder.addReason('streamAborted');
  if (result.bodyMissing) builder.addReason('bodyMissing');
}

async function resolveIngressNamespaces(
  context: LogsContext,
  result: QueryResult,
  builder: ResponseBuilder,
): Promise<{ namespaces: string[]; unavailableSources: string[] }> {
  const unavailableSources = result.aborted ? ['хранилище логов: поток оборван'] : [];
  if (!hasIngressUpstream(result.records)) return { namespaces: [], unavailableSources };

  try {
    const namespaceParams = new URLSearchParams({ field: NAMESPACE_FIELD, query: '*' });
    const namespaceResult = await context.client.fieldValues(context.datasource, namespaceParams);
    return { namespaces: namespaceResult.values.map((item) => item.value), unavailableSources };
  } catch (cause) {
    builder.addReason('namespaceCatalogUnavailable');
    unavailableSources.push(`каталог namespace: ${(cause as Error).message}`);
    return { namespaces: [], unavailableSources };
  }
}

export async function runLogsQuery(
  context: LogsContext,
  options: RunOptions,
): Promise<ToolResponse> {
  const builder = new ResponseBuilder();
  const params = new URLSearchParams({
    query: options.query,
    start: options.start,
    end: options.end,
  });
  if (options.limit !== null) params.set('limit', String(options.limit));
  applyScope(params, context.namespaceScope, true);

  const result = await queryWithEcho(context, options, params);
  addResultReasons(builder, result);

  const { namespaces, unavailableSources } = await resolveIngressNamespaces(
    context,
    result,
    builder,
  );

  const { labelled } = labelRecords(result.records, namespaces);
  const { kept, droppedCount } = applyNamespaceScope(labelled, context.namespaceScope);
  if (droppedCount > 0) builder.addReason('outOfScopeDropped');
  const summary = summarizeLabelled(kept);
  if (summary.unknownCount > 0) builder.addReason('unknownEnvironment');

  const note = datasourceNote(context.datasource);

  return {
    ok: !result.aborted,
    command: options.command,
    data: kept,
    summary: {
      ...summary,
      searchValues: options.searchValues ?? null,
    },
    echo: {
      command: options.command,
      query: options.query,
      request: GrafanaClient.describeRequest('select/logsql/query', params),
      start: options.start,
      end: options.end,
      limit: options.limit,
      limitNote: options.limit === null ? ECHO_CONSTANTS.noLimit : 'лимит задан пользователем',
      datasource: context.datasource.name,
      datasourceNote: note ?? null,
      recordsReturned: kept.length,
      hitLimit: result.hitLimit,
      unparsableLines: result.unparsableLines,
      order: ECHO_CONSTANTS.order,
      unavailableSources,
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
      profile: context.profile,
      namespaceScope: context.namespaceScope,
      recordsOutOfScope: droppedCount,
    },
    incomplete: builder.incomplete,
    incompleteReasons: builder.reasonTexts,
    errorClass: result.aborted ? 'stream_aborted' : null,
    error: result.aborted ? `Получение данных прервано: ${result.abortReason}` : null,
  };
}

export async function runHttpLogs(
  context: LogsContext,
  options: Omit<RunOptions, 'command'>,
): Promise<ToolResponse> {
  const response = await runLogsQuery(context, { ...options, command: 'logs http' });
  const rows = response.data as Array<Record<string, unknown>>;
  let unparsed = 0;
  response.data = rows.map((row) => {
    const record = row.record as Record<string, unknown>;
    const http = parseHttpRecord(record);
    if (http === null) unparsed += 1;
    return { ...row, http };
  });
  response.summary = {
    ...(response.summary as Record<string, unknown>),
    httpParsed: rows.length - unparsed,
    httpUnparsed: unparsed,
  };
  return response;
}

export async function runFieldValues(
  context: LogsContext,
  options: {
    field: string;
    query: string | null;
    start: string;
    end: string;
    limit: number | null;
  },
): Promise<ToolResponse> {
  const builder = new ResponseBuilder();
  const params = new URLSearchParams({
    field: options.field,
    query: options.query ?? '*',
    start: options.start,
    end: options.end,
  });
  if (options.limit !== null) params.set('limit', String(options.limit));
  applyScope(params, context.namespaceScope, false);

  const result = await context.client.fieldValues(context.datasource, params);
  const hitLimit = options.limit !== null && result.values.length >= options.limit;
  if (hitLimit) builder.addReason('fieldValuesTruncated');

  const note = datasourceNote(context.datasource);

  return {
    ok: true,
    command: 'logs fields',
    data: result.values,
    summary: { valueCount: result.values.length },
    echo: {
      command: 'logs fields',
      query: options.query ?? '*',
      request: GrafanaClient.describeRequest('select/logsql/field_values', params),
      start: options.start,
      end: options.end,
      limit: options.limit,
      limitNote: options.limit === null ? ECHO_CONSTANTS.noLimit : 'лимит задан пользователем',
      datasource: context.datasource.name,
      datasourceNote: note ?? null,
      recordsReturned: result.values.length,
      hitLimit,
      unparsableLines: 0,
      order: 'значения поля — в порядке хранилища',
      unavailableSources: [],
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
      profile: context.profile,
      namespaceScope: context.namespaceScope,
      recordsOutOfScope: 0,
    },
    incomplete: builder.incomplete,
    incompleteReasons: builder.reasonTexts,
    errorClass: null,
    error: null,
  };
}
