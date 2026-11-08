import { describe, expect, test } from 'vitest';
import { BSON } from 'mongodb';
import { runMongoCommand } from '../src/commands/mongo.ts';
import { ToolError } from '../src/errors.ts';
import { canonicalMongoValue } from '../src/mongo/ejson.ts';
import {
  MONGO_COMMAND_NAMES,
  MONGO_READ_CAPABILITIES,
  prepareMongoRead,
  preparedCommand,
} from '../src/mongo/prepare.ts';

const prepare = (query: unknown) => prepareMongoRead(JSON.stringify(query));
const aggregateExpression = (value: unknown) => ({
  aggregate: 'orders',
  pipeline: [{ $project: { value } }],
  cursor: {},
});
const windowQuery = (window: unknown) => ({
  aggregate: 'orders',
  pipeline: [{ $setWindowFields: { sortBy: { amount: 1 }, output: { total: { $sum: '$amount', window } } } }],
  cursor: {},
});

test('неточное число JSON отклоняется до загрузки профиля', async () => {
  const numbers = [
    '9007199254740993',
    '9007199254740993e0',
    '9007199254740993.0',
    '9007199254740991.1',
    '1e309',
    '1e-324',
  ];
  for (const number of numbers) {
    let profileLoads = 0;
    const query = `{"find":"orders","filter":{"id":${number}}}`;
    await expect(
      runMongoCommand({ query }, () => {
        profileLoads += 1;
        throw new Error('Загрузка профиля запрещена в фикстуре');
      }),
    ).rejects.toMatchObject({ errorClass: 'bad_request', message: expect.stringContaining('$.filter.id') });
    expect(profileLoads).toBe(0);
  }
  expect(() => prepareMongoRead('{"find":"orders","filter":{"fraction":0.1,"largeDouble":1e100}}')).not.toThrow();
});

describe('BSON Undefined во входных запросах', () => {
  const encoded = { $undefined: true };
  const cases = [
    { query: { find: 'orders', filter: { value: encoded } }, path: '$.filter.value.$undefined' },
    {
      query: { find: 'orders', filter: { value: { $eq: { nested: encoded } } } },
      path: '$.filter.value.$eq.nested.$undefined',
    },
    {
      query: { find: 'orders', filter: { value: { $in: [encoded] } } },
      path: '$.filter.value.$in[0].$undefined',
    },
    { query: aggregateExpression({ $literal: encoded }), path: '$.pipeline[0].$project.value.$literal.$undefined' },
    { query: aggregateExpression({ $const: encoded }), path: '$.pipeline[0].$project.value.$const.$undefined' },
    {
      query: { find: 'orders', filter: { value: { $eq: { $code: 'data', $scope: { nested: encoded } } } } },
      path: '$.filter.value.$eq.$scope.nested.$undefined',
    },
    {
      query: { explain: { find: 'orders', filter: { value: encoded } } },
      path: '$.explain.filter.value.$undefined',
    },
    {
      query: { aggregate: 1, pipeline: [{ $documents: { $literal: [{ value: encoded }] } }], cursor: {} },
      path: '$.pipeline[0].$documents.$literal[0].value.$undefined',
    },
  ];

  test.each(cases)('отклоняется до загрузки профиля по пути $path', async ({ query, path }) => {
    let profileLoads = 0;
    await expect(
      runMongoCommand({ query: JSON.stringify(query) }, () => {
        profileLoads += 1;
        throw new Error('Загрузка профиля запрещена в фикстуре');
      }),
    ).rejects.toMatchObject({ errorClass: 'bad_request', message: expect.stringContaining(path) });
    expect(profileLoads).toBe(0);
  });

  test('некорректная форма Undefined остаётся запрещённой', () => {
    expect(() => prepare({ find: 'orders', filter: { value: { $undefined: false } } })).toThrow(ToolError);
  });

  test('тип Undefined можно искать стандартным предикатом type', () => {
    const query = { find: 'orders', filter: { value: { $type: 6 } } };
    expect(preparedCommand(prepare(query))).toEqual(query);
  });

  test('выходной Undefined и обычный null различаются', () => {
    expect(canonicalMongoValue({ value: undefined, empty: null })).toEqual({
      value: { $undefined: true },
      empty: null,
    });
    const query = { find: 'orders', filter: { value: null } };
    expect(preparedCommand(prepare(query))).toEqual(query);
  });

  test('поддерживаемые BSON-типы сохраняются во входном запросе', () => {
    const filter = {
      id: { $oid: '507f1f77bcf86cd799439011' },
      integer: { $numberLong: '9007199254740993' },
      decimal: { $numberDecimal: '1.0000000000000000000000000001' },
      regex: { $regularExpression: { pattern: 'value', options: 'ix' } },
    };
    const command = preparedCommand(prepare({ find: 'orders', filter }));
    expect(BSON.serialize(command.filter)).toEqual(BSON.serialize(BSON.EJSON.deserialize(filter, { relaxed: false })));
  });
});

