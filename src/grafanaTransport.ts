import type { Credentials } from './credentials.ts';
import { ToolError } from './errors.ts';

export interface GrafanaTransportOptions {
  credentials: Credentials;
  timeoutSeconds: number | null;
}

export interface SentRequest {
  response: Response;
  signal: AbortSignal;
  done: () => void;
}

export interface BodyRead {
  text: string | null;
  readError: string | null;
}

export function bodyDescription(body: BodyRead): string {
  if (body.readError !== null) return `тело ответа не прочитано: ${body.readError}`;
  if (body.text === null || body.text.length === 0) return 'тело ответа пустое';
  return body.text;
}

export class GrafanaTransport {
  private readonly credentials: Credentials;
  private readonly timeoutMs: number | null;

  constructor(options: GrafanaTransportOptions) {
    this.credentials = options.credentials;
    this.timeoutMs =
      options.timeoutSeconds === null ? null : Math.round(options.timeoutSeconds * 1000);
  }

  get baseUrl(): string {
    return this.credentials.baseUrl;
  }

  get timeoutSeconds(): number | null {
    return this.timeoutMs === null ? null : this.timeoutMs / 1000;
  }

  private authHeader(): string {
    if (this.credentials.kind === 'basic') {
      const raw = `${this.credentials.login}:${this.credentials.password}`;
      return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    }
    return `Bearer ${this.credentials.token}`;
  }

  async send(
    method: 'GET' | 'POST',
    url: string,
    body: URLSearchParams | null,
  ): Promise<SentRequest> {
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
        method,
        headers,
        body: body === null ? undefined : body.toString(),
        signal: controller.signal,
      });
    } catch (cause) {
      done();
      throw this.transportError(cause, controller.signal);
    }
    return { response, signal: controller.signal, done };
  }

  async sendOk(
    method: 'GET' | 'POST',
    url: string,
    body: URLSearchParams | null,
  ): Promise<SentRequest> {
    const sent = await this.send(method, url, body);
    if (sent.response.ok) return sent;
    const read = await this.readBody(sent.response, sent.signal);
    sent.done();
    throw this.statusError(sent.response, url, read);
  }

  async readBody(response: Response, signal: AbortSignal): Promise<BodyRead> {
    try {
      return { text: await response.text(), readError: null };
    } catch (cause) {
      if (signal.aborted) throw this.transportError(cause, signal);
      return { text: null, readError: (cause as Error).message };
    }
  }

  async readJsonBody(
    response: Response,
    signal: AbortSignal,
    what: string,
  ): Promise<{ value: unknown; body: BodyRead }> {
    const body = await this.readBody(response, signal);
    if (body.readError !== null) {
      throw new ToolError('upstream_error', `${what} не разобран: ${bodyDescription(body)}`);
    }
    try {
      return { value: JSON.parse(body.text as string) as unknown, body };
    } catch {
      throw new ToolError('upstream_error', `${what} не разобран: ${bodyDescription(body)}`);
    }
  }

  transportError(cause: unknown, signal: AbortSignal): ToolError {
    if (signal.aborted) {
      return new ToolError(
        'timeout_client',
        `Ответ не получен за ${(this.timeoutMs as number) / 1000} с — сработал таймаут самого tt-stand (grafana.timeoutSeconds), не сервера.`,
      );
    }
    return new ToolError('upstream_error', `Запрос не выполнен: ${(cause as Error).message}`);
  }

  statusError(response: Response, url: string, body: BodyRead): ToolError {
    const description = bodyDescription(body);
    if (response.status === 403 && url.endsWith('/api/datasources')) {
      return new ToolError(
        'datasource_list_forbidden',
        `Список источников данных недоступен этой учётной записи (403): ${description}.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      return new ToolError(
        'auth_failed',
        `Сервер ответил кодом ${response.status} ${response.statusText}: ${description}`,
      );
    }
    return new ToolError(
      'upstream_error',
      `Сервер ответил кодом ${response.status} ${response.statusText}: ${description}`,
    );
  }
}
