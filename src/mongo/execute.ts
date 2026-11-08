import {
  MongoClient,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoOperationTimeoutError,
  MongoParseError,
  MongoServerError,
  type RunCommandCursor,
} from 'mongodb';
import { readServerCredentials } from '../credentials.ts';
import { ToolError } from '../errors.ts';
import { type MongoAccess } from '../profile.ts';
import { abortable } from './cancellation.ts';
import { canonicalMongoValue } from './ejson.ts';
import { preparedCommand, type PreparedMongoRead } from './prepare.ts';
import { openSshTunnel, type SshTunnel } from './tunnel.ts';
import { isDocument, numericValue } from './validation.ts';

export interface MongoReadOutcome {
  readonly data: unknown;
  readonly recordsReturned: number;
  readonly limit: number | null;
  readonly hitLimit: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly incompleteReasons: string[];
}

function safeError(cause: unknown, signal: AbortSignal): ToolError {
  if (signal.aborted) {
    if (signal.reason instanceof ToolError) return signal.reason;
    return new ToolError('stream_aborted', 'Получение данных MongoDB отменено.');
  }
  if (cause instanceof ToolError) return cause;
  if (cause instanceof MongoParseError)
    return new ToolError(
      'config_invalid',
      'Некорректные параметры URI MongoDB. Проверьте поле uri выбранного сервера.',
    );
  if (cause instanceof MongoNetworkTimeoutError || cause instanceof MongoOperationTimeoutError) {
    return new ToolError('timeout_client', 'Истёк таймаут чтения MongoDB.');
  }
  if (cause instanceof MongoNetworkError) {
    return new ToolError('stream_aborted', 'Получение данных MongoDB прервано из-за обрыва соединения.');
  }
  if (cause instanceof MongoServerError) {
    const code = numericValue(canonicalMongoValue(cause.code));
    if (code === 18) return new ToolError('mongo_auth_failed', 'MongoDB отклонила аутентификацию.');
    if (code === 13)
      return new ToolError('mongo_access_forbidden', 'У учётной записи недостаточно прав для этого чтения MongoDB.');
    if (code === 50) return new ToolError('timeout_client', 'MongoDB прервала чтение по maxTimeMS.');
    const detail = Number.isSafeInteger(code) ? ` Код MongoDB ${code}.` : '';
    return new ToolError('mongo_query_failed', `MongoDB отклонила читающую команду.${detail}`);
  }
  return new ToolError(
    'mongo_query_failed',
    'Не удалось выполнить чтение MongoDB. Проверьте подключение и параметры команды.',
  );
}

function mongoClient(target: MongoAccess, tunnel: SshTunnel): MongoClient {
  const credentials = readServerCredentials(target.credentialsFile, target.serverName, target.profileName, 'mongodb');
  const username = credentials.username;
  const password = credentials.password;
  if (password && !username)
    throw new ToolError(
      'credentials_incomplete',
      'Для пароля MongoDB требуется имя пользователя в записи сервера credentials.json.',
    );
  return new MongoClient(target.uri, {
    proxyHost: tunnel.proxyHost,
    proxyPort: tunnel.proxyPort,
    proxyUsername: tunnel.proxyUsername,
    proxyPassword: tunnel.proxyPassword,
    auth: username ? { username, password } : undefined,
    connectTimeoutMS: target.timeoutSeconds * 1000,
    serverSelectionTimeoutMS: target.timeoutSeconds * 1000,
    socketTimeoutMS: target.timeoutSeconds * 1000,
    promoteValues: false,
    bsonRegExp: true,
    monitorCommands: true,
    mongodbLogComponentSeverities: {
      default: 'off',
      command: 'off',
      topology: 'off',
      serverSelection: 'off',
      connection: 'off',
      client: 'off',
    },
    appName: 'tt-stand',
  });
}

async function connectMongo(client: MongoClient, signal: AbortSignal): Promise<void> {
  const opening = (): void => signal.throwIfAborted();
  client.on('topologyOpening', opening);
  try {
    signal.throwIfAborted();
    await client.connect();
  } finally {
    client.off('topologyOpening', opening);
    if (signal.aborted) await client.close(true).catch(() => undefined);
  }
}

function returnedRecords(data: unknown, prepared: PreparedMongoRead): number {
  if (Array.isArray(data)) return data.length;
  if (isDocument(data) && Array.isArray(data.values)) return data.values.length;
  if (isDocument(data) && Array.isArray(data.databases)) return data.databases.length;
  return prepared.hasCursor ? 0 : 1;
}