describe('BSON DBPointer во входных запросах', () => {
  const encoded = { $dbPointer: { $ref: 'orders', $id: { $oid: '507f1f77bcf86cd799439011' } } };
  const cases = [
    { query: { find: 'orders', filter: { value: encoded } }, path: '$.filter.value.$dbPointer' },
    {
      query: { find: 'orders', filter: { value: { $eq: { nested: encoded } } } },
      path: '$.filter.value.$eq.nested.$dbPointer',
    },
    {
      query: { find: 'orders', filter: { value: { $in: [encoded] } } },
      path: '$.filter.value.$in[0].$dbPointer',
    },
    { query: aggregateExpression({ $literal: encoded }), path: '$.pipeline[0].$project.value.$literal.$dbPointer' },
    { query: aggregateExpression({ $const: encoded }), path: '$.pipeline[0].$project.value.$const.$dbPointer' },
    {
      query: { find: 'orders', filter: { value: { $eq: { $code: 'data', $scope: { nested: encoded } } } } },
      path: '$.filter.value.$eq.$scope.nested.$dbPointer',
    },
    {
      query: { explain: { find: 'orders', filter: { value: encoded } } },
      path: '$.explain.filter.value.$dbPointer',
    },
    {
      query: { aggregate: 1, pipeline: [{ $documents: { $literal: [{ value: encoded }] } }], cursor: {} },
      path: '$.pipeline[0].$documents.$literal[0].value.$dbPointer',
    },
  ];

  test.each(cases)('отклоняется до загрузки профиля по пути $path', async ({ query, path }) => {
    let profileLoads = 0;
    await expect(
      runMongoCommand({ query: JSON.stringify(query) }, () => {
        profileLoads += 1;
        throw new Error('Загрузка профиля запрещена в фикстуре');
      }),
    ).rejects.toMatchObject({ errorClass: 'bad_request', message: expect.stringContaining(path) });
    expect(profileLoads).toBe(0);
  });

  test('тип DBPointer можно искать стандартным предикатом type', () => {
    const query = { find: 'orders', filter: { value: { $type: 12 } } };
    expect(preparedCommand(prepare(query))).toEqual(query);
  });

  test('обычный DBRef остаётся BSON-документом', () => {
    const query = { find: 'orders', filter: { value: { $eq: encoded.$dbPointer } } };
    const command = preparedCommand(prepare(query));
    const expected = { $ref: 'orders', $id: new BSON.ObjectId('507f1f77bcf86cd799439011') };
    expect(BSON.serialize({ value: command.filter.value.$eq })).toEqual(BSON.serialize({ value: expected }));
    expect(BSON.serialize({ value: command.filter.value.$eq })[4]).toBe(0x03);
  });

  test('строка и составной документ с именем dbPointer сохраняются', () => {
    const value = { $dbPointer: 'text', marker: 'data', dbPointer: '$dbPointer' };
    const query = aggregateExpression({ $literal: value });
    expect(preparedCommand(prepare(query))).toEqual(query);
  });
});

