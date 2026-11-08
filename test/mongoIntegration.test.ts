import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BSON } from 'mongodb';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Client } from 'ssh2';
import { ToolError } from '../src/errors.ts';
import { executeMongoRead } from '../src/mongo/execute.ts';
import { prepareMongoRead, type PreparedMongoRead } from '../src/mongo/prepare.ts';
import { createMongoFixture, type MongoFixture } from './fixtures/mongoFixture.ts';

interface FixtureOrder {
  _id: number;
  status: string;
  customerId?: number;
  amount?: number;
  proofOfWritePrivilege?: boolean;
}

let fixture: MongoFixture;
const prepare = (query: unknown) => prepareMongoRead(JSON.stringify(query));
const executeFile = promisify(execFile);

beforeAll(async () => {
  fixture = await createMongoFixture();
  await fixture.control
    .db('investigation')
    .collection<FixtureOrder>('orders')
    .insertMany(
      Array.from({ length: 7 }, (_, index) => ({
        _id: index + 1,
        customerId: index % 2,
        status: 'failed',
        amount: index + 1,
      })),
    );
  await fixture.control.db('other').collection<FixtureOrder>('orders').insertOne({ _id: 100, status: 'other' });
  await fixture.control.db('investigation').command({ profile: 2, slowms: 0 });
}, 180000);

afterAll(async () => {
  await fixture?.close();
}, 60000);

test('обычная Node CLI читает MongoDB через искусственный профиль и сохраняет полный журнал', async () => {
  const configPath = join(fixture.directory, 'config.json');
  const profileDirectory = join(fixture.directory, 'profiles', 'fixture');
  const profilePath = join(profileDirectory, 'profile.json');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({ defaultProfile: 'fixture' }));
  await copyFile(fixture.target.credentialsFile, join(profileDirectory, 'credentials.json'));
  await writeFile(
    profilePath,
    JSON.stringify({
      servers: {
        ssh: { kind: 'ssh', ...fixture.target.ssh },
        mongodb: {
          kind: 'mongodb',
          uri: fixture.target.uri,
          sshServer: 'ssh',
          defaultDatabase: fixture.target.database,
        },
      },
      journal: { directory: join(fixture.directory, 'journal') },
    }),
  );
  const result = await executeFile(
    process.execPath,
    ['src/cli.ts', 'mongo', '--config', configPath, '--query', '{"find":"orders","batchSize":2}', '--json'],
    {
      env: {
        ...process.env,
        HOME: fixture.directory,
        USERPROFILE: fixture.directory,
        NO_UPDATE_NOTIFIER: '1',
        MONGODB_LOG_COMMAND: 'trace',
        MONGODB_LOG_PATH: 'stdout',
      },
    },
  );
  const response = JSON.parse(result.stdout);
  expect(response.ok).toBe(true);
  expect(response.data).toHaveLength(7);
  expect(response.echo.profile).toBe('fixture');
  expect(response.echo.database).toBe('investigation');
  expect(result.stderr).not.toContain('fixture-mongodb-password');
  const journal = JSON.parse(await readFile(response.echo.journal, 'utf8'));
  expect(journal.response.data).toEqual(response.data);
}, 30000);

