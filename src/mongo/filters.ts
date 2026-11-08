import { BSON } from 'mongodb';
import { expression } from './expressions.ts';
import {
  alternatives,
  array,
  boolean,
  fields,
  integer,
  invalid,
  isDocument,
  isEjson,
  literal,
  number,
  numericValue,
  object,
  oneOf,
  string,
  strings,
  values,
  type Fields,
  type Rule,
} from './validation.ts';

const regex: Rule = (value, path) => {
  if (typeof value === 'string') return;
  fields({ $regularExpression: fields({ pattern: string, options: string }, ['pattern', 'options']) }, [
    '$regularExpression',
  ])(value, path);
};

const typeName = alternatives(string, integer(-1, -1), integer(1, 127));

const schema: Rule = (value, path) => fields(JSON_SCHEMA)(value, path);
const JSON_SCHEMA: Fields = {
  title: string,
  description: string,
  bsonType: alternatives(string, strings),
  type: alternatives(string, strings),
  required: strings,
  properties: values(schema),
  patternProperties: values(schema),
  additionalProperties: alternatives(boolean, schema),
  dependencies: values(alternatives(strings, schema)),
  items: alternatives(schema, array(schema)),
  additionalItems: alternatives(boolean, schema),
  minItems: integer(0),
  maxItems: integer(0),
  uniqueItems: boolean,
  minProperties: integer(0),
  maxProperties: integer(0),
  minimum: number,
  maximum: number,
  exclusiveMinimum: boolean,
  exclusiveMaximum: boolean,
  multipleOf: number,
  minLength: integer(0),
  maxLength: integer(0),
  pattern: string,
  enum: array(literal, 1),
  allOf: array(schema, 1),
  anyOf: array(schema, 1),
  oneOf: array(schema, 1),
  not: schema,
};

const geometry = fields(
  {
    type: oneOf('Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'),
    coordinates: array(literal),
    crs: fields({ type: oneOf('name'), properties: fields({ name: string }, ['name']) }, ['type', 'properties']),
  },
  ['type', 'coordinates'],
);

const geoWithin = fields({
  $geometry: geometry,
  $box: array(array(number, 2, 2), 2, 2),
  $polygon: array(array(number, 2, 2), 3),
  $center: array(literal, 2, 2),
  $centerSphere: array(literal, 2, 2),
});
const near = alternatives(
  array(number, 2, 2),
  fields(
    {
      $geometry: geometry,
      $minDistance: number,
      $maxDistance: number,
    },
    ['$geometry'],
  ),
);

function fieldPredicate(value: unknown, path: string): void {
  if (!isDocument(value) || isEjson(value)) return;
  if (!Object.keys(value).some((name) => name.startsWith('$'))) return;
  fields(FIELD_OPERATORS)(value, path);
}

function elementMatch(value: unknown, path: string): void {
  const document = object(value, path);
  const names = Object.keys(document);
  if (names.some((name) => Object.hasOwn(FIELD_OPERATORS, name))) {
    fields(FIELD_OPERATORS)(value, path);
  } else filter(value, path);
}

const allItem: Rule = (value, path) => {
  if (isDocument(value) && Object.hasOwn(value, '$elemMatch')) {
    fields({ $elemMatch: elementMatch }, ['$elemMatch'])(value, path);
  }
};

