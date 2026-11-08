import {
  alternatives,
  array,
  boolean,
  emptyDocument,
  fields,
  integer,
  invalid,
  isDocument,
  isEjson,
  literal,
  namedOperator,
  number,
  object,
  oneOf,
  sort,
  string,
  values,
  type Fields,
  type Rule,
} from './validation.ts';

export function expression(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    array(expression)(value, path);
    return;
  }
  if (!isDocument(value) || isEjson(value)) return;
  if (Object.keys(value).some((name) => name.startsWith('$'))) {
    namedOperator(value, path, EXPRESSIONS);
    return;
  }
  values(expression)(value, path);
}

function expressionFields(names: readonly string[], required: readonly string[]): Rule {
  return fields(Object.fromEntries(names.map((name) => [name, expression])), required);
}

function operators(names: readonly string[], rule: Rule): Fields {
  return Object.fromEntries(names.map((name) => [`$${name}`, rule]));
}

const conditional: Rule = (value, path) => {
  if (Array.isArray(value)) array(expression, 3, 3)(value, path);
  else expressionFields(['if', 'then', 'else'], ['if', 'then', 'else'])(value, path);
};

const datePart: Rule = (value, path) => {
  if (isDocument(value) && Object.hasOwn(value, 'date')) {
    expressionFields(['date', 'timezone'], ['date'])(value, path);
  } else expression(value, path);
};

const firstN = expressionFields(['input', 'n'], ['input', 'n']);
const top = fields({ output: expression, sortBy: sort }, ['output', 'sortBy']);
const topN = fields({ output: expression, sortBy: sort, n: expression }, ['output', 'sortBy', 'n']);
const percentile = fields(
  {
    input: expression,
    p: expression,
    method: oneOf('approximate'),
  },
  ['input', 'p', 'method'],
);
const median = fields({ input: expression, method: oneOf('approximate') }, ['input', 'method']);

const EXPRESSIONS: Fields = {
  ...operators(
    [
      'abs',
      'acos',
      'acosh',
      'asin',
      'asinh',
      'atan',
      'atanh',
      'binarySize',
      'bitNot',
      'bsonSize',
      'ceil',
      'cos',
      'cosh',
      'degreesToRadians',
      'exp',
      'floor',
      'isArray',
      'isNumber',
      'ln',
      'log10',
      'objectToArray',
      'arrayToObject',
      'radiansToDegrees',
      'reverseArray',
      'size',
      'sqrt',
      'strLenBytes',
      'strLenCP',
      'tan',
      'tanh',
      'toBool',
      'toDate',
      'toDecimal',
      'toDouble',
      'toHashedIndexKey',
      'toInt',
      'toLong',
      'toLower',
      'toObjectId',
      'toString',
      'toUpper',
      'tsIncrement',
      'tsSecond',
      'type',
      'first',
      'last',
    ],
    expression,
  ),
  ...operators(
    ['add', 'multiply', 'concat', 'concatArrays', 'and', 'or', 'bitAnd', 'bitOr', 'bitXor'],
    array(expression),
  ),
  ...operators(
    [
      'cmp',
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'subtract',
      'divide',
      'mod',
      'pow',
      'log',
      'atan2',
      'arrayElemAt',
      'in',
      'setDifference',
      'setIsSubset',
      'split',
      'strcasecmp',
    ],
    array(expression, 2, 2),
  ),
  ...operators(['round', 'trunc'], array(expression, 1, 2)),
  ...operators(['slice', 'range'], array(expression, 2, 3)),
  ...operators(['indexOfArray', 'indexOfBytes', 'indexOfCP'], array(expression, 2, 4)),
  ...operators(['substr', 'substrBytes', 'substrCP'], array(expression, 3, 3)),
  ...operators(['setEquals', 'ifNull'], array(expression, 2)),
  ...operators(['setIntersection', 'setUnion'], array(expression, 1)),
  ...operators(['not', 'allElementsTrue', 'anyElementTrue'], array(expression, 1, 1)),
  ...operators(['sum', 'avg', 'min', 'max', 'stdDevPop', 'stdDevSamp', 'mergeObjects'], expression),
  ...operators(
    [
      'dayOfMonth',
      'dayOfWeek',
      'dayOfYear',
      'hour',
      'isoDayOfWeek',
      'isoWeek',
      'isoWeekYear',
      'millisecond',
      'minute',
      'month',
      'second',
      'week',
      'year',
    ],
    datePart,
  ),
  ...operators(['firstN', 'lastN', 'minN', 'maxN'], firstN),
  ...operators(['top', 'bottom'], top),
  ...operators(['topN', 'bottomN'], topN),
  $literal: literal,
  $const: literal,
  $cond: conditional,
  $switch: fields(
    {
      branches: array(expressionFields(['case', 'then'], ['case', 'then']), 1),
      default: expression,
    },
    ['branches'],
  ),
  $let: fields({ vars: values(expression), in: expression }, ['vars', 'in']),
  $map: fields({ input: expression, as: string, in: expression }, ['input', 'in']),
  $filter: fields({ input: expression, as: string, cond: expression, limit: expression }, ['input', 'cond']),
  $reduce: expressionFields(['input', 'initialValue', 'in'], ['input', 'initialValue', 'in']),
  $convert: expressionFields(['input', 'to', 'onError', 'onNull', 'format', 'byteOrder'], ['input', 'to']),
  $dateFromString: expressionFields(['dateString', 'format', 'timezone', 'onError', 'onNull'], ['dateString']),
  $dateToString: expressionFields(['date', 'format', 'timezone', 'onNull'], ['date']),
  $dateFromParts: expressionFields(
    [
      'year',
      'month',
      'day',
      'hour',
      'minute',
      'second',
      'millisecond',
      'isoWeekYear',
      'isoWeek',
      'isoDayOfWeek',
      'timezone',
    ],
    [],
  ),
  $dateToParts: expressionFields(['date', 'timezone', 'iso8601'], ['date']),
  $dateAdd: expressionFields(['startDate', 'unit', 'amount', 'timezone'], ['startDate', 'unit', 'amount']),
  $dateSubtract: expressionFields(['startDate', 'unit', 'amount', 'timezone'], ['startDate', 'unit', 'amount']),
  $dateDiff: expressionFields(
    ['startDate', 'endDate', 'unit', 'timezone', 'startOfWeek'],
    ['startDate', 'endDate', 'unit'],
  ),
  $dateTrunc: expressionFields(['date', 'unit', 'binSize', 'timezone', 'startOfWeek'], ['date', 'unit']),
  $getField: (value, path) => {
    if (typeof value === 'string') return;
    const document = object(value, path);
    if (Object.keys(document).some((name) => name.startsWith('$'))) expression(value, path);
    else expressionFields(['field', 'input'], ['field'])(value, path);
  },
  $setField: expressionFields(['field', 'input', 'value'], ['field', 'input', 'value']),
  $unsetField: expressionFields(['field', 'input'], ['field', 'input']),
  ...operators(
    ['replaceOne', 'replaceAll'],
    expressionFields(['input', 'find', 'replacement'], ['input', 'find', 'replacement']),
  ),
  ...operators(
    ['regexMatch', 'regexFind', 'regexFindAll'],
    expressionFields(['input', 'regex', 'options'], ['input', 'regex']),
  ),
  ...operators(['trim', 'ltrim', 'rtrim'], expressionFields(['input', 'chars'], ['input'])),
  $zip: fields({ inputs: array(expression, 1), useLongestLength: boolean, defaults: array(expression) }, ['inputs']),
  $sortArray: fields({ input: expression, sortBy: alternatives(integer(-1, 1), sort) }, ['input', 'sortBy']),
  $rand: emptyDocument,
  $meta: oneOf('textScore', 'searchScore', 'searchHighlights', 'searchSequenceToken', 'vectorSearchScore', 'indexKey'),
  $median: median,
  $percentile: percentile,
};

