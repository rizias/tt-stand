import type { ParsedValues } from './args.ts';
import { parseLimit, required, requiredPositional } from './args.ts';
import { buildSearchQuery, type LogsContext, runFieldValues, runHttpLogs, runLogsQuery } from '../commands/logs.ts';
import { readCredentials } from '../credentials.ts';
import { LOGS_DATASOURCE_TYPES, resolveDatasource } from '../datasource.ts';
import { ToolError } from '../errors.ts';
import { GrafanaClient } from '../grafana.ts';
import { requireGrafana, type Profile } from '../profile.ts';
import type { RequestObserver } from '../grafanaTransport.ts';
import { resolveActiveProfile } from '../profiles.ts';
import type { ToolResponse } from '../response.ts';
import { resolveQuery } from '../queryFile.ts';

export async function buildLogsContext(
  values: ParsedValues,
  observer?: RequestObserver,
  resolvedProfile?: Profile,
): Promise<LogsContext> {
  const profile = resolvedProfile ?? resolveActiveProfile(values.config, values.profile ?? null);
  const grafana = requireGrafana(profile);
  const credentials = readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name);
  const client = new GrafanaClient({ credentials, timeoutSeconds: grafana.timeoutSeconds, observer });
  const datasource = await resolveDatasource(
    client.httpTransport,
    grafana.datasourceUid,
    LOGS_DATASOURCE_TYPES,
    'grafana.datasourceUid',
  );
  return { client, datasource, profile: profile.name, namespaceScope: profile.namespaceScope };
}

export async function dispatchK8s(
  action: string | undefined,
  positionals: string[],
  values: ParsedValues,
  loadProfile = (): Profile => resolveActiveProfile(values.config, values.profile ?? null),
): Promise<ToolResponse> {
  const profile = loadProfile();
  const { runK8sCommand } = await import('../commands/k8s.ts');
  const namespace = values.namespace ?? null;

  if (action === 'get') {
    return await runK8sCommand(profile, {
      action: 'get',
      resource: requiredPositional(positionals[2], 'ресурс'),
      namespace,
      name: values.name ?? null,
    });
  }
  if (action === 'log') {
    return await runK8sCommand(profile, {
      action: 'log',
      pod: requiredPositional(positionals[2], 'под'),
      namespace,
      container: values.container ?? null,
      previous: values.previous === true,
    });
  }
  if (action === 'events') return await runK8sCommand(profile, { action: 'events', namespace });
  if (action === 'pods') return await runK8sCommand(profile, { action: 'pods', namespace });
  if (action === 'history') {
    return await runK8sCommand(profile, {
      action: 'history',
      workload: requiredPositional(positionals[2], 'рабочая нагрузка'),
      namespace,
    });
  }

  throw new ToolError('bad_request', `Неизвестная команда k8s: ${action ?? '(не задана)'}. Справка: tt-stand --help`);
}

function requiredQuery(values: ParsedValues): { query: string; queryFile: string | null } {
  const resolved = resolveQuery(values.query, values['query-file']);
  if (resolved.query === null) {
    throw new ToolError('bad_request', 'Не задан обязательный параметр --query или --query-file.');
  }
  return { query: resolved.query, queryFile: resolved.queryFile };
}

function httpQuery(resolved: { query: string | null; queryFile: string | null }, searchValues: string[]): string {
  if (resolved.query !== null && searchValues.length > 0) {
    throw new ToolError(
      'bad_request',
      'Для logs http задайте либо --query/--query-file, либо один или несколько --value, но не оба способа сразу.',
    );
  }
  if (resolved.query !== null) return resolved.query;
  return searchValues.length > 0 ? buildSearchQuery(searchValues) : '*';
}

interface LogsKnownEcho {
  query: string | null;
  queryFile: string | null;
  start: string | null;
  end: string | null;
  field: string | null;
  value: string[] | null;
}

type LogsOperation =
  | { action: 'query' | 'search'; options: Parameters<typeof runLogsQuery>[1] }
  | { action: 'http'; options: Parameters<typeof runHttpLogs>[1] }
  | { action: 'fields'; options: Parameters<typeof runFieldValues>[1] };

export type PreparedLogs = LogsOperation & { known: LogsKnownEcho };

function knownFromValues(values: ParsedValues): LogsKnownEcho {
  return {
    query: values.query ?? null,
    queryFile: values['query-file'] ?? null,
    start: values.start ?? null,
    end: values.end ?? null,
    field: values.field ?? null,
    value: values.value ?? null,
  };
}

function operation(
  action: string,
  values: ParsedValues,
  known: LogsKnownEcho,
  common: { start: string; end: string; limit: number | null },
): LogsOperation {
  const searchValues = values.value ?? [];
  if (action === 'query') {
    const { query, queryFile } = requiredQuery(values);
    known.query = query;
    known.queryFile = queryFile;
    return { action, options: { command: 'logs query', query, queryFile, ...common } };
  }
  if (action === 'search') {
    const query = buildSearchQuery(searchValues);
    known.query = query;
    return {
      action,
      options: { command: 'logs search', query, searchValues, ...common },
    };
  }
  if (action === 'http') {
    const resolved = resolveQuery(values.query, values['query-file']);
    known.query = resolved.query;
    known.queryFile = resolved.queryFile;
    const query = httpQuery(resolved, searchValues);
    known.query = query;
    return {
      action,
      options: {
        query,
        queryFile: resolved.queryFile,
        searchValues: searchValues.length > 0 ? searchValues : undefined,
        ...common,
      },
    };
  }
  const field = required(values.field, 'field');
  const resolved = resolveQuery(values.query, values['query-file']);
  known.query = resolved.query;
  known.queryFile = resolved.queryFile;
  return {
    action: 'fields',
    options: { field, query: resolved.query, queryFile: resolved.queryFile, ...common },
  };
}

function rethrowKnown(cause: unknown, known: LogsKnownEcho): never {
  if (cause instanceof ToolError) throw cause.withEcho({ ...known, ...cause.echo });
  throw cause;
}

export function prepareLogs(action: string | undefined, values: ParsedValues): PreparedLogs {
  const known = knownFromValues(values);
  try {
    if (action !== 'query' && action !== 'search' && action !== 'http' && action !== 'fields') {
      throw new ToolError(
        'bad_request',
        `Неизвестная команда logs: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
      );
    }
    const limit = parseLimit(values.limit);
    const common = {
      start: required(values.start, 'start'),
      end: required(values.end, 'end'),
      limit,
    };
    return { ...operation(action, values, known, common), known };
  } catch (cause) {
    return rethrowKnown(cause, known);
  }
}

export async function executeLogs(
  request: PreparedLogs,
  getContext: () => Promise<LogsContext>,
): Promise<ToolResponse> {
  try {
    const context = await getContext();
    if (request.action === 'http') return await runHttpLogs(context, request.options);
    if (request.action === 'fields') return await runFieldValues(context, request.options);
    return await runLogsQuery(context, request.options);
  } catch (cause) {
    return rethrowKnown(cause, request.known);
  }
}

export async function dispatchLogs(
  action: string | undefined,
  values: ParsedValues,
  loadProfile = (): Profile => resolveActiveProfile(values.config, values.profile ?? null),
): Promise<ToolResponse> {
  return await executeLogs(prepareLogs(action, values), () => buildLogsContext(values, undefined, loadProfile()));
}
