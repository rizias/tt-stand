import { ToolError } from '../errors.ts';
import { type Datasource, GrafanaClient } from '../grafana.ts';
import type { LogsContext } from './logs.ts';

export function datasourceEcho(datasource: Datasource): {
  datasource: string;
  datasourceType: string | null;
  datasourceUid: string;
  datasourceNote: string | null;
} {
  return {
    datasource: datasource.name,
    datasourceType: datasource.type,
    datasourceUid: datasource.uid,
    datasourceNote:
      datasource.candidates.length <= 1
        ? null
        : `источников этого типа несколько (${datasource.candidates.map((item) => item.name).join(', ')}), взят первый; задать явно — grafana.datasourceUid`,
  };
}

export async function fieldValuesWithEcho(
  context: LogsContext,
  params: URLSearchParams,
  echo: Record<string, unknown>,
): Promise<Awaited<ReturnType<GrafanaClient['fieldValues']>>> {
  try {
    return await context.client.fieldValues(context.datasource, params);
  } catch (cause) {
    if (!(cause instanceof ToolError)) throw cause;
    throw cause.withEcho({
      ...echo,
      ...datasourceEcho(context.datasource),
      request: GrafanaClient.describeRequest('select/logsql/field_values', params),
      profile: context.profile,
      namespaceScope: context.namespaceScope,
    });
  }
}
