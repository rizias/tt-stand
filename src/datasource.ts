import { ToolError } from './errors.ts';
import { bodyDescription, type BodyRead, type GrafanaTransport, type SentRequest } from './grafanaTransport.ts';

export const LOGS_DATASOURCE_TYPES = ['victoriametrics-logs-datasource'] as const;
export const METRICS_DATASOURCE_TYPES = [
  'prometheus',
  'victoriametrics-metrics-datasource',
  'victoriametrics-datasource',
] as const;

export interface DatasourceCandidate {
  uid: string;
  name: string;
  type: string;
}

export interface Datasource {
  uid: string;
  name: string;
  type: string | null;
  candidates: DatasourceCandidate[];
}

function typesText(types: readonly string[]): string {
  return types.length === 1 ? `с типом ${types[0]}` : `с типом из перечня: ${types.join(', ')}`;
}

async function requestDatasourceList(
  transport: GrafanaTransport,
  settingName: string,
): Promise<SentRequest> {
  try {
    return await transport.sendOk('GET', `${transport.baseUrl}/api/datasources`, null);
  } catch (cause) {
    if (cause instanceof ToolError && cause.errorClass === 'datasource_list_forbidden') {
      throw new ToolError(
        cause.errorClass,
        `${cause.message} Укажите источник явно: ${settingName} в файле конфигурации.`,
      );
    }
    throw cause;
  }
}

function parseDatasourceList(
  sent: SentRequest,
  transport: GrafanaTransport,
): Promise<{ value: unknown; body: BodyRead }> {
  return transport.readJsonBody(sent.response, sent.signal, 'Список источников данных');
}

function uidProblem(uid: unknown): string | null {
  if (uid === undefined) return 'поле uid отсутствует';
  if (typeof uid !== 'string') return `поле uid не строка: ${JSON.stringify(uid)}`;
  if (uid.length === 0) return 'поле uid — пустая строка';
  if (uid === '.' || uid === '..') return `поле uid равно «${uid}»`;
  return null;
}

export async function resolveDatasource(
  transport: GrafanaTransport,
  explicitUid: string | null,
  types: readonly string[],
  settingName: string,
): Promise<Datasource> {
  if (explicitUid) {
    return { uid: explicitUid, name: 'задан в конфигурации', type: null, candidates: [] };
  }

  const sent = await requestDatasourceList(transport, settingName);
  let parsed: { value: unknown; body: BodyRead };
  try {
    parsed = await parseDatasourceList(sent, transport);
  } finally {
    sent.done();
  }

  const list = parsed.value;
  if (!Array.isArray(list)) {
    throw new ToolError(
      'upstream_error',
      `Список источников данных пришёл не массивом: ${bodyDescription(parsed.body)}`,
    );
  }

  const candidates = (list as Array<{ uid: string; name: string; type: string }>)
    .filter((item) => types.includes(item?.type))
    .map((item) => ({ uid: item.uid, name: item.name, type: item.type }));

  if (candidates.length === 0) {
    throw new ToolError(
      'datasource_not_found',
      `Среди источников данных Grafana нет ни одного ${typesText(types)}. Укажите источник явно: ${settingName} в файле конфигурации.`,
    );
  }

  const chosen = candidates[0] as DatasourceCandidate;
  const problem = uidProblem(chosen.uid);
  if (problem !== null) {
    throw new ToolError(
      'upstream_error',
      `Grafana вернула источник данных ${String(chosen.name)} (${String(chosen.type)}), у которого ${problem}: ` +
        `такое значение нельзя передать сегментом пути /api/datasources/proxy/uid/<uid>/. ` +
        `Задайте источник явно: ${settingName} в файле конфигурации.`,
    );
  }
  return { uid: chosen.uid, name: chosen.name, type: chosen.type, candidates };
}
