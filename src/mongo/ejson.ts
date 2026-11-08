import { BSON } from 'mongodb';
import { ToolError } from '../errors.ts';
import {
  fields,
  integer,
  invalid,
  isDocument,
  isEjson,
  oneOf,
  string,
  type DocumentValue,
  type Fields,
} from './validation.ts';

function encodedInteger(value: unknown, path: string, minimum: bigint, maximum: bigint): void {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    invalid(path, 'ожидается десятичная строка целого числа');
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > maximum) invalid(path, 'число вне диапазона указанного типа BSON');
}

function encodedDouble(value: unknown, path: string): void {
  string(value, path);
  if (['Infinity', '-Infinity', 'NaN'].includes(value as string)) return;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(value as string)) {
    invalid(path, 'ожидается десятичная строка Double');
  }
  if (!Number.isFinite(Number(value))) invalid(path, 'число вне конечного диапазона Double');
}

function encodedDate(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!Number.isFinite(Date.parse(value))) invalid(path, 'ожидается дата ISO 8601');
    return;
  }
  fields({ $numberLong: (item, fieldPath) => encodedInteger(item, fieldPath, -8640000000000000n, 8640000000000000n) }, [
    '$numberLong',
  ])(value, path);
}

function encodedBinary(value: unknown, path: string): void {
  fields({ base64: string, subType: string }, ['base64', 'subType'])(value, path);
  const { base64, subType } = value as { base64: string; subType: string };
  if (!/^[0-9a-f]{2}$/iu.test(subType)) invalid(`${path}.subType`, 'ожидаются две шестнадцатеричные цифры');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || Buffer.from(base64, 'base64').toString('base64') !== base64) {
    invalid(`${path}.base64`, 'ожидается корректная строка Base64');
  }
}

function timestampPart(value: unknown, path: string): void {
  if (typeof value !== 'number') invalid(path, 'ожидается число JSON для части timestamp');
  integer(0, 4294967295)(value, path);
}

const WRAPPERS: Fields = {
  $numberInt: (value, path) => encodedInteger(value, path, -2147483648n, 2147483647n),
  $numberLong: (value, path) => encodedInteger(value, path, -9223372036854775808n, 9223372036854775807n),
  $numberDouble: encodedDouble,
  $numberDecimal: string,
  $oid: string,
  $uuid: string,
  $symbol: string,
  $undefined: (value, path) => {
    oneOf(true)(value, path);
    invalid(path, 'BSON Undefined не поддерживается во входных запросах');
  },
  $minKey: oneOf(1),
  $maxKey: oneOf(1),
  $date: encodedDate,
  $binary: encodedBinary,
  $regularExpression: fields({ pattern: string, options: string }, ['pattern', 'options']),
  $timestamp: fields({ t: timestampPart, i: timestampPart }, ['t', 'i']),
  $dbPointer: (value, path) => {
    fields({ $ref: string, $id: fields({ $oid: string }, ['$oid']) }, ['$ref', '$id'])(value, path);
    invalid(path, 'BSON DBPointer не поддерживается во входных запросах');
  },
};

function decodeWrapper(value: DocumentValue, path: string): unknown {
  if (Object.hasOwn(value, '$code')) {
    fields(
      {
        $code: string,
        $scope: (scope, scopePath) => {
          if (!isDocument(scope)) invalid(scopePath, 'ожидается документ области видимости BSON Code');
        },
      },
      ['$code'],
    )(value, path);
    return new BSON.Code(
      value.$code as string,
      value.$scope ? (decodeMongoEjson(value.$scope, `${path}.$scope`) as DocumentValue) : undefined,
    );
  }
  fields(WRAPPERS)(value, path);
  try {
    return BSON.EJSON.deserialize(value, { relaxed: false });
  } catch {
    invalid(path, 'некорректное значение Canonical Extended JSON');
  }
}

export function decodeMongoEjson(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => decodeMongoEjson(item, `${path}[${index}]`));
  if (!isDocument(value)) return value;
  if (isEjson(value)) return decodeWrapper(value, path);
  const entries = Object.entries(value).map(([name, item]) => {
    if (name.includes('\0')) invalid(path, 'имя поля BSON содержит нулевой символ');
    return [name, decodeMongoEjson(item, `${path}.${name}`)] as const;
  });
  return Object.hasOwn(value, '_bsontype') ? new Map(entries) : Object.fromEntries(entries);
}

export function canonicalMongoValue(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(canonicalMongoValue);
  if (value instanceof Date && !Number.isFinite(value.getTime())) {
    throw new ToolError(
      'mongo_query_failed',
      'MongoDB вернула BSON Date вне поддерживаемого диапазона JavaScript Date.',
    );
  }
  if (value instanceof BSON.Code) {
    return value.scope === null
      ? { $code: value.code }
      : { $code: value.code, $scope: canonicalMongoValue(value.scope) };
  }
  if (value instanceof BSON.DBRef) {
    throw new ToolError(
      'mongo_query_failed',
      'Драйвер вернул неоднозначный DBRef или DBPointer. Исходный тип BSON невозможно восстановить без потери.',
    );
  }
  if (value instanceof BSON.BSONValue || value instanceof Date) {
    return BSON.EJSON.serialize(value, { relaxed: false });
  }
  if (isDocument(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, canonicalMongoValue(item)]));
  }
  return BSON.EJSON.serialize(value, { relaxed: false });
}
