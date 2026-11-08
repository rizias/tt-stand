import { beforeEach, expect, test, vi } from 'vitest';
import { BSON, MongoNetworkError, MongoServerError, type BSONSerializeOptions } from 'mongodb';
import { failureResponse } from '../src/cli/failure.ts';
import { INCOMPLETENESS_REASONS } from '../src/errors.ts';
import { executeMongoRead } from '../src/mongo/execute.ts';
import { prepareMongoRead } from '../src/mongo/prepare.ts';
import { type MongoAccess } from '../src/profile.ts';

const state = vi.hoisted(() => ({
  reply: {} as Record<string, unknown>,
  documents: [] as unknown[],
  failure: undefined as unknown,
  commandResult: {} as Record<string, unknown>,
  commandWire: undefined as Uint8Array | undefined,
  clientOptions: {} as Record<string, unknown>,
  wireDocuments: [] as Uint8Array[],
  afterDocuments: undefined as (() => Promise<unknown>) | undefined,
  clientClosed: vi.fn(async () => undefined),
  cursorClosed: vi.fn(async () => undefined),
  tunnelClosed: vi.fn(async () => undefined),
  openTunnel: vi.fn(),
}));

vi.mock('../src/credentials.ts', () => ({ readServerCredentials: () => ({}) }));
vi.mock('../src/mongo/tunnel.ts', () => ({
  openSshTunnel: async () => {
    state.openTunnel();
    return {
      proxyHost: '127.0.0.1',
      proxyPort: 1,
      proxyUsername: 'fixture',
      proxyPassword: 'fixture',
      signal: new AbortController().signal,
      close: state.tunnelClosed,
    };
  },
}));
vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    MongoClient: class extends EventEmitter {
      constructor(_uri: string, options: Record<string, unknown>) {
        super();
        state.clientOptions = options;
      }
      async connect(): Promise<void> {
        this.emit('topologyOpening');
        await Promise.resolve();
      }
      close = state.clientClosed;
      db(): unknown {
        this.emit('commandSucceeded', { reply: state.reply });
        return {
          command: async (_command: unknown, options: BSONSerializeOptions) =>
            state.commandWire ? actual.BSON.deserialize(state.commandWire, options) : state.commandResult,
          runCursorCommand: (_command: unknown, options: BSONSerializeOptions) => ({
            setBatchSize: () => undefined,
            close: state.cursorClosed,
            async *[Symbol.asyncIterator]() {
              for (const document of state.documents) yield document;
              for (const wire of state.wireDocuments) {
                yield actual.BSON.deserialize(wire, options);
              }
              if (state.afterDocuments) yield await state.afterDocuments();
              if (state.failure) throw state.failure;
            },
          }),
        };
      }
    },
  };
});

const target: MongoAccess = {
  profileName: 'fixture',
  serverName: 'mongodb',
  database: 'fixture',
  uri: 'mongodb://example.invalid',
  credentialsFile: 'unused',
  sshServerName: 'ssh',
  timeoutSeconds: 1,
  ssh: {
    host: 'example.invalid',
    port: 22,
    username: 'fixture',
    privateKeyPath: 'unused',
    knownHostsPath: 'unused',
    timeoutSeconds: 1,
  },
};

beforeEach(() => {
  state.reply = {};
  state.documents = [];
  state.failure = undefined;
  state.commandResult = {};
  state.commandWire = undefined;
  state.clientOptions = {};
  state.wireDocuments = [];
  state.afterDocuments = undefined;
  vi.clearAllMocks();
});

test.each([{ partialResultsReturned: true }, { cursor: { partialResultsReturned: true } }])(
  'частичный ответ сервера отмечается без allowPartialResults $0',
  async (reply) => {
    state.reply = reply;
    state.documents = [{ value: BSON.Long.fromString('9007199254740993') }];
    const result = await executeMongoRead(target, prepareMongoRead('{"find":"orders"}'));
    expect(result.incompleteReasons.join(' ')).toContain('partialResultsReturned');
    expect(result.data).toEqual([{ value: { $numberLong: '9007199254740993' } }]);
    expect(state.cursorClosed).toHaveBeenCalledOnce();
    expect(state.clientClosed).toHaveBeenCalledOnce();
    expect(state.tunnelClosed).toHaveBeenCalledOnce();
  },
);

