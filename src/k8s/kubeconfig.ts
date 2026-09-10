import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { ToolError } from '../errors.ts';
import { normalizePath } from '../paths.ts';

export type KubeconfigSource = 'config' | 'KUBECONFIG' | 'standard';

export interface ResolvedKubeconfig {
  path: string;
  source: KubeconfigSource;
}

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

function looksLikeKubeconfig(name: string): boolean {
  return CONFIG_EXTENSIONS.has(extname(name).toLowerCase()) || name === 'config';
}

function singleEnvironmentPath(raw: string): string {
  if (!raw.includes(delimiter)) return raw;
  const candidates = raw
    .split(delimiter)
    .filter((item) => item.length > 0)
    .map((item) => normalizePath(item));
  if (candidates.length > 1) {
    throw new ToolError(
      'kubeconfig_ambiguous',
      `KUBECONFIG содержит несколько путей: ${candidates.join(', ')}. Выберите один явно в kubernetes.kubeconfig файла tt-stand.`,
      { candidates, howToSelect: 'Задайте kubernetes.kubeconfig в конфигурации tt-stand.' },
    );
  }
  return candidates[0] ?? raw;
}

function statKubeconfig(path: string): import('node:fs').Stats {
  if (!existsSync(path)) {
    throw new ToolError(
      'kubeconfig_missing',
      `Kubeconfig не найден: ${path}. Задайте kubernetes.kubeconfig, KUBECONFIG или положите файл в стандартное расположение.`,
    );
  }
  try {
    return statSync(path);
  } catch (cause) {
    throw new ToolError(
      'kubeconfig_missing',
      `Kubeconfig недоступен: ${path}: ${(cause as Error).message}`,
    );
  }
}

function fileInDirectory(path: string): string {
  const candidates = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && looksLikeKubeconfig(entry.name))
    .map((entry) => join(path, entry.name));
  if (candidates.length === 0) {
    throw new ToolError(
      'kubeconfig_missing',
      `В каталоге ${path} нет файлов kubeconfig (.yaml, .yml, .json или config).`,
    );
  }
  if (candidates.length > 1) {
    throw new ToolError(
      'kubeconfig_ambiguous',
      `В каталоге ${path} найдено несколько kubeconfig: ${candidates.join(', ')}. Выберите один явно в kubernetes.kubeconfig файла tt-stand.`,
      { candidates, howToSelect: 'Задайте kubernetes.kubeconfig в конфигурации tt-stand.' },
    );
  }
  return candidates[0] as string;
}

export function resolveKubeconfig(
  configured: string | null,
  environmentValue: string | undefined = process.env.KUBECONFIG,
  standardPath: string = join(homedir(), '.kube', 'config'),
): ResolvedKubeconfig {
  const source: KubeconfigSource = configured
    ? 'config'
    : environmentValue
      ? 'KUBECONFIG'
      : 'standard';
  const raw = configured ?? environmentValue ?? standardPath;
  const path = normalizePath(source === 'KUBECONFIG' ? singleEnvironmentPath(raw) : raw);

  const stat = statKubeconfig(path);
  if (stat.isFile()) return { path, source };
  if (!stat.isDirectory()) {
    throw new ToolError(
      'kubeconfig_invalid',
      `Путь kubeconfig не является файлом или каталогом: ${path}.`,
    );
  }
  return { path: fileInDirectory(path), source };
}
