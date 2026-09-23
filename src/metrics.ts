import type { Datasource } from './datasource.ts';
import { ToolError } from './errors.ts';
import { bodyDescription, type BodyRead, type GrafanaTransport } from './grafanaTransport.ts';

export interface MetricsEnvelope {
  status: 'success' | 'error';
  data: unknown;
  errorType?: string;
  error?: string;
  warnings?: string[];
  isPartial?: boolean;
  [key: string]: unknown;
}

export interface MetricsCall {
  envelope: MetricsEnvelope;
  request: string;
}

function endpointUrl(baseUrl: string, datasource: Datasource, path: string): string {
  return `${baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasource.uid)}/${path}`;
}

function parseBody(body: BodyRead): unknown {
  if (body.text === null || body.text.length === 0) return null;
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    return null;
  }
}

function isErrorEnvelope(value: unknown): value is MetricsEnvelope {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as MetricsEnvelope).status === 'error'
  );
}

function isSuccessEnvelope(value: unknown): value is MetricsEnvelope {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as MetricsEnvelope).status === 'success'
  );
}

function fieldText(value: unknown): string {
  if (value === undefined) return 'отсутствует';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function exchange(
  transport: GrafanaTransport,
  url: string,
  method: 'GET' | 'POST',
  params: URLSearchParams,
): Promise<MetricsEnvelope> {
  const sent = await transport.send(method, url, method === 'GET' ? null : params);
  let body: BodyRead;
  try {
    body = await transport.readBody(sent.response, sent.signal);
  } finally {
    sent.done();
  }

  if (sent.response.status === 401 || sent.response.status === 403) {
    throw transport.statusError(sent.response, url, body);
  }

  const parsed = parseBody(body);

  if (isErrorEnvelope(parsed)) {
    throw new ToolError(
      'metrics_query_rejected',
      `Сервер метрик отклонил запрос: HTTP ${sent.response.status}, errorType: ${fieldText(parsed.errorType)}, error: ${fieldText(parsed.error)}; тело ответа: ${bodyDescription(body)}`,
    );
  }

  if (!sent.response.ok) {
    throw transport.statusError(sent.response, url, body);
  }

  if (!isSuccessEnvelope(parsed)) {
    throw new ToolError(
      'upstream_error',
      `Ответ сервера метрик не разобран как конверт API Prometheus: ${bodyDescription(body)}`,
    );
  }

  return parsed;
}

function describeRequest(method: 'GET' | 'POST', path: string, params: URLSearchParams): string {
  const query = params.toString();
  if (method === 'GET') {
    return query.length > 0 ? `GET /${path}?${query}` : `GET /${path}`;
  }
  return query.length > 0 ? `POST /${path} ${query}` : `POST /${path}`;
}

export async function callMetrics(
  transport: GrafanaTransport,
  baseUrl: string,
  datasource: Datasource,
  method: 'GET' | 'POST',
  path: string,
  params: URLSearchParams,
): Promise<MetricsCall> {
  const query = params.toString();
  const url =
    method === 'GET' && query.length > 0
      ? `${endpointUrl(baseUrl, datasource, path)}?${query}`
      : endpointUrl(baseUrl, datasource, path);
  const request = describeRequest(method, path, params);
  try {
    return { envelope: await exchange(transport, url, method, params), request };
  } catch (cause) {
    if (cause instanceof ToolError) throw cause.withEcho({ request });
    throw cause;
  }
}