const ACCUMULATORS: Fields = {
  ...operators(
    [
      'sum',
      'avg',
      'min',
      'max',
      'first',
      'last',
      'push',
      'addToSet',
      'stdDevPop',
      'stdDevSamp',
      'mergeObjects',
      'concatArrays',
      'setUnion',
    ],
    expression,
  ),
  ...operators(['firstN', 'lastN', 'minN', 'maxN'], firstN),
  ...operators(['top', 'bottom'], top),
  ...operators(['topN', 'bottomN'], topN),
  $count: emptyDocument,
  $median: median,
  $percentile: percentile,
};

export const accumulator: Rule = (value, path) => namedOperator(value, path, ACCUMULATORS);

export const group: Rule = (value, path) => {
  const document = object(value, path);
  if (!Object.hasOwn(document, '_id')) invalid(`${path}._id`, 'обязательное поле отсутствует');
  for (const [name, item] of Object.entries(document)) {
    if (name === '_id') expression(item, `${path}.${name}`);
    else accumulator(item, `${path}.${name}`);
  }
};

const WINDOW_OPERATORS: Fields = {
  ...ACCUMULATORS,
  ...operators(['rank', 'denseRank', 'documentNumber'], emptyDocument),
  ...operators(['locf', 'linearFill'], expression),
  ...operators(['covariancePop', 'covarianceSamp'], array(expression, 2, 2)),
  ...operators(['derivative', 'integral'], fields({ input: expression, unit: string }, ['input'])),
  $shift: fields({ output: expression, by: integer(), default: expression }, ['output', 'by']),
  $expMovingAvg: fields({ input: expression, N: integer(1), alpha: number }, ['input']),
};

const documentWindowBounds = array(alternatives(integer(), oneOf('unbounded', 'current')), 2, 2);
const rangeWindowBounds = array(alternatives(number, oneOf('unbounded', 'current')), 2, 2);
const window: Rule = (value, path) => {
  const document = object(value, path);
  if (Object.hasOwn(document, 'documents')) {
    fields({ documents: documentWindowBounds }, ['documents'])(value, path);
    return;
  }
  fields(
    {
      range: Object.hasOwn(document, 'unit') ? documentWindowBounds : rangeWindowBounds,
      unit: oneOf('year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'),
    },
    ['range'],
  )(value, path);
};

const windowOutput: Rule = (value, path) => {
  const document = object(value, path);
  const operator = Object.fromEntries(Object.entries(document).filter(([name]) => name !== 'window'));
  namedOperator(operator, path, WINDOW_OPERATORS);
  if (Object.hasOwn(document, 'window')) window(document.window, `${path}.window`);
};

export const windowFields = fields(
  {
    partitionBy: expression,
    sortBy: sort,
    output: values(windowOutput),
  },
  ['output'],
);

export const EXPRESSION_NAMES = Object.freeze(Object.keys(EXPRESSIONS));