test('полное чтение нескольких порций идёт через SSH и обнаруженные узлы replica set', async () => {
  const result = await executeMongoRead(fixture.target, prepare({ find: 'orders', sort: { _id: 1 }, batchSize: 2 }));
  expect(result.recordsReturned).toBe(7);
  expect(result.hitLimit).toBe(false);
  expect(result.limit).toBeNull();
  expect(result.data).toEqual(
    Array.from({ length: 7 }, (_, index) => ({
      _id: { $numberInt: String(index + 1) },
      customerId: { $numberInt: String(index % 2) },
      status: 'failed',
      amount: { $numberInt: String(index + 1) },
    })),
  );
  expect(fixture.forwarded.some((target) => target.host === 'mongo.example.invalid')).toBe(true);
  expect(new Set(fixture.forwarded.map((target) => target.port)).size).toBe(2);
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 30000);

test('последующие чтения, подсчёт, каталог и агрегация используют стандартные команды', async () => {
  const first = await executeMongoRead(fixture.target, prepare({ find: 'orders', filter: { _id: 1 }, limit: 1 }));
  expect(first.hitLimit).toBe(true);
  const count = await executeMongoRead(fixture.target, prepare({ count: 'orders', query: { customerId: 0 } }));
  expect(count.data).toMatchObject({ n: { $numberInt: '4' } });
  const aggregate = await executeMongoRead(
    fixture.target,
    prepare({
      aggregate: 'orders',
      pipeline: [{ $group: { _id: '$customerId', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      cursor: { batchSize: 1 },
    }),
  );
  expect(aggregate.recordsReturned).toBe(2);
  const collections = await executeMongoRead(
    fixture.target,
    prepare({ listCollections: 1, nameOnly: true, cursor: { batchSize: 1 } }),
  );
  expect(collections.data).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'orders' })]));
  const diagnostics = await executeMongoRead(
    fixture.target,
    prepare({ explain: { find: 'orders', filter: { _id: 1 } } }),
  );
  expect(diagnostics.data).toHaveProperty('queryPlanner');
}, 30000);

test.each([
  {
    name: 'MinKey',
    query: { find: 'orders', filter: { amount: { $type: -1 } } },
    expected: [],
  },
  {
    name: 'отрицательный limit count',
    query: { count: 'orders', limit: -1 },
    expected: { n: { $numberInt: '1' } },
  },
  {
    name: 'один аргумент setUnion',
    query: {
      aggregate: 'orders',
      pipeline: [{ $project: { _id: 0, value: { $setUnion: [['$status']] } } }],
      cursor: {},
    },
    expected: Array.from({ length: 7 }, () => ({ value: ['failed'] })),
  },
  {
    name: 'один аргумент setIntersection',
    query: {
      aggregate: 'orders',
      pipeline: [{ $project: { _id: 0, value: { $setIntersection: [['$status']] } } }],
      cursor: {},
    },
    expected: Array.from({ length: 7 }, () => ({ value: ['failed'] })),
  },
  {
    name: 'выражение documents',
    query: { aggregate: 1, pipeline: [{ $documents: { $literal: [{ amount: 1 }] } }], cursor: {} },
    expected: [{ amount: { $numberInt: '1' } }],
  },
  {
    name: 'сокращённое выражение getField',
    query: {
      aggregate: 'orders',
      pipeline: [{ $project: { _id: 0, value: { $getField: { $literal: 'status' } } } }],
      cursor: {},
    },
    expected: Array.from({ length: 7 }, () => ({ value: 'failed' })),
  },
  {
    name: 'дробные границы range',
    query: {
      aggregate: 'orders',
      pipeline: [
        {
          $setWindowFields: {
            sortBy: { amount: 1 },
            output: { total: { $sum: '$amount', window: { range: [-0.5, 0.5] } } },
          },
        },
        { $project: { _id: 0, total: 1 } },
      ],
      cursor: {},
    },
    expected: Array.from({ length: 7 }, (_, index) => ({ total: { $numberInt: String(index + 1) } })),
  },
])(
  'MongoDB выполняет стандартную форму $name через SSH',
  async ({ query, expected }) => {
    const result = await executeMongoRead(fixture.target, prepare(query));
    expect(result.data).toMatchObject(expected);
    if (Object.hasOwn(query, 'count')) {
      expect(result.limit).toBe(1);
      expect(result.hitLimit).toBe(true);
    }
  },
  15000,
);

