#!/usr/bin/env node
import { runCommand } from './cli/runCommand.ts';
import { publicInvocation } from './cli/args.ts';
import { failureResponse } from './cli/failure.ts';
import { computeIgnoredFlags, IGNORED_FLAGS_NOTE } from './cli/ignoredFlags.ts';
import { runUpdateCommand } from './commands/update.ts';
import { fallbackJournalDirectory } from './config.ts';
import { currentOrigin, writeJournalEntry } from './journal.ts';
import { resolveActiveProfile } from './profiles.ts';
import type { Profile } from './profile.ts';
import { renderHuman, renderJson, type ToolResponse } from './response.ts';
import { keepInstalledSkillsFresh } from './skills/setup.ts';

function flagValue(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === flag) return argv[index + 1];
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return undefined;
}

function journalDirectory(argv: string[], profileName?: string): string {
  try {
    const config = flagValue(argv, '--config');
    const profile = resolveActiveProfile(config, profileName ?? flagValue(argv, '--profile') ?? null);
    return profile.journalDirectory;
  } catch {
    return fallbackJournalDirectory();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'init') await keepInstalledSkillsFresh();
  if (argv[0] === 'update' && !argv.includes('--help') && !argv.includes('-h')) {
    if (argv.length > 1) {
      process.stderr.write('tt-stand update не принимает аргументов. Справка доступна через --help.\n');
      process.exitCode = 1;
      return;
    }
    process.exitCode = runUpdateCommand();
    return;
  }
  const human = argv.includes('--human');
  const invocation = publicInvocation(argv);
  const at = new Date().toISOString();

  const origin = currentOrigin();
  let selectedProfile: Profile | undefined;

  const finish = (response: ToolResponse): void => {
    const preflightMongoFailure = response.echo.command === 'mongo' && response.echo.profile === undefined;
    const directory =
      selectedProfile?.journalDirectory ??
      (preflightMongoFailure ? fallbackJournalDirectory() : journalDirectory(argv, response.echo.profile));
    const echo = response.echo as unknown as Record<string, unknown>;
    echo.journalRun = origin.run;
    if (selectedProfile) echo.profile = selectedProfile.name;
    const ignoredFlags = computeIgnoredFlags(argv);
    echo.ignoredFlags = ignoredFlags;
    echo.ignoredFlagsNote = ignoredFlags.length > 0 ? IGNORED_FLAGS_NOTE : null;
    const profileName = typeof echo.profile === 'string' ? echo.profile : null;
    const outcome = writeJournalEntry(directory, invocation, response, at, origin, profileName);
    if (outcome.failure !== null) echo.journal = outcome.failure;
    process.stdout.write(`${human ? renderHuman(response) : renderJson(response)}\n`);
    process.exitCode = response.ok ? 0 : 1;
  };

  try {
    const response = await runCommand(argv, (profile) => {
      selectedProfile = profile;
    });
    if (response === null) return;
    finish(response);
  } catch (cause) {
    finish(failureResponse(cause, invocation.join(' ')));
  }
}

await main();
