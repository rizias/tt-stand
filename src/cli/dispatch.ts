import type { ParsedValues } from './args.ts';
import { parseLimit, required, requiredPositional } from './args.ts';
import { runK8sCommand } from '../commands/k8s.ts';
import {
  buildSearchQuery,
  type LogsContext,
  runFieldValues,
  runHttpLogs,
  runLogsQuery,
} from '../commands/logs.ts';
import { readCredentials } from '../credentials.ts';
import { LOGS_DATASOURCE_TYPES, resolveDatasource } from '../datasource.ts';
import { ToolError } from '../errors.ts';
import { GrafanaClient } from '../grafana.ts';
import { requireGrafana } from '../profile.ts';
import { resolveActiveProfile } from '../profiles.ts';
import type { ToolResponse } from '../response.ts';
import { resolveQuery } from '../queryFile.ts';

export async function buildLogsContext(values: ParsedValues): Promise<LogsContext> {
  const profile = resolveActiveProfile(values.config, values.profile ?? null);
  const grafana = requireGrafana(profile);
  const credentials = readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name);
  const client = new GrafanaClient({ credentials, timeoutSeconds: grafana.timeoutSeconds });
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
): Promise<ToolResponse> {
  const profile = resolveActiveProfile(values.config, values.profile ?? null);
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

  throw new ToolError(
    'bad_request',
    `Неизвестная команда k8s: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
  );
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

function httpQuery(
  resolved: { query: string | null; queryFile: string | null },
  searchValues: string[],
): string {
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

function optional(value: string | undefined): string | null {
  return value ?? null;
}

async function actionQuery(
  values: ParsedValues,
  start: string,
  end: string,
  limit: number | null,
  known: LogsKnownEcho,
): Promise<ToolResponse> {
  const { query, queryFile } = requiredQuery(values);
  known.query = query;
  known.queryFile = queryFile;
  return await runLogsQuery(await buildLogsContext(values), {
    command: 'logs query',
    query,
    queryFile,
    start,
    end,
    limit,
  });
}

async function actionSearch(
  values: ParsedValues,
  start: string,
  end: string,
  limit: number | null,
  searchValues: string[],
  known: LogsKnownEcho,
): Promise<ToolResponse> {
  const query = buildSearchQuery(searchValues);
  known.query = query;
  return await runLogsQuery(await buildLogsContext(values), {
    command: 'logs search',
    query,
    start,
    end,
    limit,
    searchValues,
  });
}

async function actionHttp(
  values: ParsedValues,
  start: string,
  end: string,
  limit: number | null,
  searchValues: string[],
  known: LogsKnownEcho,
): Promise<ToolResponse> {
  const resolved = resolveQuery(values.query, values['query-file']);
  known.queryFile = resolved.queryFile;
  known.query = resolved.query;
  const query = httpQuery(resolved, searchValues);
  known.query = query;
  return await runHttpLogs(await buildLogsContext(values), {
    query,
    queryFile: resolved.queryFile,
    start,
    end,
    limit,
    searchValues: searchValues.length > 0 ? searchValues : undefined,
  });
}

async function actionFields(
  values: ParsedValues,
  start: string,
  end: string,
  limit: number | null,
  known: LogsKnownEcho,
): Promise<ToolResponse> {
  const field = required(values.field, 'field');
  const resolved = resolveQuery(values.query, values['query-file']);
  known.query = resolved.query;
  known.queryFile = resolved.queryFile;
  return await runFieldValues(await buildLogsContext(values), {
    field,
    query: resolved.query,
    queryFile: resolved.queryFile,
    start,
    end,
    limit,
  });
}

export async function dispatchLogs(
  action: string | undefined,
  values: ParsedValues,
): Promise<ToolResponse> {
  const known: LogsKnownEcho = {
    query: optional(values.query),
    queryFile: optional(values['query-file']),
    start: optional(values.start),
    end: optional(values.end),
    field: optional(values.field),
    value: values.value ?? null,
  };
  try {
    if (action !== 'query' && action !== 'search' && action !== 'http' && action !== 'fields') {
      throw new ToolError(
        'bad_request',
        `Неизвестная команда logs: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
      );
    }
    const limit = parseLimit(values.limit);
    const start = required(values.start, 'start');
    const end = required(values.end, 'end');
    const searchValues = values.value ?? [];

    if (action === 'query') return await actionQuery(values, start, end, limit, known);
    if (action === 'search') {
      return await actionSearch(values, start, end, limit, searchValues, known);
    }
    if (action === 'http') {
      return await actionHttp(values, start, end, limit, searchValues, known);
    }
    return await actionFields(values, start, end, limit, known);
  } catch (cause) {
    if (cause instanceof ToolError) throw cause.withEcho({ ...known, ...cause.echo });
    throw cause;
  }
}
