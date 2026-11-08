import { BSON, type Document } from 'mongodb';
import { ToolError } from '../errors.ts';
import { MONGO_COMMAND_NAMES, validateCommand, type ValidatedCommand } from './commands.ts';
import { decodeMongoEjson } from './ejson.ts';
import { EXPRESSION_NAMES } from './expressions.ts';
import { FILTER_OPERATOR_NAMES } from './filters.ts';
import { PIPELINE_STAGE_NAMES } from './pipeline.ts';
import { invalid, isDocument, numericValue, object, type DocumentValue } from './validation.ts';

export { MONGO_COMMAND_NAMES };

const preparedBrand: unique symbol = Symbol('PreparedMongoRead');

export interface PreparedMongoRead extends ValidatedCommand {
  readonly [preparedBrand]: true;
  readonly originalQuery: string;
  readonly limit: number | null;
  readonly batchSize: number | null;
  readonly singleBatch: boolean;
  readonly pipelineLimits: readonly string[];
}

const commands = new WeakMap<PreparedMongoRead, DocumentValue>();
const invalidJsonNumber = Symbol('invalidJsonNumber');
const parseJsonWithSource = JSON.parse as (
  source: string,
  reviver: (key: string, value: unknown, context: { source: string }) => unknown,
) => unknown;

export const MONGO_READ_CAPABILITIES = Object.freeze({
  commands: MONGO_COMMAND_NAMES,
  filterOperators: FILTER_OPERATOR_NAMES,
  expressions: EXPRESSION_NAMES,
  stages: PIPELINE_STAGE_NAMES,
});

function pipelineLimits(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stage: unknown, index) => {
    if (!isDocument(stage)) return [];
    const stagePath = `${path}[${index}]`;
    const limits = Object.hasOwn(stage, '$limit') ? [`${stagePath}.$limit`] : [];
    if (isDocument(stage.$vectorSearch)) limits.push(`${stagePath}.$vectorSearch.limit`);
    for (const name of ['$lookup', '$unionWith']) {
      const nested = stage[name];
      if (isDocument(nested)) limits.push(...pipelineLimits(nested.pipeline, `${stagePath}.${name}.pipeline`));
    }
    if (isDocument(stage.$facet)) {
      for (const [name, nested] of Object.entries(stage.$facet)) {
        limits.push(...pipelineLimits(nested, `${stagePath}.$facet.${name}`));
      }
    }
    return limits;
  });
}

function positiveNumber(value: unknown): number | null {
  const numeric = numericValue(value);
  return numeric > 0 ? numeric : null;
}

function validateJsonNumbers(value: unknown, path: string): void {
  if (value === invalidJsonNumber)
    invalid(path, 'число JSON невозможно передать без потери точности; используйте Extended JSON');
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonNumbers(item, `${path}[${index}]`));
    return;
  }
  if (isDocument(value)) {
    for (const [name, item] of Object.entries(value)) validateJsonNumbers(item, `${path}.${name}`);
  }
}

function canonicalDecimal(source: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  if (!parts) return source;
  const significant = `${parts[2]}${parts[3] ?? ''}`.replace(/^0+/u, '');
  if (!significant) return '0';
  const trailingZeros = /0+$/u.exec(significant)?.[0].length ?? 0;
  const digits = significant.slice(0, significant.length - trailingZeros);
  const exponent = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0) + trailingZeros;
  return `${parts[1]}${digits}e${exponent}`;
}

function lossyJsonNumber(value: number, source: string): boolean {
  return !Number.isFinite(value) || canonicalDecimal(source) !== canonicalDecimal(value.toString());
}

export function prepareMongoRead(source: string): PreparedMongoRead {
  try {
    const raw = parseJsonWithSource(source.replace(/^\uFEFF/u, ''), (_key, value, context) => {
      if (typeof value !== 'number') return value;
      return lossyJsonNumber(value, context.source) ? invalidJsonNumber : value;
    });
    validateJsonNumbers(raw, '$');
    const command = object(raw, '$');
    const validated = validateCommand(command, '$');
    const prepared: PreparedMongoRead = Object.freeze({
      ...validated,
      [preparedBrand]: true as const,
      originalQuery: source,
      limit: positiveNumber(Math.abs(numericValue(command.limit))),
      batchSize: positiveNumber(command.batchSize ?? objectCursorBatchSize(command.cursor)),
      singleBatch: command.singleBatch === true,
      pipelineLimits: Object.freeze(validated.hasCursor ? pipelineLimits(command.pipeline, '$.pipeline') : []),
    });
    BSON.serialize(decodeMongoEjson(command, '$') as Document);
    commands.set(prepared, command);
    return prepared;
  } catch (cause) {
    if (cause instanceof ToolError) throw cause;
    throw new ToolError('bad_request', 'MongoDB query должен быть корректным JSON или Extended JSON без скриптов.');
  }
}

function objectCursorBatchSize(value: unknown): unknown {
  return isDocument(value) ? value.batchSize : undefined;
}

export function preparedCommand(prepared: PreparedMongoRead): Document {
  const command = commands.get(prepared);
  if (!command) throw new ToolError('bad_request', 'MongoDB принимает только запрос, прошедший prepareMongoRead.');
  return decodeMongoEjson(command, '$') as Document;
}
