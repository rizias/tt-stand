import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ToolError } from '../errors.ts';
import { normalizePath } from '../paths.ts';
import { renderJson, type ToolResponse } from '../response.ts';
import type { PreparedBatch } from './plan.ts';

export interface StoredResponse {
  id: string;
  why: string;
  originalArgv: string[];
  invocation: string[];
  responseFile: string;
  ok: boolean;
  incomplete: boolean;
  incompleteReasons: string[];
  errorClass: ToolResponse['errorClass'];
  error: string | null;
  operationMs: number;
  contextWaitMs: number;
  writeMs: number;
  responseBytes: number;
}

export class BatchFiles {
  readonly directory: string;
  readonly planFile: string;
  readonly traceFile: string;

  constructor(out: string, batch: PreparedBatch, profile: string, startedAt: string) {
    this.directory = resolve(normalizePath(out));
    try {
      mkdirSync(this.directory, { recursive: true });
      if (readdirSync(this.directory).length !== 0) {
        throw new ToolError('bad_request', `Каталог результата должен быть новым или пустым: ${this.directory}`);
      }
      mkdirSync(join(this.directory, 'responses'));
    } catch (cause) {
      if (cause instanceof ToolError) throw cause;
      throw new ToolError('output_write_failed', `Каталог результата ${this.directory}: ${(cause as Error).message}`);
    }
    this.planFile = this.writeJson('plan.json', {
      version: 1,
      goal: batch.goal,
      sourceFile: batch.file,
      startedAt,
      profile,
      requests: batch.requests.map((item) => ({
        id: item.id,
        why: item.why,
        originalArgv: item.originalArgv,
        invocation: item.invocation,
      })),
    }).file;
    this.traceFile = join(this.directory, 'requests.ndjson');
  }

  writeJson(relative: string, value: unknown): { file: string; bytes: number } {
    const file = join(this.directory, relative);
    const data = JSON.stringify(value, null, 2) + '\n';
    try {
      writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' });
    } catch (cause) {
      throw new ToolError('output_write_failed', `Файл результата ${file} не записан: ${(cause as Error).message}`);
    }
    return { file, bytes: Buffer.byteLength(data, 'utf8') };
  }

  writeResponse(index: number, response: ToolResponse): { relative: string; bytes: number } {
    const relative = `responses/${String(index + 1).padStart(4, '0')}.json`;
    const data = renderJson(response) + '\n';
    try {
      writeFileSync(join(this.directory, relative), data, { encoding: 'utf8', flag: 'wx' });
    } catch (cause) {
      throw new ToolError('output_write_failed', `Ответ ${index + 1} не записан: ${(cause as Error).message}`);
    }
    return { relative, bytes: Buffer.byteLength(data, 'utf8') };
  }
}
