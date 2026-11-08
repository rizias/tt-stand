import { ToolError } from '../errors.ts';
import { K8sHttpError } from './session.ts';

function previousLogUnavailable(message: string, previous: boolean | undefined, status: number): boolean {
  const previousLog = /previous terminated container|previous.*log|предыдущ.*(?:контейнер|лог)/iu.test(message);
  const unavailable = /not found|not available|не найден|недоступ/iu.test(message);
  return previous === true && status === 400 && previousLog && unavailable;
}

export function classifyK8sError(cause: unknown, options: { podName?: string; previous?: boolean } = {}): ToolError {
  if (cause instanceof ToolError) return cause;
  if (!(cause instanceof K8sHttpError)) {
    return new ToolError('k8s_upstream_error', 'Обращение к Kubernetes завершилось ошибкой.');
  }
  let message = cause.body;
  try {
    const parsed = JSON.parse(cause.body) as { message?: unknown };
    message = typeof parsed.message === 'string' ? parsed.message : cause.body;
  } catch {}
  if (previousLogUnavailable(message, options.previous, cause.status)) {
    return new ToolError(
      'previous_log_unavailable',
      `Лог предыдущего запуска пода «${options.podName ?? ''}» больше недоступен. ` +
        `Kubernetes ответил HTTP ${cause.status}.`,
      { pod: options.podName ?? null, previous: true, logAvailable: false },
    );
  }
  if (cause.status === 403) {
    return new ToolError('k8s_access_forbidden', `Нет доступа к ресурсу Kubernetes. HTTP ${cause.status}.`);
  }
  if (cause.status === 404 && options.podName) {
    return new ToolError('pod_not_found', `Под «${options.podName}» не найден. HTTP ${cause.status}.`);
  }
  if (cause.status === 404) {
    return new ToolError('k8s_resource_not_found', `Ресурс Kubernetes не найден. HTTP ${cause.status}.`);
  }
  return new ToolError('k8s_upstream_error', cause.message);
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
