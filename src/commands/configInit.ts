import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validateProfileName } from '../configValues.ts';
import { atomicWriteFile, createFileExclusive, withFileLockAsync } from '../lock.ts';
import { ToolError } from '../errors.ts';
import { buildProfileTemplate, defaultCredentialsFilePath } from '../profile.ts';
import { profilesDirectory } from '../profiles.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';

const DEFAULT_PROFILE_NAME = 'default';

async function confirmOverwrite(blockingPath: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Файл ${blockingPath} уже существует. Перезаписать? [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

function writeOverwritable(path: string, content: string, allowOverwrite: boolean): void {
  try {
    if (allowOverwrite) atomicWriteFile(path, content);
    else if (!createFileExclusive(path, content)) {
      throw new ToolError('config_exists', `Файл ${path} уже создан другим процессом.`);
    }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'EEXIST') {
      throw new ToolError(
        'config_exists',
        `Файл конфигурации ${path} создан другим процессом во время выполнения команды — не изменён.`,
      );
    }
    throw error;
  }
}

export async function runConfigInit(rootPath: string, force: boolean, profileName?: string): Promise<ToolResponse> {
  validateProfileName(profileName ?? DEFAULT_PROFILE_NAME, '--profile');
  return withFileLockAsync(`${rootPath}.lock`, () => initializeProfile(rootPath, force, profileName));
}

async function initializeProfile(rootPath: string, force: boolean, requestedProfile?: string): Promise<ToolResponse> {
  const profileName = requestedProfile ?? DEFAULT_PROFILE_NAME;
  const profileDirectory = join(profilesDirectory(rootPath), profileName);
  const profilePath = join(profileDirectory, 'profile.json');
  const credentialsPath = defaultCredentialsFilePath(profileDirectory);

  const rootExists = existsSync(rootPath);
  const profileExists = existsSync(profilePath);
  const writeRoot = !rootExists || requestedProfile === undefined;
  const blockingPath = rootExists && writeRoot ? rootPath : profileExists ? profilePath : null;

  if (blockingPath !== null && !force && !(await confirmOverwrite(blockingPath))) {
    return initResponse(
      {
        configPath: rootPath,
        profile: profileName,
        profilePath,
        credentialsPath,
        changed: false,
        existing: [rootPath, profilePath].filter((path) => existsSync(path)),
      },
      'Файлы уже существуют и не изменены. Перезаписать без вопроса: tt-stand config init --force.',
    );
  }

  mkdirSync(dirname(rootPath), { recursive: true });
  mkdirSync(profileDirectory, { recursive: true });

  if (writeRoot) {
    writeOverwritable(rootPath, `${JSON.stringify({ defaultProfile: profileName }, null, 2)}\n`, rootExists || force);
  }
  writeOverwritable(profilePath, buildProfileTemplate(profileDirectory), profileExists || force);

  const credentialsExisted = existsSync(credentialsPath);
  if (!credentialsExisted) {
    createFileExclusive(credentialsPath, '');
  }

  return initResponse(
    {
      configPath: rootPath,
      profile: profileName,
      profilePath,
      credentialsPath,
      changed: true,
      overwritten: (rootExists && writeRoot) || profileExists,
      credentialsCreated: !credentialsExisted,
    },
    `Впишите доступ в ${credentialsPath}, затем проверьте его командой tt-stand env.`,
  );
}

function initResponse(data: Record<string, unknown>, hint: string): ToolResponse {
  const profileName = String(data.profile);
  return {
    ok: true,
    command: 'config init',
    data,
    summary: { hint },
    echo: {
      command: 'config init',
      query: null,
      request: null,
      start: null,
      end: null,
      limit: null,
      limitNote: 'запрос к хранилищу не выполнялся',
      datasource: null,
      datasourceNote: null,
      recordsReturned: 0,
      hitLimit: false,
      unparsableLines: 0,
      order: 'не применимо',
      unavailableSources: [],
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
      profile: profileName,
    },
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}
