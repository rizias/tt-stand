#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  joinNegativeValues,
  OPTIONS,
  type ParsedValues,
  parseLimit,
  requiredPositional,
  USAGE,
} from './cli/args.ts';
import { buildLogsContext, dispatchK8s, dispatchLogs } from './cli/dispatch.ts';
import { failureResponse } from './cli/failure.ts';
import { runConfigInit } from './commands/configInit.ts';
import { runEnv } from './commands/env.ts';
import { runImage } from './commands/image.ts';
import { runInitCommand } from './commands/init.ts';
import { readTokenFromStdin, tokenResponse } from './commands/token.ts';
import { runUpdateCommand } from './commands/update.ts';
import { fallbackJournalDirectory, resolveConfigPath } from './config.ts';
import { ToolError } from './errors.ts';
import { currentOrigin, journalEntryPath, writeJournalEntry } from './journal.ts';
import { resolveActiveProfile, summarizeProfiles } from './profiles.ts';
import { localEcho, renderHuman, renderJson, type ToolResponse } from './response.ts';
import { keepInstalledSkillsFresh } from './skills/setup.ts';

function configProfilesResponse(configArgument: string | undefined): ToolResponse {
  const { profiles, defaultProfile } = summarizeProfiles(configArgument);
  return {
    ok: true,
    command: 'config profiles',
    data: { profiles, defaultProfile },
    summary: { profileCount: profiles.length },
    echo: localEcho('config profiles'),
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}


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
    return await runConfigInit(resolveConfigPath(values.config), values.force === true);
  }
  if (group === 'config' && action === 'profiles') {
    return configProfilesResponse(values.config);
  }
  return null;
}

async function dispatch(argv: string[]): Promise<ToolResponse | null> {
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

  const [group, action] = positionals;
  const limit = parseLimit(values.limit);

  const local = await dispatchLocal(group, action, positionals, values);
  if (local !== null) return local;

  if (group === 'token') {
    const tokenValues = values.value ?? [];
    if (tokenValues.length > 1) {
      throw new ToolError(
        'bad_request',
        'Для команды token параметр --value можно задать только один раз.',
      );
    }
    return tokenResponse(tokenValues[0] ?? (await readTokenFromStdin()));
  }

  if (group === 'image') {
    const profile = resolveActiveProfile(values.config, values.profile ?? null);
    return await runImage(
      profile.name,
      profile.repositoryRoots,
      requiredPositional(positionals[1], 'образ или тег'),
    );
  }

  if (group === 'k8s') {
    return await dispatchK8s(action, positionals, values);
  }

  if (group === 'env') {
    return await runEnv(await buildLogsContext(values));
  }

  if (group === 'logs') {
    return await dispatchLogs(action, values, limit);
  }

  throw new ToolError(
    'bad_request',
    `Неизвестная команда: ${positionals.join(' ')}. Справка: tt-stand --help`,
  );
}

function flagValue(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === flag) return argv[index + 1];
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return undefined;
}

function journalDirectory(argv: string[]): string {
  try {
    const profile = resolveActiveProfile(
      flagValue(argv, '--config'),
      flagValue(argv, '--profile') ?? null,
    );
    return profile.journalDirectory;
  } catch {
    return fallbackJournalDirectory();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'init') keepInstalledSkillsFresh();
  if (argv[0] === 'update' && !argv.includes('--help') && !argv.includes('-h')) {
    if (argv.length > 1) {
      process.stderr.write(`tt-stand: update не принимает аргументов, получено «${argv.slice(1).join(' ')}»
`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = runUpdateCommand();
    return;
  }
  const human = argv.includes('--human');
  const at = new Date().toISOString();

  const origin = currentOrigin();

  const finish = (response: ToolResponse): void => {
    const directory = journalDirectory(argv);
    const echo = response.echo as unknown as Record<string, unknown>;
    echo.journal = journalEntryPath(directory, at, origin);
    echo.journalRun = origin.run;
    const profileName = typeof echo.profile === 'string' ? echo.profile : null;
    const outcome = writeJournalEntry(directory, argv, response, at, origin, profileName);
    if (outcome.failure !== null) echo.journal = outcome.failure;
    process.stdout.write(`${human ? renderHuman(response) : renderJson(response)}\n`);
    process.exitCode = response.ok ? 0 : 1;
  };

  try {
    const response = await dispatch(argv);
    if (response === null) return;
    finish(response);
  } catch (cause) {
    finish(failureResponse(cause, argv.join(' ')));
  }
}

await main();