describe('битовые предикаты', () => {
  const operators = ['$bitsAllClear', '$bitsAllSet', '$bitsAnyClear', '$bitsAnySet'];
  const valid = [
    0,
    3,
    2 ** 54,
    { $numberLong: '9223372036854775807' },
    { $numberLong: '0' },
    [],
    [0, 1, 200],
    { $binary: { base64: 'AQI=', subType: '00' } },
  ];
  const validDecimals = [
    '0',
    '-0',
    '0E-6176',
    '-0E+6111',
    '1.00',
    '1E+3',
    '1000E-3',
    '1.000000000000000000000000000000000',
    '9223372036854775807',
    '9223372036854775807.0',
    '92233720368547758070E-1',
  ];
  const invalid = [
    { unexpected: true },
    'invalid',
    [-1, 1.5],
    -1,
    0.5,
    2 ** 63,
    { $numberLong: '-1' },
    { $numberLong: '9223372036854775808' },
    { $numberLong: '1', unexpected: true },
    ...[
      '1.0000000000000000000000000001',
      '1e-999',
      '-1e-999',
      '1E-6176',
      '-1E-6176',
      '-1',
      '0.5',
      '1.5E+0',
      '1001E-3',
      '9223372036854775807.1',
      '9223372036854775808',
      '1E+6144',
      '1e9999999999',
      'NaN',
      'Infinity',
      '-Infinity',
      'invalid',
    ].map((value) => ({ $numberDecimal: value })),
    { $numberDecimal: 1 },
    { $numberDecimal: '1', unexpected: true },
  ];
  test.each(operators.flatMap((operator) => valid.map((mask) => ({ operator, mask }))))(
    '$operator принимает допустимую маску $mask',
    ({ operator, mask }) => {
      expect(() => prepare({ find: 'orders', filter: { value: { [operator]: mask } } })).not.toThrow();
    },
  );
  test.each(operators.flatMap((operator) => validDecimals.map((value) => ({ operator, value }))))(
    '$operator сохраняет допустимую целую Decimal128-маску $value',
    ({ operator, value }) => {
      const query = { find: 'orders', filter: { value: { [operator]: { $numberDecimal: value } } } };
      const command = preparedCommand(prepare(query));
      expect(command.filter.value[operator]).toBeInstanceOf(BSON.Decimal128);
      expect(command.filter.value[operator]).toEqual(BSON.Decimal128.fromString(value));
    },
  );
  test.each(operators.flatMap((operator) => invalid.map((mask) => ({ operator, mask }))))(
    '$operator отклоняет неверную маску $mask до загрузки профиля',
    async ({ operator, mask }) => {
      const query = { find: 'orders', filter: { value: { [operator]: mask } } };
      expect(() => prepare(query)).toThrow(ToolError);
      let profileLoads = 0;
      await expect(
        runMongoCommand({ query: JSON.stringify(query) }, () => {
          profileLoads += 1;
          throw new Error('Загрузка профиля запрещена в фикстуре');
        }),
      ).rejects.toMatchObject({ errorClass: 'bad_request' });
      expect(profileLoads).toBe(0);
    },
  );
});

