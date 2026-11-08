import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expectString, readConfigDocument } from './configValues.ts';
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

export const DEFAULT_ROOT_CONFIG: RootConfig = { defaultProfile: null };

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
    const source = fromArgument !== undefined ? '--config' : process.env.TT_STAND_CONFIG ? 'TT_STAND_CONFIG' : null;
    if (source !== null) {
      throw new ToolError('config_invalid', `Файл конфигурации, заданный ${source}, отсутствует по пути ${path}.`);
    }
    return { config: { ...DEFAULT_ROOT_CONFIG }, path, exists: false, raw: null };
  }
  const raw = readConfigDocument(path);
  const defaultValue = raw.defaultProfile;
  const defaultProfile = defaultValue === undefined ? null : expectString(defaultValue, 'defaultProfile', path);
  return { config: { defaultProfile }, path, exists: true, raw };
}
