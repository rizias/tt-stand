import { NAMESPACE_FIELD } from '../environment.ts';
import { GrafanaClient } from '../grafana.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';
import { scopeExtraFilter } from '../scope.ts';
import type { LogsContext } from './logs.ts';

export async function runEnv(context: LogsContext): Promise<ToolResponse> {
  const params = new URLSearchParams({ field: NAMESPACE_FIELD, query: '*' });
  const filter = scopeExtraFilter(context.namespaceScope, NAMESPACE_FIELD);
  if (filter !== null) params.set('extra_filters', filter);

  const result = await context.client.fieldValues(context.datasource, params);
  const namespaces = result.values.map((item) => item.value);
  const acquiredAt = new Date().toISOString();
  const datasourceNote =
    context.datasource.candidates.length > 1
      ? `источников этого типа несколько (${context.datasource.candidates.join(', ')}), взят первый; задать явно — grafana.datasourceUid`
      : null;

  return {
    ok: true,
    command: 'env',
    data: {
      namespaces,
      acquiredAt,
    },
    summary: {
      namespaceCount: namespaces.length,
      acquiredAt,
    },
    echo: {
      command: 'env',
      query: '*',
      request: GrafanaClient.describeRequest('select/logsql/field_values', params),
      start: null,
      end: null,
      limit: null,
      limitNote: ECHO_CONSTANTS.noLimit,
      datasource: context.datasource.name,
      datasourceNote,
      recordsReturned: namespaces.length,
      hitLimit: false,
      unparsableLines: 0,
      order: 'namespace — в порядке хранилища',
      unavailableSources: [],
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
      profile: context.profile,
      namespaceScope: context.namespaceScope,
      recordsOutOfScope: 0,
    },
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}