describe('стандартные читающие команды MongoDB', () => {
  const commands = [
    {
      find: 'orders',
      filter: { status: { $in: ['failed', 'pending'] }, amount: { $gte: 2 } },
      sort: { createdAt: -1 },
      projection: { _id: 1 },
      batchSize: 2,
    },
    {
      aggregate: 'orders',
      pipeline: [{ $match: { status: 'failed' } }, { $group: { _id: '$customerId', count: { $sum: 1 } } }],
      cursor: {},
    },
    { count: 'orders', query: { $or: [{ status: 'failed' }, { amount: { $gt: 10 } }] } },
    { distinct: 'orders', key: 'customerId', query: {} },
    { listDatabases: 1, nameOnly: true },
    { listCollections: 1, cursor: { batchSize: 2 } },
    { listIndexes: 'orders' },
    { collStats: 'orders', scale: 1024 },
    { dbStats: 1, freeStorage: true },
    { explain: { find: 'orders', filter: { status: 'failed' } }, verbosity: 'executionStats' },
    { ping: 1 },
    { hello: 1 },
    { buildInfo: 1 },
  ];

  test.each(commands)('принимается $0', (query) => {
    const prepared = prepare(query);
    expect(prepared.name).toBe(Object.keys(query)[0]);
    expect(MONGO_COMMAND_NAMES).toContain(prepared.name);
  });

  test('реестр возможностей соответствует закрытому набору команд', () => {
    expect(MONGO_READ_CAPABILITIES.commands).toHaveLength(13);
    expect(MONGO_READ_CAPABILITIES.stages).toContain('$lookup');
    expect(MONGO_READ_CAPABILITIES.stages).not.toContain('$merge');
    expect(MONGO_READ_CAPABILITIES.expressions).not.toContain('$function');
    expect(MONGO_READ_CAPABILITIES.filterOperators).not.toContain('$where');
  });

  test.each([{ type: -1 }, { type: { $numberInt: '-1' } }, { type: [-1, 127] }])(
    'принимается тип MinKey $0',
    ({ type }) => {
      expect(() => prepare({ find: 'orders', filter: { value: { $type: type } } })).not.toThrow();
    },
  );

  test.each([
    { limit: -3, expectedLimit: 3 },
    { limit: { $numberInt: '-3' }, expectedLimit: 3 },
    { limit: { $numberLong: '-3' }, expectedLimit: 3 },
  ])('отрицательный limit count сохраняется в отправляемой команде $0', ({ limit, expectedLimit }) => {
    const query = { count: 'orders', limit };
    const prepared = prepare(query);
    expect(prepared.limit).toBe(expectedLimit);
    expect(prepared.originalQuery).toBe(JSON.stringify(query));
    expect(BSON.serialize(preparedCommand(prepared))).toEqual(
      BSON.serialize(BSON.EJSON.deserialize(query, { relaxed: false })),
    );
  });

  test.each([
    { $setUnion: ['$tags'] },
    { $setIntersection: ['$tags'] },
    { $getField: { $literal: 'amount' } },
    { $getField: { $concat: ['am', 'ount'] } },
    { $getField: { field: { $literal: 'amount' }, input: '$$CURRENT' } },
  ])('принимается стандартная форма выражения $0', (value) => {
    expect(() => prepare(aggregateExpression(value))).not.toThrow();
  });

  test.each([
    { $literal: [{ value: { $where: 'data', $function: 'data', $out: 'data' } }] },
    { $concatArrays: [[{ value: 1 }], [{ value: 2 }]] },
  ])('documents принимает выражение массива документов $0', (value) => {
    expect(() => prepare({ aggregate: 1, pipeline: [{ $documents: value }], cursor: {} })).not.toThrow();
  });

  test.each([
    { documents: [-1, 1] },
    { documents: ['unbounded', 'current'] },
    { range: [-0.5, 0.5] },
    { range: [{ $numberDecimal: '-0.5' }, { $numberDouble: '0.5' }] },
    { range: ['unbounded', 'current'] },
    { range: [-1, 1], unit: 'hour' },
  ])('границы окна проверяются с учётом вида окна $0', (window) => {
    expect(() => prepare(windowQuery(window))).not.toThrow();
  });

  test('BOM и BSON Extended JSON сохраняются без потери точности', () => {
    const source =
      '\uFEFF' +
      JSON.stringify({
        find: 'orders',
        filter: {
          _id: { $oid: '507f1f77bcf86cd799439011' },
          number: { $numberLong: '9007199254740993' },
          createdAt: { $date: { $numberLong: '1234567890000' } },
        },
      });
    const prepared = prepareMongoRead(source);
    const command = preparedCommand(prepared);
    expect(prepared.originalQuery).toBe(source);
    expect(command.filter._id).toBeInstanceOf(BSON.ObjectId);
    expect(command.filter.number).toBeInstanceOf(BSON.Long);
    expect(command.filter.number.toString()).toBe('9007199254740993');
    expect(command.filter.createdAt).toBeInstanceOf(Date);
  });

  test('составной regex predicate сохраняет каждый оператор', () => {
    const prepared = prepare({ find: 'items', filter: { name: { $regex: '^a', $options: 'i', $ne: 'alice' } } });
    expect(preparedCommand(prepared).filter.name).toEqual({ $regex: '^a', $options: 'i', $ne: 'alice' });
  });

  test.each([
    { find: 'items', limit: { $numberInt: '4294967297' } },
    { find: 'items', limit: { $numberDecimal: '1e-999' } },
    { find: 'items', filter: { n: { $numberInt: '2147483648' } } },
    { find: 'items', filter: { n: { $numberLong: '9223372036854775808' } } },
    { find: 'items', filter: { n: { $numberInt: '1.5' } } },
    { find: 'items', filter: { n: { $numberLong: '0x10' } } },
  ])('неверный диапазон или тип EJSON отклоняется без усечения $0', (query) => {
    expect(() => prepare(query)).toThrow(ToolError);
  });

  test('обычное поле __proto__ сохраняется собственным полем документа', () => {
    const prepared = prepareMongoRead('{"find":"items","filter":{"payload":{"$eq":{"__proto__":{"value":"kept"}}}}}');
    const literal = preparedCommand(prepared).filter.payload.$eq;
    expect(Object.hasOwn(literal, '__proto__')).toBe(true);
    expect(literal.__proto__).toEqual({ value: 'kept' });
    expect(Object.getPrototypeOf(literal)).toBe(Object.prototype);
  });

  test('базы команд и режим курсора определены реестром', () => {
    expect(prepare({ listDatabases: 1 }).databaseMode).toBe('admin');
    expect(prepare({ ping: 1 }).databaseMode).toBe('selected-or-admin');
    expect(prepare({ find: 'orders' }).databaseMode).toBe('selected');
    expect(prepare({ aggregate: 'orders', pipeline: [], explain: true }).hasCursor).toBe(false);
    expect(prepare({ explain: { aggregate: 'orders', pipeline: [] } }).hasCursor).toBe(false);
  });

  test('лимиты различаются от batchSize и singleBatch', () => {
    expect(prepare({ find: 'orders', batchSize: 2 }).limit).toBeNull();
    expect(prepare({ find: 'orders', limit: 0 }).limit).toBeNull();
    expect(prepare({ find: 'orders', limit: 7, singleBatch: true })).toMatchObject({ limit: 7, singleBatch: true });
    const prepared = prepare({ aggregate: 'orders', pipeline: [{ $facet: { limited: [{ $limit: 2 }] } }], cursor: {} });
    expect(prepared.pipelineLimits).toEqual(['$.pipeline[0].$facet.limited[0].$limit']);
  });

  test('преобразования set и unset не являются записью', () => {
    expect(() =>
      prepare({
        aggregate: 'orders',
        pipeline: [{ $set: { calculated: { $add: ['$amount', 1] } } }, { $unset: ['internal'] }],
        cursor: {},
      }),
    ).not.toThrow();
  });

  test('буквальные документы не интерпретируются как скрипт или стадия', () => {
    expect(() =>
      prepare({
        aggregate: 'orders',
        pipeline: [
          {
            $project: {
              value: { $literal: { $out: 'archive', $where: 'text', $function: { body: 'text' } } },
              other: { $const: { $merge: 'archive' } },
            },
          },
        ],
        cursor: {},
      }),
    ).not.toThrow();
    expect(() => prepare({ find: 'orders', filter: { payload: { $eq: { $where: 'literal' } } } })).not.toThrow();
  });

  test('вложенные lookup unionWith и facet проверяются по стандартной форме', () => {
    expect(() =>
      prepare({
        aggregate: 'orders',
        pipeline: [
          {
            $lookup: {
              from: 'customers',
              let: { customer: '$customerId' },
              as: 'customers',
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$customer'] } } },
                { $facet: { values: [{ $unionWith: { coll: 'other', pipeline: [{ $project: { _id: 1 } }] } }] } },
              ],
            },
          },
        ],
        cursor: {},
      }),
    ).not.toThrow();
  });
});