test('BSON и служебно выглядящие имена полей сохраняются полностью', async () => {
  const document = {
    _id: new BSON.ObjectId('507f1f77bcf86cd799439011'),
    integer: BSON.Long.fromString('9007199254740993'),
    decimal: BSON.Decimal128.fromString('123456789.123456789'),
    regex: new BSON.BSONRegExp('hello', 'ix'),
    timestamp: new Date('2020-01-02T03:04:05.000Z'),
    binary: new BSON.Binary(Buffer.from([0, 1, 2, 255]), 0),
    record: { value: 'whole-document' },
    http: { status: 201 },
    environment: 'fictional',
  };
  const documents = [document, { ...document, _id: new BSON.ObjectId('507f1f77bcf86cd799439012') }];
  await fixture.control.db('investigation').collection('typed').insertMany(documents);
  const result = await executeMongoRead(
    fixture.target,
    prepare({ find: 'typed', filter: { _id: { $oid: document._id.toHexString() } } }),
  );
  expect(result.data).toEqual([BSON.EJSON.serialize(document, { relaxed: false })]);
  const distinct = await executeMongoRead(fixture.target, prepare({ distinct: 'typed', key: 'regex' }));
  expect(distinct.data).toMatchObject({
    values: [{ $regularExpression: { pattern: 'hello', options: 'ix' } }],
  });
  for (const query of [
    { find: 'typed', sort: { _id: 1 }, batchSize: 1 },
    { aggregate: 'typed', pipeline: [{ $sort: { _id: 1 } }], cursor: { batchSize: 1 } },
  ]) {
    const batches = await executeMongoRead(fixture.target, prepare(query));
    expect(batches.data).toEqual(documents.map((item) => BSON.EJSON.serialize(item, { relaxed: false })));
  }
}, 15000);

test('regex вместе с ne сохраняет условия при реальном чтении MongoDB', async () => {
  await fixture.control
    .db('investigation')
    .collection('names')
    .insertMany([{ name: 'alice' }, { name: 'adam' }, { name: 'bob' }]);
  const result = await executeMongoRead(
    fixture.target,
    prepare({
      find: 'names',
      filter: { name: { $regex: '^a', $options: 'i', $ne: 'alice' } },
      projection: { _id: 0, name: 1 },
    }),
  );
  expect(result.data).toEqual([{ name: 'adam' }]);
}, 15000);

test('реальная агрегация возвращает поле _bsontype без конфликта с типами драйвера', async () => {
  const result = await executeMongoRead(
    fixture.target,
    prepare({
      aggregate: 'orders',
      pipeline: [
        { $limit: 1 },
        { $project: { _id: 0, _bsontype: { $literal: 'Invoice' }, value: { $literal: 'kept' } } },
      ],
      cursor: {},
    }),
  );
  expect(result.data).toEqual([{ _bsontype: 'Invoice', value: 'kept' }]);
}, 15000);

