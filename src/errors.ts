export const ERROR_CLASSES = [
  'credentials_missing',
  'credentials_incomplete',
  'auth_failed',
  'datasource_list_forbidden',
  'datasource_not_found',
  'timeout_client',
  'upstream_error',
  'metrics_query_rejected',
  'stream_aborted',
  'bad_request',
  'config_invalid',
  'config_exists',
  'profile_missing',
  'profile_ambiguous',
  'profile_incomplete',
  'namespace_out_of_scope',
  'token_invalid',
  'kubeconfig_missing',
  'kubeconfig_ambiguous',
  'kubeconfig_invalid',
  'kube_context_missing',
  'k8s_access_forbidden',
  'k8s_resource_not_found',
  'k8s_resource_ambiguous',
  'k8s_upstream_error',
  'pod_not_found',
  'previous_log_unavailable',
  'git_unavailable',
  'skill_copy_skipped',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export class ToolError extends Error {
  readonly errorClass: ErrorClass;
  readonly partialPayload?: unknown;
  readonly echo: Record<string, unknown>;

  constructor(
    errorClass: ErrorClass,
    message: string,
    partialPayload?: unknown,
    echo: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
    this.errorClass = errorClass;
    this.partialPayload = partialPayload;
    this.echo = echo;
  }

  withEcho(patch: Record<string, unknown>): ToolError {
    return new ToolError(this.errorClass, this.message, this.partialPayload, {
      ...this.echo,
      ...patch,
    });
  }
}

export const INCOMPLETENESS_REASONS = {
  truncatedByLimit: 'записей пришло ровно столько, сколько лимит — за лимитом могут быть ещё',
  unparsableLines: 'часть строк ответа не разобрана',
  unknownEnvironment: 'для части записей namespace не определён: они помечены `unknown`',
  namespaceCatalogUnavailable: 'список namespace из хранилища получить не удалось',
  fieldValuesTruncated: 'значений пришло ровно столько, сколько лимит — могут быть ещё',
  streamAborted: 'получение данных прервано: в ответе только успевшая часть',
  bodyMissing: 'сервер вернул ответ без тела — это не то же самое, что «ничего не найдено»',
  commandFailed: 'команда не отработала: данные не получены',
  commandInterrupted: 'команда прервана: в ответе только записи, успевшие прийти до обрыва',
  k8sCommandFailed: 'команда Kubernetes не отработала: запрошенные данные не получены',
  discoveryIncomplete:
    'состав кластера прочитан не полностью: часть групп API недоступна, их ресурсы в поиске вида не участвовали',
  historyEmpty:
    'ревизий ReplicaSet не найдено: история выкаток недоступна — это не то же самое, что отсутствие выкаток',
  imageTagWithoutSha: 'тег не содержит полного SHA: коммит по такому образу не определяется',
  repositoryNotFound: 'локальный репозиторий не найден: коммит и ветки по нему не определялись',
  commitNotLocal:
    'коммит отсутствует локально: возможно, локальные ссылки устарели, а git fetch инструмент не выполняет',
  outOfScopeDropped:
    'часть записей не попала в ответ: их namespace вне области видимости профиля — это не то же самое, что отсутствие событий',
  skillCopySkipped: 'часть копий скилла не поставлена: причины по каждой копии в data.skipped',
  serverPartial: 'сервер пометил ответ частичным (isPartial)',
  serverWarnings: 'сервер вернул предупреждения: тексты — в summary.server.warnings',
  seriesOutOfScope:
    'часть рядов не попала в ответ: их namespace вне области видимости профиля — это не то же самое, что отсутствие данных',
  seriesWithoutNamespace:
    'ряды без метки namespace не показаны: их принадлежность области не проверить — группировка by (namespace) в выражении даст проверяемые ряды',
  labelValuesOutOfScope:
    'часть значений метки namespace не попала в ответ: они вне области видимости профиля — это не то же самое, что отсутствие данных',
  labelValuesHiddenByScope:
    'значения метки не показаны: при заданной области их принадлежность namespace не определяется — metrics series показывает значения вместе с namespace',
  responseShapeHiddenByScope:
    'ответ сервера неожиданного вида показан не целиком: при заданной области принадлежность namespace его частей не проверить',
} as const;

export type IncompletenessKey = keyof typeof INCOMPLETENESS_REASONS;
