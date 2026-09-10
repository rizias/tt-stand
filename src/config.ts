import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expectString, expectTable } from './configValues.ts';
import { ToolError } from './errors.ts';
import { normalizePath } from './paths.ts';

export interface RootConfig {
  defaultProfile: string | null;
}

export function configHome(): string {
  return join(homedir(), '.tt-stand');
}

export function fallbackJournalDirectory(): string {
  return join(configHome(), 'journal');
}

export const DEFAULT_ROOT_CONFIG: RootConfig = {
  defaultProfile: null,
};

export function defaultConfigPath(): string {
  return join(configHome(), 'config.json');
}

export function resolveConfigPath(fromArgument?: string): string {
  const candidate = fromArgument ?? process.env.TT_STAND_CONFIG;
  return candidate ? normalizePath(candidate) : defaultConfigPath();
}

export interface LoadedRootConfig {
  config: RootConfig;
  path: string;
  exists: boolean;
  raw: Record<string, unknown> | null;
}

export function loadRootConfig(fromArgument?: string): LoadedRootConfig {
  const path = resolveConfigPath(fromArgument);
  if (!existsSync(path)) {
    return { config: { ...DEFAULT_ROOT_CONFIG }, path, exists: false, raw: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (cause) {
    throw new ToolError(
      'config_invalid',
      `Файл конфигурации ${path} не разбирается как JSON: ${(cause as Error).message}`,
    );
  }

  const raw = expectTable(parsed, 'корень файла', path);
  if (raw === null) {
    throw new ToolError('config_invalid', `Файл конфигурации ${path} пуст`);
  }

  const config: RootConfig = { ...DEFAULT_ROOT_CONFIG };
  if (raw.defaultProfile !== undefined) {
    config.defaultProfile = expectString(raw.defaultProfile, 'defaultProfile', path);
  }

  return { config, path, exists: true, raw };
}

export const CONFIG_TEMPLATE = `${JSON.stringify(
  {
    defaultProfile: 'default',
  },
  null,
  2,
)}\n`;
