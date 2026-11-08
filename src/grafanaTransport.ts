import type { Credentials } from './credentials.ts';
import { ToolError } from './errors.ts';

export interface GrafanaTransportOptions {
  credentials: Credentials;
  timeoutSeconds: number | null;
  observer?: RequestObserver;
}

export interface RequestStart {
  at: string;
  method: 'GET' | 'POST';
  path: string;
}

export interface RequestEnd {
  durationMs: number;
  status: number | null;
  redirected: boolean;
  aborted: boolean;
  error: string | null;
}

export type RequestObserver = (start: RequestStart) => (end: RequestEnd) => void;

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
  private readonly observer: RequestObserver | undefined;

  constructor(options: GrafanaTransportOptions) {
    this.credentials = options.credentials;
    this.observer = options.observer;
    this.timeoutMs = options.timeoutSeconds === null ? null : Math.round(options.timeoutSeconds * 1000);
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

  async send(method: 'GET' | 'POST', url: string, body: URLSearchParams | null): Promise<SentRequest> {
    const started = performance.now();
    const notify = this.observe(method, url);
    const controller = new AbortController();
    let response: Response | null = null;
    let requestError: string | null = null;
    let finished = false;
    const timer = this.timeoutMs === null ? null : setTimeout(() => controller.abort(), this.timeoutMs);
    const done = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (finished) return;
      finished = true;
      notify?.({
        durationMs: performance.now() - started,
        status: response?.status ?? null,
        redirected: response?.redirected ?? false,
        aborted: controller.signal.aborted,
        error: requestError,
      });
    };

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: '*/*',
    };
    if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === null ? undefined : body.toString(),
        signal: controller.signal,
      });
    } catch (cause) {
      requestError = this.errorDescription(cause);
      done();
      throw this.transportError(cause, controller.signal);
    }
    return { response, signal: controller.signal, done };
  }

  private observe(method: 'GET' | 'POST', url: string): ReturnType<RequestObserver> | undefined {
    if (this.observer === undefined) return undefined;
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      path = 'неверный URL';
    }
    return this.observer({ at: new Date().toISOString(), method, path });
  }

  async sendOk(method: 'GET' | 'POST', url: string, body: URLSearchParams | null): Promise<SentRequest> {
    const sent = await this.send(method, url, body);
    if (sent.response.ok) return sent;
    let read: BodyRead;
    try {
      read = await this.readBody(sent.response, sent.signal);
    } finally {
      sent.done();
    }
    throw this.statusError(sent.response, url, read);
  }

  async readBody(response: Response, signal: AbortSignal): Promise<BodyRead> {
    try {
      return { text: await response.text(), readError: null };
    } catch (cause) {
      if (signal.aborted) throw this.transportError(cause, signal);
      return { text: null, readError: this.errorDescription(cause) };
    }
  }

  async readJsonBody(
    response: Response,
    signal: AbortSignal,
    what: string,
  ): Promise<{ value: unknown; body: BodyRead }> {
    const body = await this.readBody(response, signal);
    if (body.readError !== null) {
      throw new ToolError('upstream_error', `${what} не разобран: ${this.describeBody(body)}`);
    }
    try {
      return { value: JSON.parse(body.text as string) as unknown, body };
    } catch {
      throw new ToolError('upstream_error', `${what} не разобран: ${this.describeBody(body)}`);
    }
  }

  transportError(cause: unknown, signal: AbortSignal): ToolError {
    if (signal.aborted) {
      return new ToolError(
        'timeout_client',
        `Ответ не получен за ${(this.timeoutMs as number) / 1000} с — сработал таймаут самого tt-stand (grafana.timeoutSeconds), не сервера.`,
      );
    }
    return new ToolError('upstream_error', `Запрос не выполнен: ${this.errorDescription(cause)}`);
  }

  errorDescription(cause: unknown): string {
    return this.safeDiagnostic(cause);
  }

  describeBody(body: BodyRead): string {
    return this.safeDiagnostic(bodyDescription(body));
  }

  safeDiagnostic(value: unknown): string {
    let message: string;
    try {
      const raw = value instanceof Error ? value.message : value;
      message = typeof raw === 'string' ? raw : String(raw);
    } catch {
      message = 'Неизвестная ошибка подключения.';
    }
    const baseUrl = this.credentials.baseUrl;
    try {
      const parsed = new URL(baseUrl);
      if (
        parsed.username ||
        parsed.password ||
        (!['http:', 'https:'].includes(parsed.protocol) && baseUrl.includes('@'))
      ) {
        return 'Адрес Grafana содержит учётные данные или имеет неверный формат.';
      }
    } catch {
      if (baseUrl.includes('@')) return 'Адрес Grafana имеет неверный формат.';
    }
    const secrets =
      this.credentials.kind === 'basic'
        ? [
            this.credentials.login,
            this.credentials.password,
            Buffer.from(`${this.credentials.login}:${this.credentials.password}`, 'utf8').toString('base64'),
          ]
        : [this.credentials.token];
    if ([...secrets, this.authHeader()].some((secret) => secret.length > 0 && message.includes(secret))) {
      return 'Запрос к Grafana завершился ошибкой подключения.';
    }
    return message.replace(/(https?:\/\/)[^/?#\s]*@/giu, '$1');
  }

  statusError(response: Response, url: string, body: BodyRead): ToolError {
    const description = this.describeBody(body);
    const statusText = this.safeDiagnostic(response.statusText);
    if (response.status === 403 && url.endsWith('/api/datasources')) {
      return new ToolError(
        'datasource_list_forbidden',
        `Список источников данных недоступен этой учётной записи (403): ${description}.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      return new ToolError('auth_failed', `Сервер ответил кодом ${response.status} ${statusText}: ${description}`);
    }
    return new ToolError('upstream_error', `Сервер ответил кодом ${response.status} ${statusText}: ${description}`);
  }
}