test('параллельные вызовы изолируют базы и закрывают собственные подключения', async () => {
  const [first, second] = await Promise.all([
    executeMongoRead(fixture.target, prepare({ find: 'orders', batchSize: 1 })),
    executeMongoRead({ ...fixture.target, database: 'other' }, prepare({ find: 'orders', batchSize: 1 })),
  ]);
  expect(first.recordsReturned).toBe(7);
  expect(second.recordsReturned).toBe(1);
  expect(second.data).toEqual([{ _id: { $numberInt: '100' }, status: 'other' }]);
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 30000);

test('учётная запись с правом записи не обходит запрет инструмента', async () => {
  const collection = fixture.control.db('investigation').collection<FixtureOrder>('orders');
  const changed = await collection.updateOne({ _id: 1 }, { $set: { proofOfWritePrivilege: true } });
  expect(changed.modifiedCount).toBe(1);
  const before = await collection.find().sort({ _id: 1 }).toArray();
  const indexesBefore = await collection.listIndexes().toArray();
  const openedBefore = fixture.connectionsOpened();
  const observed = fixture.control.db('investigation').collection('system.profile');
  const commandsBefore = await observed.countDocuments({ appName: 'tt-stand' });
  const denied = [
    { insert: 'orders', documents: [{ _id: 999 }] },
    { update: 'orders', updates: [{ q: {}, u: { $set: { changed: true } }, multi: true }] },
    { delete: 'orders', deletes: [{ q: {}, limit: 0 }] },
    { drop: 'orders' },
    {
      aggregate: 'orders',
      pipeline: [
        { $facet: { nested: [{ $lookup: { from: 'orders', as: 'joined', pipeline: [{ $merge: 'orders' }] } }] } },
      ],
      cursor: {},
    },
    {
      aggregate: 'orders',
      pipeline: [{ $unionWith: { coll: 'orders', pipeline: [{ $out: 'archive' }] } }],
      cursor: {},
    },
    { explain: { update: 'orders', updates: [] } },
    { find: 'orders', filter: { $where: 'return true' } },
  ];
  for (const query of denied) {
    await expect((async () => executeMongoRead(fixture.target, prepare(query)))()).rejects.toMatchObject({
      errorClass: 'bad_request',
    });
  }
  expect(fixture.connectionsOpened()).toBe(openedBefore);
  expect(await observed.countDocuments({ appName: 'tt-stand' })).toBe(commandsBefore);
  expect(await collection.find().sort({ _id: 1 }).toArray()).toEqual(before);
  expect(await collection.listIndexes().toArray()).toEqual(indexesBefore);
  const transformed = await executeMongoRead(
    fixture.target,
    prepare({
      aggregate: 'orders',
      pipeline: [{ $set: { transient: true } }, { $unset: 'proofOfWritePrivilege' }],
      cursor: {},
    }),
  );
  expect(transformed.recordsReturned).toBe(7);
  expect(await collection.find().sort({ _id: 1 }).toArray()).toEqual(before);
}, 30000);

test('singleBatch сообщает о намеренно ограниченной порции', async () => {
  const result = await executeMongoRead(fixture.target, prepare({ find: 'orders', batchSize: 2, singleBatch: true }));
  expect(result.recordsReturned).toBe(2);
  expect(result.incompleteReasons.join(' ')).toContain('singleBatch');
}, 15000);

test('ошибка следующей порции возвращает уже полученные документы', async () => {
  await fixture.control.db('admin').command({
    configureFailPoint: 'failCommand',
    mode: { times: 1 },
    data: { failCommands: ['getMore'], errorCode: 43 },
  });
  await expect(executeMongoRead(fixture.target, prepare({ find: 'orders', batchSize: 2 }))).rejects.toMatchObject({
    errorClass: 'mongo_query_failed',
    partialPayload: { records: expect.any(Array) },
  });
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 15000);

test.each([
  { code: 13, errorClass: 'mongo_access_forbidden' },
  { code: 18, errorClass: 'mongo_auth_failed' },
  { code: 50, errorClass: 'timeout_client' },
  { code: 2, errorClass: 'mongo_query_failed' },
])(
  'код BSON.Int32 $code из MongoDB сохраняет класс $errorClass',
  async ({ code, errorClass }) => {
    const failCommand = {
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], errorCode: code },
    };
    await fixture.control.db('admin').command(failCommand);
    await expect(
      fixture.control.db('investigation').command({ find: 'orders' }, { promoteValues: false }),
    ).rejects.toMatchObject({ code: new BSON.Int32(code) });
    await fixture.control.db('admin').command({
      ...failCommand,
      data: { ...failCommand.data, appName: 'tt-stand' },
    });
    const outcome = executeMongoRead(fixture.target, prepare({ find: 'orders' }));
    await expect(outcome).rejects.toMatchObject({ errorClass });
    if (code === 2) await expect(outcome).rejects.toThrow('Код MongoDB 2.');
    await expect.poll(() => fixture.connections.size).toBe(0);
  },
  15000,
);