test.each(
  [
    { code: 13, errorClass: 'mongo_access_forbidden' },
    { code: 18, errorClass: 'mongo_auth_failed' },
    { code: 50, errorClass: 'timeout_client' },
    { code: 2, errorClass: 'mongo_query_failed' },
  ].flatMap((item) => [
    { ...item, promoteValues: true },
    { ...item, promoteValues: false },
  ]),
)(
  'ошибка MongoDB $code с promoteValues=$promoteValues скрывает секреты и сохраняет данные',
  async ({ code, errorClass, promoteValues }) => {
    state.documents = [{ value: 'received' }];
    const response = BSON.deserialize(BSON.serialize({ code, errmsg: 'secret-from-upstream-password' }), {
      promoteValues,
    });
    state.failure = new MongoServerError(response);
    try {
      await executeMongoRead(target, prepareMongoRead('{"find":"orders"}'));
      throw new Error('Ожидался отказ');
    } catch (cause) {
      expect(cause).toMatchObject({
        errorClass,
        partialPayload: { records: [{ value: 'received' }] },
      });
      expect(String(cause)).not.toContain('secret-from-upstream-password');
      if (code === 2) expect(String(cause)).toContain('Код MongoDB 2.');
    }
    expect(state.cursorClosed).toHaveBeenCalledOnce();
    expect(state.clientClosed).toHaveBeenCalledOnce();
    expect(state.tunnelClosed).toHaveBeenCalledOnce();
  },
);

test.each([
  { limit: 3, count: 3, expectedLimit: 3, hitLimit: true },
  { limit: -3, count: 3, expectedLimit: 3, hitLimit: true },
  { limit: -10, count: 3, expectedLimit: 10, hitLimit: false },
  { limit: -1, count: 0, expectedLimit: 1, hitLimit: false },
  { limit: 0, count: 3, expectedLimit: null, hitLimit: false },
])(
  'limit=$limit команды count проверяется по числу совпадений $count',
  async ({ limit, count, expectedLimit, hitLimit }) => {
    state.commandResult = { n: new BSON.Int32(count), ok: new BSON.Int32(1) };
    const result = await executeMongoRead(target, prepareMongoRead(JSON.stringify({ count: 'orders', limit })));
    expect(result.recordsReturned).toBe(1);
    expect(result.limit).toBe(expectedLimit);
    expect(result.hitLimit).toBe(hitLimit);
  },
);

test('поля _bsontype и __proto__ являются данными результата', async () => {
  state.documents = [JSON.parse('{"_bsontype":"Invoice","value":"kept","__proto__":{"nested":1}}')];
  const result = await executeMongoRead(target, prepareMongoRead('{"find":"orders"}'));
  expect(result.data).toEqual([
    JSON.parse('{"_bsontype":"Invoice","value":"kept","__proto__":{"nested":{"$numberInt":"1"}}}'),
  ]);
});

test('явный limit стадии vectorSearch отражается в неполноте ответа', async () => {
  state.documents = [{ value: 'first' }, { value: 'second' }];
  const vectorSearch = {
    $vectorSearch: { index: 'fixture', path: 'embedding', queryVector: [1, 2], numCandidates: 10, limit: 2 },
  };
  const cases = [
    { pipeline: [vectorSearch], path: '$.pipeline[0].$vectorSearch.limit' },
    {
      pipeline: [{ $unionWith: { coll: 'other', pipeline: [vectorSearch] } }],
      path: '$.pipeline[0].$unionWith.pipeline[0].$vectorSearch.limit',
    },
  ];
  for (const { pipeline, path } of cases) {
    const prepared = prepareMongoRead(JSON.stringify({ aggregate: 'orders', pipeline, cursor: {} }));
    const result = await executeMongoRead(target, prepared);
    expect(result.recordsReturned).toBe(2);
    expect(result.data).toEqual(state.documents);
    expect(result.incompleteReasons).toEqual([`pipeline содержит явное ограничение числа документов в ${path}`]);
  }
});

test('дата вне диапазона JavaScript даёт ошибку вместо повреждённого Extended JSON', async () => {
  state.documents = [{ value: 'received' }, { date: new Date(Number.NaN) }];
  await expect(executeMongoRead(target, prepareMongoRead('{"find":"orders"}'))).rejects.toMatchObject({
    errorClass: 'mongo_query_failed',
    partialPayload: { records: [{ value: 'received' }] },
  });
});

test('клиент и курсор закрываются до остановки SSH', async () => {
  state.failure = new Error('connection failed');
  await expect(executeMongoRead(target, prepareMongoRead('{"find":"orders"}'))).rejects.toMatchObject({
    errorClass: 'mongo_query_failed',
  });
  expect(state.clientClosed.mock.invocationCallOrder[0]).toBeLessThan(state.tunnelClosed.mock.invocationCallOrder[0]!);
  expect(state.cursorClosed.mock.invocationCallOrder[0]).toBeLessThan(state.tunnelClosed.mock.invocationCallOrder[0]!);
});