describe('запись и исполняемый JavaScript блокируются до транспорта', () => {
  test.each(['$where', '$function', '$accumulator', '$out', '$merge'])(
    'новые формы выражений отклоняют вложенный исполняемый оператор %s',
    (operator) => {
      const unsafe = { [operator]: 'secret-script' };
      const queries = [
        aggregateExpression({ $setUnion: [unsafe] }),
        aggregateExpression({ $setIntersection: [unsafe] }),
        aggregateExpression({ $getField: unsafe }),
        aggregateExpression({ $getField: { $concat: ['amount', unsafe] } }),
        { aggregate: 1, pipeline: [{ $documents: unsafe }], cursor: {} },
        { aggregate: 1, pipeline: [{ $documents: { $concatArrays: [[{ value: unsafe }]] } }], cursor: {} },
      ];
      for (const query of queries) expect(() => prepare(query)).toThrow(ToolError);
    },
  );

  test.each([
    { $getField: { unknown: 'amount' } },
    { $getField: { field: 'amount', unknown: true } },
    { $getField: { $literal: 'amount', unknown: true } },
    { $getField: { $unknown: 'amount' } },
    { $setUnion: { $literal: ['amount'] } },
    { $setIntersection: { $literal: ['amount'] } },
  ])('неизвестная структура выражения остаётся запрещённой $0', (value) => {
    expect(() => prepare(aggregateExpression(value))).toThrow(ToolError);
  });

  test.each([
    { documents: [-0.5, 0.5] },
    { range: [-0.5, 0.5], unit: 'hour' },
    { range: [-1, 1], unit: 'unknown' },
    { documents: [-1, 1], unit: 'hour' },
    { documents: [-1, 1], range: [-1, 1] },
    { range: [-1, 1], unknown: true },
    { range: [-1] },
  ])('неверная структура окна отклоняется $0', (window) => {
    expect(() => prepare(windowQuery(window))).toThrow(ToolError);
  });

  test.each([
    'insert',
    'update',
    'delete',
    'findAndModify',
    'create',
    'drop',
    'dropDatabase',
    'createIndexes',
    'dropIndexes',
    'renameCollection',
    'mapReduce',
    'eval',
    'getMore',
    'killCursors',
    'setParameter',
  ])('отклонена команда %s', (command) => {
    expect(() => prepare({ [command]: 'orders' })).toThrow(ToolError);
  });

  const nestedPipelines = [
    (stage: unknown) => [stage],
    (stage: unknown) => [{ $lookup: { from: 'other', as: 'joined', pipeline: [stage] } }],
    (stage: unknown) => [{ $facet: { nested: [stage] } }],
    (stage: unknown) => [{ $unionWith: { coll: 'other', pipeline: [stage] } }],
    (stage: unknown) => [{ $facet: { nested: [{ $lookup: { from: 'other', as: 'joined', pipeline: [stage] } }] } }],
  ];

  test.each(['$out', '$merge', '$changeStream'])('отклонена стадия %s на каждой вложенности', (stage) => {
    for (const wrap of nestedPipelines) {
      expect(() => prepare({ aggregate: 'orders', pipeline: wrap({ [stage]: 'archive' }), cursor: {} })).toThrow(stage);
    }
  });

  test.each([
    { find: 'orders', filter: { $where: 'secret-script' } },
    { find: 'orders', filter: { items: { $elemMatch: { $where: 'secret-script' } } } },
    { find: 'orders', filter: { $expr: { $function: { body: 'secret-script', args: [], lang: 'js' } } } },
    {
      aggregate: 'orders',
      pipeline: [{ $group: { _id: null, count: { $accumulator: { init: 'secret-script' } } } }],
      cursor: {},
    },
    { explain: { delete: 'orders', deletes: [] } },
    { explain: { aggregate: 'orders', pipeline: [{ $out: 'archive' }] } },
  ])('отклонён исполняемый запрос $0', (query) => {
    expect(() => prepare(query)).toThrow(ToolError);
    try {
      prepare(query);
    } catch (cause) {
      expect((cause as Error).message).not.toContain('secret-script');
    }
  });

  test.each([
    { find: 'orders', typo: true },
    { find: 'orders', filter: { value: { $unknown: 1 } } },
    { find: 'orders', limit: -1 },
    { find: 'orders', limit: '10' },
    { find: 'orders', tailable: true },
    { find: 'orders', awaitData: true },
    { find: 'orders', batchSize: 1.5 },
    { aggregate: 'orders', pipeline: {} },
    { aggregate: 'orders', pipeline: [] },
    { aggregate: 'orders', pipeline: [{ $match: {}, $out: 'archive' }], cursor: {} },
    {
      aggregate: 'orders',
      pipeline: [{ $lookup: { from: 'other', as: 'joined', pipeline: [], unknown: 1 } }],
      cursor: {},
    },
    { aggregate: 'orders', pipeline: [{ $project: { value: { $cond: [true, 1] } } }], cursor: {} },
    { find: 'orders', insert: 'orders' },
    { comment: 'first', find: 'orders' },
  ])('отклонена неверная структура $0', (query) => {
    expect(() => prepare(query)).toThrow(ToolError);
  });

  test.each([
    'db.orders.find({})',
    '(() => db.orders.drop())()',
    '{}',
    '[]',
    '{"find":',
    '{"find":"orders","filter":{"_id":{"$oid":"broken"}}}',
  ])('отклонён неверный JSON или EJSON %s', (source) => {
    expect(() => prepareMongoRead(source)).toThrow(ToolError);
  });
});
