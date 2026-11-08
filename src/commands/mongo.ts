import type { ParsedValues } from '../cli/args.ts';
import { INCOMPLETENESS_REASONS, ToolError } from '../errors.ts';
import { executeMongoRead } from '../mongo/execute.ts';
import { prepareMongoRead, type PreparedMongoRead } from '../mongo/prepare.ts';
import { requireMongo, type MongoAccess, type Profile } from '../profile.ts';
import { resolveActiveProfile } from '../profiles.ts';
import { resolveQuery } from '../queryFile.ts';
import { ECHO_CONSTANTS, localEcho, type Echo, type ToolResponse } from '../response.ts';

function mongoTarget(profile: Profile, prepared: PreparedMongoRead, values: ParsedValues): MongoAccess {
  if (prepared.databaseMode === 'admin') {
    if (values.database !== undefined && values.database !== 'admin') {
      throw new ToolError('bad_request', 'Команда listDatabases выполняется в базе admin.');
    }
    return requireMongo(profile, values.server, 'admin');
  }
  const fallback = prepared.databaseMode === 'selected-or-admin' ? 'admin' : undefined;
  return requireMongo(profile, values.server, values.database, fallback);
}

export async function runMongoCommand(
  values: ParsedValues,
  loadProfile = (): Profile => resolveActiveProfile(values.config, values.profile ?? null),
): Promise<ToolResponse> {
  const echo: Echo = {
    ...localEcho('mongo'),
    startedAt: new Date().toISOString(),
    namespaceScope: null,
    recordsOutOfScope: 0,
  };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const resolved = resolveQuery(values.query, values['query-file']);
    echo.query = resolved.query;
    echo.queryFile = resolved.queryFile;
    if (resolved.query === null) {
      throw new ToolError('bad_request', 'Передайте документ команды MongoDB через --query или --query-file.');
    }
    const prepared = prepareMongoRead(resolved.query);
    const profile = loadProfile();
    echo.profile = profile.name;
    const target = mongoTarget(profile, prepared, values);
    Object.assign(echo, {
      server: target.serverName,
      database: target.database,
      request: prepared.name,
      datasource: 'mongodb',
      order: ECHO_CONSTANTS.order,
      limit: prepared.limit,
      limitNote: prepared.limit === null ? ECHO_CONSTANTS.noLimit : 'лимит задан в документе команды',
    });
    const outcome = await executeMongoRead(target, prepared, { signal: controller.signal });
    Object.assign(echo, {
      recordsReturned: outcome.recordsReturned,
      limit: outcome.limit,
      hitLimit: outcome.hitLimit,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
    });
    const reasons = [...outcome.incompleteReasons];
    if (outcome.hitLimit) reasons.push(INCOMPLETENESS_REASONS.truncatedByLimit);
    return {
      ok: true,
      command: 'mongo',
      data: outcome.data,
      summary: { operation: prepared.name, recordsReturned: outcome.recordsReturned },
      echo,
      incomplete: reasons.length > 0,
      incompleteReasons: reasons,
      errorClass: null,
      error: null,
    };
  } catch (cause) {
    const error =
      cause instanceof ToolError
        ? cause
        : new ToolError('mongo_query_failed', 'Вызов MongoDB завершился внутренней ошибкой.');
    throw error.withEcho({ ...echo, ...error.echo, command: 'mongo', finishedAt: new Date().toISOString() });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