test('поздняя порция при отмене не меняет снимок данных и число записей в эхе', async () => {
  const cancelled = new AbortController();
  let releaseLateBatch: (document: unknown) => void = () => undefined;
  const lateBatch = new Promise<unknown>((resolve) => {
    releaseLateBatch = resolve;
  });
  state.documents = [{ value: 'received' }];
  state.afterDocuments = async () => {
    cancelled.abort();
    return lateBatch;
  };
  state.cursorClosed.mockImplementationOnce(async () => {
    releaseLateBatch({ value: 'late' });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await expect(
    executeMongoRead(target, prepareMongoRead('{"find":"orders"}'), {
      signal: cancelled.signal,
    }),
  ).rejects.toMatchObject({
    errorClass: 'stream_aborted',
    partialPayload: { records: [{ value: 'received' }] },
    echo: { recordsReturned: 1 },
  });
  expect(state.cursorClosed).toHaveBeenCalledOnce();
  expect(state.clientClosed).toHaveBeenCalledOnce();
  expect(state.tunnelClosed).toHaveBeenCalledOnce();
});

test('изменение копии внутренней команды не меняет проверенный запрос', async () => {
  const { preparedCommand } = await import('../src/mongo/prepare.ts');
  const prepared = prepareMongoRead('{"find":"orders","filter":{"state":"original"}}');
  const command = preparedCommand(prepared);
  command.find = 'changed';
  command.filter.state = 'changed';
  expect(preparedCommand(prepared)).toMatchObject({ find: 'orders', filter: { state: 'original' } });
  expect(Object.isFrozen(prepared)).toBe(true);
});

test('BSON regex и Undefined сохраняют исходный тип из бинарного ответа', async () => {
  state.wireDocuments = [
    BSON.serialize({ value: new BSON.BSONRegExp('hello', 'ix') }),
    Buffer.from('0c0000000676616c75650000', 'hex'),
  ];
  const result = await executeMongoRead(target, prepareMongoRead('{"find":"orders"}'));
  expect(result.data).toEqual([
    { value: { $regularExpression: { pattern: 'hello', options: 'ix' } } },
    { value: { $undefined: true } },
  ]);
});

test('команда без курсора получает собственные BSON-настройки для regex', async () => {
  state.commandWire = BSON.serialize({ values: [new BSON.BSONRegExp('hello', 'ix')] });
  const result = await executeMongoRead(target, prepareMongoRead('{"distinct":"orders","key":"pattern"}'));
  expect(state.clientOptions.bsonRegExp).toBe(true);
  expect(result.data).toEqual({ values: [{ $regularExpression: { pattern: 'hello', options: 'ix' } }] });
});

test('неоднозначный DBPointer даёт ошибку с уже полученными документами', async () => {
  state.documents = [{ value: 'received' }];
  state.wireDocuments = [Buffer.from('230000000c76616c756500070000006f726465727300507f1f77bcf86cd79943901100', 'hex')];
  await expect(executeMongoRead(target, prepareMongoRead('{"find":"orders"}'))).rejects.toMatchObject({
    errorClass: 'mongo_query_failed',
    partialPayload: { records: [{ value: 'received' }] },
  });
});

test('обрыв сети после порции возвращает stream_aborted и сохраняет документы', async () => {
  state.documents = [{ value: 'received' }];
  state.failure = new MongoNetworkError('synthetic connection closed');
  await expect(executeMongoRead(target, prepareMongoRead('{"find":"orders"}'))).rejects.toMatchObject({
    errorClass: 'stream_aborted',
    partialPayload: { records: [{ value: 'received' }] },
  });
});

test('таймаут до первого документа отмечает прерывание', async () => {
  state.afterDocuments = () => new Promise(() => undefined);
  const error = await executeMongoRead({ ...target, timeoutSeconds: 0.01 }, prepareMongoRead('{"find":"orders"}')).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  const response = failureResponse(error, 'mongo');
  expect(response.errorClass).toBe('timeout_client');
  expect(response.echo.recordsReturned).toBe(0);
  expect(response.incompleteReasons).toEqual([INCOMPLETENESS_REASONS.commandInterrupted]);
});

test.each([
  { aggregate: 'orders', pipeline: [{ $limit: 2 }], explain: true },
  { explain: { aggregate: 'orders', pipeline: [{ $limit: 2 }] } },
])('полный explain не помечается неполным из-за стадии limit $0', async (query) => {
  state.commandResult = { queryPlanner: { fixture: true } };
  const result = await executeMongoRead(target, prepareMongoRead(JSON.stringify(query)));
  expect(result.incompleteReasons).toEqual([]);
  expect(result.hitLimit).toBe(false);
});
