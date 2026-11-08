import { parseArgs } from 'node:util';
import { joinNegativeValues, OPTIONS, type ParsedValues, requiredPositional, USAGE } from './args.ts';
import { buildLogsContext, dispatchK8s, dispatchLogs } from './dispatch.ts';
import { dispatchMetrics } from './dispatchMetrics.ts';
import { runBatchCommand } from '../batch/run.ts';
import { runConfigProfiles, runConfigShow } from '../commands/config.ts';
import { runConfigInit } from '../commands/configInit.ts';
import { runEnv } from '../commands/env.ts';
import { runImage } from '../commands/image.ts';
import { runInitCommand } from '../commands/init.ts';
import { runTokenCommand } from '../commands/token.ts';
import { resolveConfigPath } from '../config.ts';
import { ToolError } from '../errors.ts';
import { resolveActiveProfile } from '../profiles.ts';
import type { Profile } from '../profile.ts';
import type { ToolResponse } from '../response.ts';

async function dispatchLocal(
  group: string | undefined,
  action: string | undefined,
  positionals: string[],
  values: ParsedValues,
): Promise<ToolResponse | null> {
  if (group === 'init') {
    return await runInitCommand(positionals[1] ?? process.cwd(), values.for);
  }
  if (group === 'config' && action === 'init') {
    return await runConfigInit(resolveConfigPath(values.config), values.force === true, values.profile);
  }
  if (group === 'config' && action === 'profiles') {
    return runConfigProfiles(values.config, values.profile ?? null);
  }
  if (group === 'config' && action === undefined) {
    return runConfigShow(values.config, values.profile ?? null);
  }
  return null;
}

export async function runCommand(argv: string[], onProfile?: (profile: Profile) => void): Promise<ToolResponse | null> {
  const { values, positionals } = parseArgs({
    args: joinNegativeValues(argv),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return null;
  }

  if (values.human && values.json) {
    throw new ToolError('bad_request', 'Выберите один формат вывода, --human или --json.');
  }

  const [group, action] = positionals;
  const loadProfile = (): Profile => {
    const profile = resolveActiveProfile(values.config, values.profile ?? null);
    onProfile?.(profile);
    return profile;
  };

  if (group === 'batch') return await runBatchCommand(values, loadProfile);

  if (group === 'mongo') {
    if (positionals.length !== 1) {
      throw new ToolError('bad_request', 'Команда mongo принимает запрос через --query или --query-file.');
    }
    const { runMongoCommand } = await import('../commands/mongo.ts');
    return await runMongoCommand(values, loadProfile);
  }

  const local = await dispatchLocal(group, action, positionals, values);
  if (local !== null) return local;

  if (group === 'token') {
    return await runTokenCommand(values.value);
  }

  if (group === 'image') {
    const profile = loadProfile();
    return await runImage(profile.name, profile.repositoryRoots, requiredPositional(positionals[1], 'образ или тег'));
  }

  if (group === 'k8s') {
    return await dispatchK8s(action, positionals, values, loadProfile);
  }

  if (group === 'env') {
    return await runEnv(await buildLogsContext(values, undefined, loadProfile()));
  }

  if (group === 'logs') {
    return await dispatchLogs(action, values, loadProfile);
  }

  if (group === 'metrics') {
    return await dispatchMetrics(action, values, loadProfile);
  }

  throw new ToolError('bad_request', `Неизвестная команда: ${positionals.join(' ')}. Справка: tt-stand --help`);
}
