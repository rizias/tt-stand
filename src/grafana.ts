import type { Credentials } from './credentials.ts';
import type { Datasource } from './datasource.ts';
import { ToolError } from './errors.ts';
import { bodyDescription, GrafanaTransport } from './grafanaTransport.ts';

export type { Datasource } from './datasource.ts';

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

function fieldValue(item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  return { value: String(item.value ?? ''), hits: Number(item.hits ?? 0) };
}

export function fieldValueNames(values: unknown[]): string[] {
  return values.flatMap((item) => {
    if (typeof item === 'string') return [item];
    return isPlainObject(item) ? [String(item.value)] : [];
  });
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

export class GrafanaClient {
  private readonly transport: GrafanaTransport;
  private readonly baseUrl: string;

  constructor(options: GrafanaClientOptions) {
    this.transport = new GrafanaTransport(options);
    this.baseUrl = options.credentials.baseUrl;
  }

  get httpTransport(): GrafanaTransport {
    return this.transport;
  }

  private endpoint(datasource: Datasource, path: string): string {
    return `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasource.uid)}/${path}`;
  }

  static describeRequest(path: string, params: URLSearchParams): string {
    return `POST /${path} ${params.toString()}`;
  }

  async queryLogs(
    datasource: Datasource,
    params: URLSearchParams,
    userLimit: number | null,
  ): Promise<StreamResult> {
    const sent = await this.transport.sendOk(
      'POST',
      this.endpoint(datasource, 'select/logsql/query'),
      params,
    );
    try {
      return await this.consumeNdjson(sent.response, userLimit, sent.signal);
    } finally {
      sent.done();
    }
  }

  async fieldValues(
    datasource: Datasource,
    params: URLSearchParams,
  ): Promise<{ values: unknown[]; raw: unknown }> {
    const sent = await this.transport.sendOk(
      'POST',
      this.endpoint(datasource, 'select/logsql/field_values'),
      params,
    );
    try {
      const parsed = await this.transport.readJsonBody(
        sent.response,
        sent.signal,
        'Ответ field_values',
      );
      const body = parsed.value as { values?: unknown } | null;
      if (!Array.isArray(body?.values)) {
        throw new ToolError(
          'upstream_error',
          `Ответ field_values не содержит перечня значений: это отказ источника, а не пустой результат. Тело ответа: ${bodyDescription(parsed.body)}`,
        );
      }
      return { values: body.values.map(fieldValue), raw: body };
    } finally {
      sent.done();
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
      if (signal.aborted) {
        throw new ToolError(
          'timeout_client',
          `Ответ не получен целиком за ${this.transport.timeoutSeconds} с — сработал таймаут самого tt-stand (grafana.timeoutSeconds), не сервера.`,
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
