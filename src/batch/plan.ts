import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { joinNegativeValues, OPTIONS, type ParsedValues } from '../cli/args.ts';
import { prepareLogs, type PreparedLogs } from '../cli/dispatch.ts';
import { prepareMetrics, type PreparedMetrics } from '../cli/dispatchMetrics.ts';
import { ToolError } from '../errors.ts';
import { normalizePath, normalizePathFrom } from '../paths.ts';
import { readQueryFile } from '../queryFile.ts';

interface Description {
  id: string;
  why: string;
  originalArgv: string[];
  invocation: string[];
}

export type PreparedRequest = Description &
  ({ kind: 'metrics'; operation: PreparedMetrics } | { kind: 'logs'; operation: PreparedLogs });

export interface PreparedBatch {
  goal: string;
  file: string;
  requests: PreparedRequest[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('bad_request', `${label}: требуется объект JSON.`);
  }
  return value as Record<string, unknown>;
}

function keys(row: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ToolError('bad_request', `${label}: неизвестные поля ${unknown.join(', ')}.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolError('bad_request', `${label}: требуется непустая строка.`);
  }
  return value;
}

function argumentsOf(value: unknown, id: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolError('bad_request', `Пункт ${id}: argv должен быть массивом строк.`);
  }
  return value as string[];
}

function childValues(
  argv: string[],
  id: string,
): {
  values: ParsedValues;
  group: string;
  action: string | undefined;
} {
  const parsed = parseArgs({
    args: joinNegativeValues(argv),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [group, action] = parsed.positionals;
  if ((group !== 'metrics' && group !== 'logs') || parsed.positionals.length !== 2) {
    throw new ToolError('bad_request', `Пункт ${id}: допустимы только команды metrics и logs.`);
  }
  for (const flag of ['config', 'profile', 'human', 'help', 'file', 'out', 'view', 'baseline'] as const) {
    if (parsed.values[flag] !== undefined) {
      throw new ToolError('bad_request', `Пункт ${id}: --${flag} задаётся только для пакета.`);
    }
  }
  return { values: parsed.values, group, action };
}

function inheritedValues(
  values: ParsedValues,
  group: string,
  action: string | undefined,
  defaults: ParsedValues,
  base: string,
): ParsedValues {
  const result = { ...values, config: defaults.config, profile: defaults.profile };
  if (group === 'logs' || action !== 'instant') {
    result.start ??= defaults.start;
    result.end ??= defaults.end;
  }
  if (result['query-file'] !== undefined) {
    result['query-file'] = normalizePathFrom(base, result['query-file']);
  }
  return result;
}

function invocationOf(group: string, action: string | undefined, values: ParsedValues): string[] {
  const argv = [group, action as string];
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === false) continue;
    if (raw === true) {
      argv.push(`--${key}`);
      continue;
    }
    const items = Array.isArray(raw) ? raw : [raw];
    for (const value of items) argv.push(`--${key}=${value}`);
  }
  return argv;
}

function prepareItem(raw: unknown, defaults: ParsedValues, base: string): PreparedRequest {
  const row = object(raw, 'Пункт пакета');
  keys(row, ['id', 'why', 'argv'], 'Пункт пакета');
  const id = text(row.id, 'id');
  const why = text(row.why, `Пункт ${id}.why`);
  const originalArgv = argumentsOf(row.argv, id);
  try {
    const { values, group, action } = childValues(originalArgv, id);
    const effective = inheritedValues(values, group, action, defaults, base);
    const common = { id, why, originalArgv, invocation: invocationOf(group, action, effective) };
    if (group === 'metrics') {
      return { ...common, kind: 'metrics', operation: prepareMetrics(action, effective) };
    }
    return { ...common, kind: 'logs', operation: prepareLogs(action, effective) };
  } catch (cause) {
    if (cause instanceof ToolError)
      throw new ToolError(cause.errorClass, `Пункт ${id}: ${cause.message}`, cause.partialPayload, cause.echo);
    const error = cause as Error;
    throw new ToolError('bad_request', `Пункт ${id}: ${error.message}`);
  }
}

export function loadBatch(file: string, defaults: ParsedValues): PreparedBatch {
  const absolute = resolve(normalizePath(file));
  let raw: unknown;
  try {
    raw = JSON.parse(readQueryFile(absolute)) as unknown;
  } catch (cause) {
    if (cause instanceof ToolError) throw cause;
    throw new ToolError('bad_request', `Пакет ${absolute}: ${(cause as Error).message}`);
  }
  const row = object(raw, 'Пакет');
  keys(row, ['version', 'goal', 'requests'], 'Пакет');
  if (row.version !== 1) throw new ToolError('bad_request', 'Пакет должен иметь version: 1.');
  const goal = text(row.goal, 'goal');
  if (!Array.isArray(row.requests) || row.requests.length === 0) {
    throw new ToolError('bad_request', 'Пакет должен содержать непустой requests.');
  }
  const requests = row.requests.map((item) => prepareItem(item, defaults, dirname(absolute)));
  if (new Set(requests.map((item) => item.id)).size !== requests.length) {
    throw new ToolError('bad_request', 'id пунктов пакета должны быть уникальными.');
  }
  return { goal, file: absolute, requests };
}
