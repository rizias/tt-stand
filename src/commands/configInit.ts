import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CONFIG_TEMPLATE } from '../config.ts';
import { ToolError } from '../errors.ts';
import { buildProfileTemplate, defaultCredentialsFilePath } from '../profile.ts';
import { profilesDirectory } from '../profiles.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';

const DEFAULT_PROFILE_NAME = 'default';

async function confirmOverwrite(blockingPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ToolError(
      'config_exists',
      `Файл конфигурации уже существует: ${blockingPath}. Терминал недоступен, подтверждение запросить не у кого — файлы не изменены. Перезаписать: добавьте --force.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Файл ${blockingPath} уже существует. Перезаписать? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    throw new ToolError('config_exists', `Файл ${blockingPath} не изменён.`);
  }
}

function writeOverwritable(path: string, content: string, allowOverwrite: boolean): void {
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: allowOverwrite ? 'w' : 'wx' });
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

export async function runConfigInit(rootPath: string, force: boolean): Promise<ToolResponse> {
  const profileDirectory = join(profilesDirectory(rootPath), DEFAULT_PROFILE_NAME);
  const profilePath = join(profileDirectory, 'profile.json');
  const credentialsPath = defaultCredentialsFilePath(profileDirectory);

  const rootExists = existsSync(rootPath);
  const profileExists = existsSync(profilePath);
  const blockingPath = rootExists ? rootPath : profileExists ? profilePath : null;

  if (blockingPath !== null && !force) {
    await confirmOverwrite(blockingPath);
  }

  mkdirSync(dirname(rootPath), { recursive: true });
  mkdirSync(profileDirectory, { recursive: true });

  writeOverwritable(rootPath, CONFIG_TEMPLATE, rootExists || force);
  writeOverwritable(profilePath, buildProfileTemplate(profileDirectory), profileExists || force);

  const credentialsExisted = existsSync(credentialsPath);
  if (!credentialsExisted) {
    writeFileSync(credentialsPath, '', { encoding: 'utf8', flag: 'wx' });
  }

  return {
    ok: true,
    command: 'config init',
    data: {
      configPath: rootPath,
      profile: DEFAULT_PROFILE_NAME,
      profilePath,
      credentialsPath,
      overwritten: rootExists || profileExists,
      credentialsCreated: !credentialsExisted,
    },
    summary: {
      hint: `Впишите доступ в ${credentialsPath}, затем проверьте его командой tt-stand env.`,
    },
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
      profile: DEFAULT_PROFILE_NAME,
    },
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}
