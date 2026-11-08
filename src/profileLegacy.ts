import { expectNumber, expectString, expectTable } from './configValues.ts';
import { ToolError } from './errors.ts';
import { normalizePath } from './paths.ts';
import type { GrafanaAccess, KubernetesAccess } from './profile.ts';

function datasource(value: unknown, field: string, location: string): string | null {
  if (value === undefined) return null;
  const parsed = expectString(value, field, location);
  if (['', '.', '..'].includes(parsed)) {
    throw new ToolError('config_invalid', `Поле ${field} в ${location} должно быть непустым идентификатором.`);
  }
  return parsed;
}

export function legacyGrafana(
  raw: unknown,
  name: string,
  path: string,
  defaultCredentialsFile: string,
): GrafanaAccess | null {
  const location = `профиле ${name} (${path})`;
  const table = expectTable(raw, 'grafana', location);
  if (table === null) return null;
  const timeoutSeconds =
    table.timeoutSeconds === undefined ? null : expectNumber(table.timeoutSeconds, 'grafana.timeoutSeconds', location);
  if (timeoutSeconds !== null && timeoutSeconds <= 0) {
    throw new ToolError('config_invalid', `Поле grafana.timeoutSeconds в ${location} должно быть больше нуля.`);
  }
  return {
    baseUrl: table.baseUrl === undefined ? null : expectString(table.baseUrl, 'grafana.baseUrl', location),
    credentialsFile:
      table.credentialsFile === undefined
        ? defaultCredentialsFile
        : normalizePath(expectString(table.credentialsFile, 'grafana.credentialsFile', location)),
    timeoutSeconds,
    datasourceUid: datasource(table.datasourceUid, 'grafana.datasourceUid', location),
    metricsDatasourceUid: datasource(table.metricsDatasourceUid, 'grafana.metricsDatasourceUid', location),
  };
}

export function legacyKubernetes(raw: unknown, name: string, path: string): KubernetesAccess | null {
  const location = `профиле ${name} (${path})`;
  const table = expectTable(raw, 'kubernetes', location);
  if (table === null) return null;
  return {
    kubeconfig:
      table.kubeconfig === undefined
        ? null
        : normalizePath(expectString(table.kubeconfig, 'kubernetes.kubeconfig', location)),
    context: table.context === undefined ? null : expectString(table.context, 'kubernetes.context', location),
  };
}
