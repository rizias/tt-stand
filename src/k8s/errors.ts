import { ToolError } from '../errors.ts';
import { K8sHttpError } from './session.ts';

export function classifyK8sError(
  cause: unknown,
  options: { podName?: string; previous?: boolean } = {},
): ToolError {
  if (cause instanceof ToolError) return cause;
  if (!(cause instanceof K8sHttpError)) {
    return new ToolError('k8s_upstream_error', (cause as Error).message);
  }
  let message = cause.body;
  try {
    const parsed = JSON.parse(cause.body) as { message?: string };
    message = parsed.message ?? cause.body;
  } catch {}
  if (
    options.previous &&
    cause.status === 400 &&
    /previous|terminated|not found|не найден/iu.test(message)
  ) {
    return new ToolError(
      'previous_log_unavailable',
      `Лог предыдущего запуска пода «${options.podName ?? ''}» больше недоступен: ${message}`,
      { pod: options.podName ?? null, previous: true, logAvailable: false },
    );
  }
  if (cause.status === 403) {
    return new ToolError('k8s_access_forbidden', `Нет доступа к ресурсу Kubernetes: ${message}`);
  }
  if (cause.status === 404 && options.podName) {
    return new ToolError('pod_not_found', `Под «${options.podName}» не найден: ${message}`);
  }
  if (cause.status === 404) {
    return new ToolError('k8s_resource_not_found', `Ресурс Kubernetes не найден: ${message}`);
  }
  return new ToolError(
    'k8s_upstream_error',
    `Kubernetes ответил ${cause.status} ${cause.statusText}: ${message}`,
  );
}

export type K8sCommand =
  | { action: 'get'; resource: string; namespace: string | null; name: string | null }
  | {
      action: 'log';
      pod: string;
      namespace: string | null;
      container: string | null;
      previous: boolean;
    }
  | { action: 'events'; namespace: string | null }
  | { action: 'pods'; namespace: string | null }
  | { action: 'history'; workload: string; namespace: string | null };
