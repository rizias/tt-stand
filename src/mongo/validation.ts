import { ToolError } from '../errors.ts';

export type DocumentValue = Record<string, unknown>;
export type Rule = (value: unknown, path: string) => void;
export type Fields = Readonly<Record<string, Rule>>;

export function invalid(path: string, expected: string): never {
  throw new ToolError('bad_request', `MongoDB ${path}: ${expected}.`);
}

export function isDocument(value: unknown): value is DocumentValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function object(value: unknown, path: string): DocumentValue {
  if (!isDocument(value)) invalid(path, 'ожидается документ');
  return value;
}

export const literal: Rule = () => undefined;

export const string: Rule = (value, path) => {
  if (typeof value !== 'string') invalid(path, 'ожидается строка');
};

export const nonemptyString: Rule = (value, path) => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalid(path, 'ожидается непустая строка без нулевого символа');
  }
};

export const boolean: Rule = (value, path) => {
  if (typeof value !== 'boolean') invalid(path, 'ожидается логическое значение');
};

export const falseOnly: Rule = (value, path) => {
  if (value !== false) invalid(path, 'для конечного чтения допустимо только false');
};

export function numericValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (!isDocument(value) || Object.keys(value).length !== 1) return Number.NaN;
  const encoded = value.$numberInt ?? value.$numberLong ?? value.$numberDouble ?? value.$numberDecimal;
  return typeof encoded === 'string' && encoded.trim() !== '' ? Number(encoded) : Number.NaN;
}

export const number: Rule = (value, path) => {
  if (!Number.isFinite(numericValue(value))) invalid(path, 'ожидается конечное число');
};

export function integer(minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): Rule {
  return (value, path) => {
    const numeric = numericValue(value);
    if (isDocument(value) && Object.hasOwn(value, '$numberDecimal')) {
      invalid(path, 'ожидается целочисленный BSON-тип либо целое Double');
    }
    if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
      invalid(path, `ожидается целое число от ${minimum} до ${maximum}`);
    }
  };
}

export function oneOf(...values: readonly unknown[]): Rule {
  return (value, path) => {
    if (!values.includes(value)) invalid(path, 'неподдерживаемое значение параметра');
  };
}

export function array(rule: Rule, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Rule {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
      invalid(path, `ожидается массив длиной от ${minimum} до ${maximum}`);
    }
    value.forEach((item, index) => rule(item, `${path}[${index}]`));
  };
}

export function fields(schema: Fields, required: readonly string[] = []): Rule {
  return (value, path) => {
    const document = object(value, path);
    for (const name of required) {
      if (!Object.hasOwn(document, name)) invalid(`${path}.${name}`, 'обязательное поле отсутствует');
    }
    for (const [name, item] of Object.entries(document)) {
      if (!Object.hasOwn(schema, name)) invalid(`${path}.${name}`, 'неизвестное или запрещённое поле');
      schema[name]!(item, `${path}.${name}`);
    }
  };
}

export function values(rule: Rule): Rule {
  return (value, path) => {
    for (const [name, item] of Object.entries(object(value, path))) rule(item, `${path}.${name}`);
  };
}

export function namedOperator(value: unknown, path: string, registry: Fields): void {
  const document = object(value, path);
  const names = Object.keys(document);
  if (names.length !== 1) invalid(path, 'ожидается ровно один оператор');
  const name = names[0]!;
  if (!Object.hasOwn(registry, name)) invalid(`${path}.${name}`, 'неизвестный или запрещённый оператор');
  registry[name]!(document[name], `${path}.${name}`);
}

const EJSON_NAMES = new Set([
  '$oid',
  '$date',
  '$binary',
  '$uuid',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$regularExpression',
  '$timestamp',
  '$minKey',
  '$maxKey',
  '$undefined',
  '$symbol',
  '$dbPointer',
  '$code',
]);

export function isEjson(value: DocumentValue): boolean {
  const names = Object.keys(value);
  if (names.length === 1) return EJSON_NAMES.has(names[0]!);
  return names.length === 2 && Object.hasOwn(value, '$code') && Object.hasOwn(value, '$scope');
}

export function alternatives(...rules: readonly Rule[]): Rule {
  return (value, path) => {
    for (const rule of rules) {
      try {
        rule(value, path);
        return;
      } catch (cause) {
        if (!(cause instanceof ToolError)) throw cause;
      }
    }
    invalid(path, 'значение не соответствует допустимой структуре');
  };
}

export const emptyDocument = fields({});
export const strings = array(string);

export const sort: Rule = values((value, path) => {
  if (numericValue(value) === 1 || numericValue(value) === -1) return;
  fields({ $meta: oneOf('textScore', 'searchScore', 'vectorSearchScore', 'indexKey') }, ['$meta'])(value, path);
});

export const hint: Rule = alternatives(
  nonemptyString,
  values(alternatives(integer(-1, 1), oneOf('text', 'hashed', '2d', '2dsphere', 'geoHaystack'))),
);
