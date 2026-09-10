import type { ParsedValues } from './args.ts';
import { required, requiredPositional } from './args.ts';
import { runK8sCommand } from '../commands/k8s.ts';
import {
  buildSearchQuery,
  type LogsContext,
  runFieldValues,
  runHttpLogs,
  runLogsQuery,
} from '../commands/logs.ts';
import { readCredentials } from '../credentials.ts';
import { ToolError } from '../errors.ts';
import { GrafanaClient } from '../grafana.ts';
import { requireGrafana } from '../profile.ts';
import { resolveActiveProfile } from '../profiles.ts';
import type { ToolResponse } from '../response.ts';

export async function buildLogsContext(values: ParsedValues): Promise<LogsContext> {
  const profile = resolveActiveProfile(values.config, values.profile ?? null);
  const grafana = requireGrafana(profile);
  const credentials = readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name);
  const client = new GrafanaClient({ credentials, timeoutSeconds: grafana.timeoutSeconds });
  const datasource = await client.resolveDatasource(grafana.datasourceUid);
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

function httpQuery(values: ParsedValues, searchValues: string[]): string {
  if (values.query !== undefined && searchValues.length > 0) {
    throw new ToolError(
      'bad_request',
      'Для logs http задайте либо --query, либо один или несколько --value, но не оба способа сразу.',
    );
  }
  if (values.query !== undefined) return required(values.query, 'query');
  return searchValues.length > 0 ? buildSearchQuery(searchValues) : '*';
}

export async function dispatchLogs(
  action: string | undefined,
  values: ParsedValues,
  limit: number | null,
): Promise<ToolResponse> {
  const start = required(values.start, 'start');
  const end = required(values.end, 'end');
  const searchValues = values.value ?? [];

  if (action === 'query') {
    const query = required(values.query, 'query');
    return await runLogsQuery(await buildLogsContext(values), {
      command: 'logs query',
      query,
      start,
      end,
      limit,
    });
  }

  if (action === 'search') {
    const query = buildSearchQuery(searchValues);
    return await runLogsQuery(await buildLogsContext(values), {
      command: 'logs search',
      query,
      start,
      end,
      limit,
      searchValues,
    });
  }

  if (action === 'http') {
    const query = httpQuery(values, searchValues);
    return await runHttpLogs(await buildLogsContext(values), {
      query,
      start,
      end,
      limit,
      searchValues: searchValues.length > 0 ? searchValues : undefined,
    });
  }

  if (action === 'fields') {
    const field = required(values.field, 'field');
    return await runFieldValues(await buildLogsContext(values), {
      field,
      query: values.query ?? null,
      start,
      end,
      limit,
    });
  }

  throw new ToolError(
    'bad_request',
    `Неизвестная команда logs: ${action ?? '(не задана)'}. Справка: tt-stand --help`,
  );
}
