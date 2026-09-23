import { readFileSync } from 'node:fs';
import { ToolError } from './errors.ts';
import { normalizePath } from './paths.ts';

export function readQueryFile(path: string): string {
  const resolved = normalizePath(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    const reason = error.code === 'ENOENT' ? 'файл не найден' : error.message;
    throw new ToolError(
      'bad_request',
      `Файл выражения запроса не прочитан: ${resolved} (${reason}).`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(
      'bad_request',
      `Файл выражения запроса не прочитан: ${resolved} (файл не в кодировке UTF-8).`,
    );
  }
}

export interface ResolvedQuery {
  query: string | null;
  queryFile: string | null;
}

export function resolveQuery(
  query: string | undefined,
  queryFile: string | undefined,
): ResolvedQuery {
  if (query !== undefined && queryFile !== undefined) {
    throw new ToolError(
      'bad_request',
      `Заданы оба флага сразу: --query и --query-file ${normalizePath(queryFile)}. Выберите один способ передать выражение.`,
    );
  }
  if (queryFile !== undefined) {
    return { query: readQueryFile(queryFile), queryFile };
  }
  return { query: query ?? null, queryFile: null };
}
