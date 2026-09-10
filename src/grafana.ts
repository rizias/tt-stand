import type { Credentials } from './credentials.ts';
import { ToolError } from './errors.ts';

export const LOGS_DATASOURCE_TYPE = 'victoriametrics-logs-datasource';

export interface Datasource {
  uid: string;
  name: string;
  candidates: string[];
}

export interface GrafanaClientOptions {
  credentials: Credentials;
  timeoutSeconds: number | null;
}

export interface LogRecord {
  [field: string]: unknown;
}

export interface StreamResult {
  records: LogRecord[];
  unparsableLines: number;
  hitLimit: boolean;
  aborted: boolean;
  abortReason: string | null;
  bodyMissing: boolean;
}

function statusError(response: Response, url: string): ToolError {
  const isDatasourceList = url.endsWith('/api/datasources');
  if (response.status === 403 && isDatasourceList) {
    return new ToolError(
      'datasource_list_forbidden',
      'Список источников данных недоступен этой учётной записи (403). Укажите источник явно: grafana.datasourceUid в файле конфигурации.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ToolError('auth_failed', `Grafana отклонила запрос с кодом ${response.status}.`);
  }
  return new ToolError(
    'upstream_error',
    `Сервер ответил кодом ${response.status} ${response.statusText}.`,
  );
}

export class GrafanaClient {
  private readonly credentials: Credentials;
  private readonly timeoutMs: number | null;

  constructor(options: GrafanaClientOptions) {
    this.credentials = options.credentials;
    this.timeoutMs =
      options.timeoutSeconds === null ? null : Math.round(options.timeoutSeconds * 1000);
  }

  private authHeader(): string {
    if (this.credentials.kind === 'basic') {
      const raw = `${this.credentials.login}:${this.credentials.password}`;
      return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    }
    return `Bearer ${this.credentials.token}`;
  }

  private async send(
    url: string,
    body: URLSearchParams | null,
  ): Promise<{ response: Response; done: () => void; signal: AbortSignal }> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs === null ? null : setTimeout(() => controller.abort(), this.timeoutMs);
    const done = (): void => {
      if (timer !== null) clearTimeout(timer);
    };

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: '*/*',
    };
    if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    let response: Response;
    try {
      response = await fetch(url, {
        method: body === null ? 'GET' : 'POST',
        headers,
        body: body === null ? undefined : body.toString(),
        signal: controller.signal,
      });
    } catch (cause) {
      done();
      throw this.transportError(cause, controller.signal);
    }

    if (!response.ok) {
      done();
      throw statusError(response, url);
    }
    return { response, done, signal: controller.signal };
  }

  private transportError(cause: unknown, signal: AbortSignal): ToolError {
    if (signal.aborted) {
      return new ToolError(
        'timeout_client',
        `Ответ не получен за ${(this.timeoutMs as number) / 1000} с — сработал таймаут самого tt-stand (grafana.timeoutSeconds), не сервера.`,
      );
    }
    return new ToolError('upstream_error', `Запрос не выполнен: ${(cause as Error).message}`);
  }

  async resolveDatasource(explicitUid: string | null): Promise<Datasource> {
    if (explicitUid) return { uid: explicitUid, name: 'задан в конфигурации', candidates: [] };

    const { response, done, signal } = await this.send(
      `${this.credentials.baseUrl}/api/datasources`,
      null,
    );
    let list: unknown;
    try {
      list = await this.readJson(response, signal, 'Список источников данных');
    } finally {
      done();
    }

    if (!Array.isArray(list)) {
      throw new ToolError('upstream_error', 'Список источников данных пришёл не массивом.');
    }

    const candidates = (list as Array<{ uid: string; name: string; type: string }>).filter(
      (item) => item?.type === LOGS_DATASOURCE_TYPE,
    );
    if (candidates.length === 0) {
      throw new ToolError(
        'datasource_not_found',
        `Среди источников данных Grafana нет ни одного с типом ${LOGS_DATASOURCE_TYPE}.`,
      );
    }

    const chosen = candidates[0] as { uid: string; name: string };
    return {
      uid: chosen.uid,
      name: chosen.name,
      candidates: candidates.map((item) => item.name),
    };
  }

  private endpoint(datasource: Datasource, path: string): string {
    return `${this.credentials.baseUrl}/api/datasources/proxy/uid/${datasource.uid}/${path}`;
  }

  static describeRequest(path: string, params: URLSearchParams): string {
    return `POST /${path} ${params.toString()}`;
  }

  async queryLogs(
    datasource: Datasource,
    params: URLSearchParams,
    userLimit: number | null,
  ): Promise<StreamResult> {
    const { response, done, signal } = await this.send(
      this.endpoint(datasource, 'select/logsql/query'),
      params,
    );
    try {
      return await this.consumeNdjson(response, userLimit, signal);
    } finally {
      done();
    }
  }

  async fieldValues(
    datasource: Datasource,
    params: URLSearchParams,
  ): Promise<{ values: Array<{ value: string; hits: number }>; raw: unknown }> {
    const { response, done, signal } = await this.send(
      this.endpoint(datasource, 'select/logsql/field_values'),
      params,
    );
    try {
      const body = (await this.readJson(response, signal, 'Ответ field_values')) as {
        values?: Array<{ value?: string; hits?: number }>;
      };
      if (!Array.isArray(body?.values)) {
        throw new ToolError(
          'upstream_error',
          'Ответ field_values не содержит перечня значений: это отказ источника, а не пустой результат.',
        );
      }
      const values = body.values.map((item) => ({
        value: String(item.value ?? ''),
        hits: Number(item.hits ?? 0),
      }));
      return { values, raw: body };
    } finally {
      done();
    }
  }

  private async readJson(response: Response, signal: AbortSignal, what: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      if (signal.aborted) throw this.transportError(cause, signal);
      throw new ToolError('upstream_error', `${what} не разобран: ${(cause as Error).message}`);
    }
  }

  private async consumeNdjson(
    response: Response,
    userLimit: number | null,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const records: LogRecord[] = [];
    let unparsableLines = 0;
    let aborted = false;
    let abortReason: string | null = null;

    if (!response.body) {
      return {
        records,
        unparsableLines,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: true,
      };
    }

    const decoder = new TextDecoder('utf8');
    let buffer = '';

    const take = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        records.push(JSON.parse(trimmed) as LogRecord);
      } catch {
        unparsableLines += 1;
      }
    };

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          take(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) take(buffer);
    } catch (cause) {
      if (signal.aborted && this.timeoutMs !== null) {
        throw new ToolError(
          'timeout_client',
          `Ответ не получен целиком за ${this.timeoutMs / 1000} с — сработал таймаут самого tt-stand (grafana.timeoutSeconds), не сервера.`,
          { records, unparsableLines },
        );
      }
      aborted = true;
      abortReason = (cause as Error).message;
    }

    return {
      records,
      unparsableLines,
      hitLimit: userLimit !== null && records.length >= userLimit,
      aborted,
      abortReason,
      bodyMissing: false,
    };
  }
}
