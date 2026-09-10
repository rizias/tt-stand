import { type ErrorClass, INCOMPLETENESS_REASONS, type IncompletenessKey } from './errors.ts';

export interface Echo {
  command: string;
  query: string | null;
  request: string | null;
  start: string | null;
  end: string | null;
  limit: number | null;
  limitNote: string;
  datasource: string | null;
  datasourceNote: string | null;
  recordsReturned: number;
  hitLimit: boolean;
  unparsableLines: number;
  order: string;
  unavailableSources: string[];
  valueVariantsGenerated: string;
  identifierPivotPerformed: string;
  kubeconfig?: string;
  kubeconfigSource?: string;
  context?: string;
  cluster?: string;
  defaultNamespace?: string;
  namespace?: string | null;
  resource?: string;
  requestedResource?: string;
  name?: string | null;
  container?: string | null;
  previous?: boolean;
  discoveryCandidates?: string[];
  repositoryRoots?: string[];
  repository?: string | null;
  refsUpdatedAt?: string | null;
  fetchPerformed?: string;
  refsUpdatedAtNote?: string;
  profile?: string;
  namespaceScope?: string[] | null;
  recordsOutOfScope?: number;
  contextSource?: 'profile' | 'kubeconfig';
}

export const ECHO_CONSTANTS = {
  valueVariants: 'варианты написания искомого значения не порождались — искали ровно переданное',
  identifierPivot: 'разворот «значение → идентификатор» инструментом не выполнялся',
  order: 'порядок записей — как отдал сервер; инструмент их не переставляет',
  noLimit: 'лимит не задавался — инструмент своего лимита не подставляет',
} as const;

export interface ToolResponse {
  ok: boolean;
  command: string;
  data: unknown;
  summary: unknown;
  echo: Echo;
  incomplete: boolean;
  incompleteReasons: string[];
  errorClass: ErrorClass | null;
  error: string | null;
}

export class ResponseBuilder {
  private readonly reasons = new Set<IncompletenessKey>();

  addReason(key: IncompletenessKey): void {
    this.reasons.add(key);
  }

  get incomplete(): boolean {
    return this.reasons.size > 0;
  }

  get reasonTexts(): string[] {
    return [...this.reasons].map((key) => INCOMPLETENESS_REASONS[key]);
  }
}

export function localEcho(command: string): Echo {
  return {
    command,
    query: null,
    request: null,
    start: null,
    end: null,
    limit: null,
    limitNote: 'запрос к хранилищу не выполнялся',
    datasource: null,
    datasourceNote: null,
    recordsReturned: 0,
    hitLimit: false,
    unparsableLines: 0,
    order: 'не применимо',
    unavailableSources: [],
    valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
    identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
  };
}

export function renderJson(response: ToolResponse): string {
  return JSON.stringify(response, null, 2);
}

function environmentLines(summary: unknown): string[] {
  if (!summary || typeof summary !== 'object') return [];
  const shape = summary as Record<string, unknown>;
  const byEnvironment = shape.byEnvironment as Record<string, number> | undefined;
  if (!byEnvironment || Object.keys(byEnvironment).length === 0) return [];

  const lines = ['Окружения:'];
  for (const [environment, count] of Object.entries(byEnvironment)) {
    lines.push(`  ${environment}: ${count}`);
  }
  const unknownValues = shape.unknownValues as string[] | undefined;
  if (unknownValues && unknownValues.length > 0) {
    lines.push(`  исходные значения с окружением unknown: ${unknownValues.join(', ')}`);
  }
  lines.push('');
  return lines;
}

function recordLines(item: unknown): string[] {
  const row = item as Record<string, unknown>;
  const record = (row.record ?? row) as Record<string, unknown>;
  const environment = row.environment;
  const lines = [environment === undefined ? '---' : `--- [${environment}]`];
  for (const [field, value] of Object.entries(record)) {
    lines.push(`  ${field}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  if ('http' in row) {
    lines.push(`  http: ${row.http === null ? 'null' : JSON.stringify(row.http)}`);
  }
  return lines;
}

function dataLines(data: unknown): string[] {
  if (Array.isArray(data)) {
    const lines = data.flatMap(recordLines);
    if (data.length === 0) lines.push('Записей не найдено.');
    lines.push('');
    return lines;
  }
  if (data === null || data === undefined) return [];
  return [JSON.stringify(data, null, 2), ''];
}

function echoLines(echo: Echo): string[] {
  const shape = echo as unknown as Record<string, unknown>;
  const lines = ['Что фактически выполнено:'];
  for (const [key, label] of ECHO_LABELS) {
    const value = shape[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`  ${label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  return lines;
}

export function renderHuman(response: ToolResponse): string {
  const lines: string[] = [];

  if (!response.ok) {
    lines.push(`ОШИБКА [${response.errorClass}]: ${response.error}`, '');
  }

  lines.push(...environmentLines(response.summary));
  lines.push(...dataLines(response.data));
  lines.push(...echoLines(response.echo));
  lines.push('', `Результат полон: ${response.incomplete ? 'нет' : 'да'}`);
  for (const reason of response.incompleteReasons) lines.push(`  — ${reason}`);

  return lines.join('\n');
}

const ECHO_LABELS: Array<[string, string]> = [
  ['command', 'команда'],
  ['query', 'выражение запроса'],
  ['request', 'запрос'],
  ['start', 'начало периода'],
  ['end', 'конец периода'],
  ['limit', 'лимит'],
  ['limitNote', 'о лимите'],
  ['datasource', 'источник данных'],
  ['datasourceNote', 'об источнике'],
  ['recordsReturned', 'возвращено записей'],
  ['hitLimit', 'упёрлось в лимит'],
  ['unparsableLines', 'нечитаемых строк'],
  ['order', 'порядок'],
  ['unavailableSources', 'недоступные источники'],
  ['valueVariantsGenerated', 'варианты значения'],
  ['identifierPivotPerformed', 'разворот'],
  ['kubeconfig', 'kubeconfig'],
  ['kubeconfigSource', 'источник kubeconfig'],
  ['context', 'контекст Kubernetes'],
  ['cluster', 'кластер Kubernetes'],
  ['defaultNamespace', 'namespace контекста'],
  ['namespace', 'namespace запроса'],
  ['resource', 'ресурс Kubernetes'],
  ['requestedResource', 'запрошенное имя ресурса'],
  ['name', 'имя объекта'],
  ['container', 'контейнер'],
  ['previous', 'предыдущий запуск'],
  ['discoveryCandidates', 'кандидаты discovery'],
  ['resourceVersion', 'версия ресурса'],
  ['discoveryVersions', 'объявленные версии'],
  ['journal', 'запись журнала'],
  ['journalRun', 'метка расследования'],
  ['repositoryRoots', 'каталоги репозиториев'],
  ['repository', 'репозиторий'],
  ['refsUpdatedAt', 'ссылки обновлялись'],
  ['fetchPerformed', 'о fetch'],
  ['refsUpdatedAtNote', 'о времени ссылок'],
  ['profile', 'профиль'],
  ['namespaceScope', 'область видимости'],
  ['recordsOutOfScope', 'записей вне области'],
  ['contextSource', 'источник контекста'],
];