test('общий таймаут освобождает SSH и сохраняет первую порцию', async () => {
  await fixture.control.db('admin').command({
    configureFailPoint: 'failCommand',
    mode: { times: 1 },
    data: { failCommands: ['getMore'], blockConnection: true, blockTimeMS: 3000 },
  });
  await expect(
    executeMongoRead({ ...fixture.target, timeoutSeconds: 1.5 }, prepare({ find: 'orders', batchSize: 2 })),
  ).rejects.toMatchObject({
    errorClass: 'timeout_client',
    partialPayload: { records: expect.any(Array) },
  });
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 15000);

test('неверный host key отклоняется до MongoDB', async () => {
  const wrongHosts = join(fixture.directory, 'wrong_known_hosts');
  await writeFile(
    wrongHosts,
    `[127.0.0.1]:${fixture.target.ssh.port} ssh-rsa ${Buffer.from('wrong').toString('base64')}`,
  );
  const forwardedBefore = fixture.forwarded.length;
  await expect(
    executeMongoRead(
      { ...fixture.target, ssh: { ...fixture.target.ssh, knownHostsPath: wrongHosts } },
      prepare({ ping: 1 }),
    ),
  ).rejects.toMatchObject({ errorClass: 'ssh_host_key_invalid' });
  expect(fixture.forwarded.length).toBe(forwardedBefore);
}, 15000);

test('ошибка аутентификации не раскрывает пароль или ключ', async () => {
  const credentialsFile = join(fixture.directory, 'wrong_credentials.json');
  const secret = 'fixture-wrong-password-that-must-not-escape';
  await writeFile(
    credentialsFile,
    JSON.stringify({ mongodb: { username: 'fixture-reader-with-write-access', password: secret } }),
  );
  try {
    await executeMongoRead({ ...fixture.target, credentialsFile }, prepare({ ping: 1 }));
    throw new Error('Ожидался отказ аутентификации');
  } catch (cause) {
    expect(cause).toBeInstanceOf(ToolError);
    expect(cause).toMatchObject({ errorClass: 'mongo_auth_failed' });
    expect(JSON.stringify(cause)).not.toContain(secret);
    expect(String(cause)).not.toContain(await readFile(fixture.target.ssh.privateKeyPath, 'utf8'));
  }
}, 15000);

test('непроверенный объект и отменённый вызов не читают секреты и не открывают SSH', async () => {
  const opened = fixture.connectionsOpened();
  const inaccessible = { ...fixture.target, credentialsFile: join(fixture.directory, 'missing.json') };
  await expect(executeMongoRead(inaccessible, {} as PreparedMongoRead)).rejects.toMatchObject({
    errorClass: 'bad_request',
  });
  await expect(
    executeMongoRead(inaccessible, prepare({ ping: 1 }), { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ errorClass: 'stream_aborted' });
  expect(fixture.connectionsOpened()).toBe(opened);
});

test('синхронный отказ forwardOut возвращает безопасную ошибку и закрывает соединение', async () => {
  const forward = vi.spyOn(Client.prototype, 'forwardOut').mockImplementation(() => {
    throw new Error('secret-disconnected');
  });
  try {
    await expect(executeMongoRead(fixture.target, prepare({ ping: 1 }))).rejects.toMatchObject({
      errorClass: 'ssh_connection_failed',
    });
  } finally {
    forward.mockRestore();
  }
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 15000);

test('отмена закрывает noCursorTimeout курсор через живой SSH', async () => {
  const profiles = fixture.control.db('investigation').collection('system.profile');
  const closedBefore = await profiles.countDocuments({ 'command.killCursors': 'orders', appName: 'tt-stand' });
  await fixture.control.db('admin').command({
    configureFailPoint: 'failCommand',
    mode: { times: 1 },
    data: { failCommands: ['getMore'], blockConnection: true, blockTimeMS: 3000 },
  });
  const cancelled = new AbortController();
  const timer = setTimeout(() => cancelled.abort(), 1000);
  try {
    await expect(
      executeMongoRead(
        fixture.target,
        prepare({
          find: 'orders',
          batchSize: 2,
          noCursorTimeout: true,
          comment: 'fixture-cancel-cursor',
        }),
        { signal: cancelled.signal },
      ),
    ).rejects.toMatchObject({ errorClass: 'stream_aborted' });
  } finally {
    clearTimeout(timer);
  }
  expect(await profiles.countDocuments({ 'command.killCursors': 'orders', appName: 'tt-stand' })).toBeGreaterThan(
    closedBefore,
  );
  await expect.poll(() => fixture.connections.size).toBe(0);
}, 15000);
