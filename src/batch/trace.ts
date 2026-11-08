import { closeSync, openSync, writeSync } from 'node:fs';
import { ToolError } from '../errors.ts';
import type { RequestObserver } from '../grafanaTransport.ts';

export class BatchTrace {
  private readonly descriptor: number;
  private readonly file: string;
  private activeId = 'setup';
  private closed = false;
  fetchAttempts = 0;

  constructor(file: string) {
    this.file = file;
    try {
      this.descriptor = openSync(file, 'wx');
    } catch (cause) {
      throw new ToolError('output_write_failed', `След обращений ${file} не создан: ${(cause as Error).message}`);
    }
  }

  select(id: string): void {
    this.activeId = id;
  }

  private append(value: unknown): void {
    try {
      writeSync(this.descriptor, JSON.stringify(value) + '\n', undefined, 'utf8');
    } catch (cause) {
      throw new ToolError('output_write_failed', `След обращений ${this.file} не записан: ${(cause as Error).message}`);
    }
  }

  readonly observer: RequestObserver = (start) => {
    const operationId = this.activeId;
    const attempt = this.fetchAttempts + 1;
    const phase = start.path === '/api/datasources' ? 'setup' : 'operation';
    this.append({ event: 'started', phase, operationId, attempt, ...start });
    this.fetchAttempts = attempt;
    return (end) => this.append({ event: 'finished', phase, operationId, attempt, ...end });
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.descriptor);
    } catch (cause) {
      throw new ToolError('output_write_failed', `След обращений ${this.file} не закрыт: ${(cause as Error).message}`);
    }
  }
}