const decimalBitmask: Rule = (value, path) => {
  if (typeof value !== 'string') invalid(path, 'ожидается строка');
  let decimal: string;
  try {
    decimal = BSON.Decimal128.fromString(value).toString();
  } catch {
    invalid(path, 'ожидается значение Decimal128');
  }
  const parts = /^(-?\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/u.exec(decimal);
  if (!parts) invalid(path, 'ожидается конечное число');
  const fraction = parts[2] ?? '';
  let mask = BigInt(`${parts[1]}${fraction}`);
  const exponent = BigInt(parts[3] ?? '0') - BigInt(fraction.length);
  if (exponent < 0n) {
    const divisor = 10n ** -exponent;
    if (mask % divisor !== 0n) invalid(path, 'ожидается целая маска');
    mask /= divisor;
  } else {
    mask *= 10n ** exponent;
  }
  if (mask < 0n || mask > 9223372036854775807n) {
    invalid(path, 'ожидается неотрицательная целая маска в диапазоне Int64');
  }
};

const numericBitmask: Rule = (value, path) => {
  if (isDocument(value) && Object.hasOwn(value, '$numberDecimal')) {
    fields({ $numberDecimal: decimalBitmask }, ['$numberDecimal'])(value, path);
    return;
  }
  if (isDocument(value) && Object.hasOwn(value, '$numberLong')) {
    fields({ $numberLong: string }, ['$numberLong'])(value, path);
    const encoded = value.$numberLong;
    if (typeof encoded !== 'string' || !/^-?\d+$/u.test(encoded)) {
      invalid(path, 'ожидается неотрицательная целая маска в диапазоне Int64');
    }
    if (BigInt(encoded) < 0n || BigInt(encoded) > 9223372036854775807n) {
      invalid(path, 'ожидается неотрицательная целая маска в диапазоне Int64');
    }
    return;
  }
  const numeric = numericValue(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= 2 ** 63) {
    invalid(path, 'ожидается неотрицательная целая маска в диапазоне Int64');
  }
};

const bitmask = alternatives(array(integer(0)), fields({ $binary: literal }, ['$binary']), numericBitmask);

const FIELD_OPERATORS: Fields = {
  $eq: literal,
  $ne: literal,
  $gt: literal,
  $gte: literal,
  $lt: literal,
  $lte: literal,
  $in: array(literal),
  $nin: array(literal),
  $all: array(allItem),
  $exists: boolean,
  $type: alternatives(typeName, array(typeName, 1)),
  $mod: array(number, 2, 2),
  $regex: regex,
  $options: string,
  $size: integer(0),
  $elemMatch: elementMatch,
  $not: (value, path) => {
    if (isDocument(value) && isEjson(value)) regex(value, path);
    else fields(FIELD_OPERATORS)(value, path);
  },
  $bitsAllClear: bitmask,
  $bitsAllSet: bitmask,
  $bitsAnyClear: bitmask,
  $bitsAnySet: bitmask,
  $geoWithin: geoWithin,
  $geoIntersects: fields({ $geometry: geometry }, ['$geometry']),
  $near: near,
  $nearSphere: near,
  $minDistance: number,
  $maxDistance: number,
};

const FILTER_OPERATORS: Fields = {
  $and: array(filter, 1),
  $or: array(filter, 1),
  $nor: array(filter, 1),
  $expr: expression,
  $comment: literal,
  $jsonSchema: schema,
  $text: fields(
    {
      $search: string,
      $language: string,
      $caseSensitive: boolean,
      $diacriticSensitive: boolean,
    },
    ['$search'],
  ),
};

export function filter(value: unknown, path: string): void {
  for (const [name, item] of Object.entries(object(value, path))) {
    const fieldPath = `${path}.${name}`;
    if (!name.startsWith('$')) {
      fieldPredicate(item, fieldPath);
      continue;
    }
    if (!Object.hasOwn(FILTER_OPERATORS, name)) invalid(fieldPath, 'неизвестный или запрещённый оператор фильтра');
    FILTER_OPERATORS[name]!(item, fieldPath);
  }
}

const projectionField: Rule = (value, path) => {
  if (isDocument(value) && Object.hasOwn(value, '$elemMatch')) {
    fields({ $elemMatch: elementMatch }, ['$elemMatch'])(value, path);
  } else if (isDocument(value) && Object.hasOwn(value, '$slice')) {
    fields({ $slice: alternatives(integer(), array(integer(), 2, 2)) }, ['$slice'])(value, path);
  } else expression(value, path);
};

export const projection = values(projectionField);
export const FILTER_OPERATOR_NAMES = Object.freeze([...Object.keys(FILTER_OPERATORS), ...Object.keys(FIELD_OPERATORS)]);