function incompleteReasons(prepared: PreparedMongoRead, serverPartial: boolean): string[] {
  const reasons: string[] = [];
  if (prepared.singleBatch) reasons.push('singleBatch ограничил ответ одной порцией MongoDB');
  if (serverPartial) reasons.push('MongoDB пометила порцию ответа partialResultsReturned');
  if (prepared.pipelineLimits.length > 0)
    reasons.push(`pipeline содержит явное ограничение числа документов в ${prepared.pipelineLimits.join(', ')}`);
  return reasons;
}

function limitReached(data: unknown, prepared: PreparedMongoRead, recordsReturned: number): boolean {
  if (prepared.limit === null) return false;
  if (prepared.name === 'count' && isDocument(data)) return numericValue(data.n) >= prepared.limit;
  return prepared.hasCursor && recordsReturned >= prepared.limit;
}

async function closeResources(
  client: MongoClient | undefined,
  cursor: RunCommandCursor | undefined,
  tunnel: SshTunnel | undefined,
  timeoutSeconds: number,
): Promise<void> {
  if (tunnel?.signal.aborted) await tunnel.close();
  const cleanup = (async () => {
    await cursor?.close().catch(() => undefined);
    await client?.close(true).catch(() => undefined);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutSeconds * 1000);
  });
  try {
    await Promise.race([cleanup, timeout]);
  } finally {
    clearTimeout(timer);
    await tunnel?.close();
  }
}

export async function executeMongoRead(
  target: MongoAccess,
  prepared: PreparedMongoRead,
  options: { signal?: AbortSignal } = {},
): Promise<MongoReadOutcome> {
  const command = preparedCommand(prepared);
  const startedAt = new Date().toISOString();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new ToolError('timeout_client', 'Истёк общий таймаут чтения MongoDB.')),
    target.timeoutSeconds * 1000,
  );
  const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
  let operationSignal = signal;
  let tunnel: SshTunnel | undefined;
  let client: MongoClient | undefined;
  let cursor: RunCommandCursor | undefined;
  const records: unknown[] = [];
  let serverPartial = false;
  try {
    signal.throwIfAborted();
    const ssh = readServerCredentials(target.credentialsFile, target.sshServerName, target.profileName, 'ssh');
    tunnel = await openSshTunnel(target, ssh.passphrase, signal);
    operationSignal = AbortSignal.any([signal, tunnel.signal]);
    client = mongoClient(target, tunnel);
    client.on('commandSucceeded', (event) => {
      const reply: unknown = event.reply;
      if (
        isDocument(reply) &&
        (reply.partialResultsReturned === true ||
          (isDocument(reply.cursor) && reply.cursor.partialResultsReturned === true))
      )
        serverPartial = true;
    });
    const connected = client;
    const operation = (async (): Promise<unknown> => {
      await connectMongo(connected, operationSignal);
      operationSignal.throwIfAborted();
      const database = connected.db(target.database);
      if (!prepared.hasCursor) {
        return canonicalMongoValue(await database.command(command, { promoteValues: false, bsonRegExp: true }));
      }
      cursor = database.runCursorCommand(command, { promoteValues: false, bsonRegExp: true });
      if (prepared.batchSize !== null) cursor.setBatchSize(prepared.batchSize);
      for await (const document of cursor) {
        operationSignal.throwIfAborted();
        records.push(canonicalMongoValue(document));
      }
      return records;
    })();
    const data = await abortable(operation, operationSignal);
    const recordsReturned = returnedRecords(data, prepared);
    return {
      data,
      recordsReturned,
      limit: prepared.limit,
      hitLimit: limitReached(data, prepared, recordsReturned),
      startedAt,
      finishedAt: new Date().toISOString(),
      incompleteReasons: incompleteReasons(prepared, serverPartial),
    };
  } catch (cause) {
    const error = safeError(cause, operationSignal);
    const partialRecords = [...records];
    throw new ToolError(
      error.errorClass,
      error.message,
      partialRecords.length ? { records: partialRecords } : undefined,
      {
        profile: target.profileName,
        server: target.serverName,
        database: target.database,
        query: prepared.originalQuery,
        startedAt,
        finishedAt: new Date().toISOString(),
        limit: prepared.limit,
        recordsReturned: partialRecords.length,
      },
    );
  } finally {
    clearTimeout(timer);
    await closeResources(client, cursor, tunnel, target.timeoutSeconds);
  }
}
