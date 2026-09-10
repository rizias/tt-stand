import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expectNumber, expectString, expectStringList, expectTable } from './configValues.ts';
import { ToolError } from './errors.ts';
import { normalizePath } from './paths.ts';
import { type NamespaceScope, parseScope } from './scope.ts';

export interface GrafanaAccess {
  baseUrl: string | null;
  credentialsFile: string;
  timeoutSeconds: number | null;
  datasourceUid: string | null;
}

export interface KubernetesAccess {
  kubeconfig: string | null;
  context: string | null;
}

export interface Profile {
  name: string;
  path: string;
  grafana: GrafanaAccess | null;
  kubernetes: KubernetesAccess | null;
  namespaceScope: NamespaceScope;
  repositoryRoots: string[];
  journalDirectory: string;
}

export function defaultJournalDirectory(profilePath: string): string {
  return join(dirname(profilePath), 'journal');
}

function parseJournalDirectory(
  raw: Record<string, unknown>,
  location: string,
  profilePath: string,
): string {
  const journal = expectTable(raw.journal, 'journal', location);
  if (journal?.directory === undefined) return defaultJournalDirectory(profilePath);
  return normalizePath(expectString(journal.directory, 'journal.directory', location));
}

function describe(name: string, path: string): string {
  return `профиле ${name} (${path})`;
}

function parseGrafana(
  raw: Record<string, unknown>,
  name: string,
  path: string,
  defaultCredentialsFile: string,
): GrafanaAccess | null {
  const location = describe(name, path);
  const table = expectTable(raw.grafana, 'grafana', location);
  if (table === null) return null;

  const baseUrl =
    table.baseUrl === undefined ? null : expectString(table.baseUrl, 'grafana.baseUrl', location);
  const credentialsFile =
    table.credentialsFile === undefined
      ? defaultCredentialsFile
      : normalizePath(expectString(table.credentialsFile, 'grafana.credentialsFile', location));
  const timeoutSeconds =
    table.timeoutSeconds === undefined
      ? null
      : expectNumber(table.timeoutSeconds, 'grafana.timeoutSeconds', location);
  if (timeoutSeconds !== null && timeoutSeconds <= 0) {
    throw new ToolError(
      'config_invalid',
      `Поле grafana.timeoutSeconds в ${location} должно быть больше нуля, получено ${timeoutSeconds}`,
    );
  }
  const datasourceUid =
    table.datasourceUid === undefined
      ? null
      : expectString(table.datasourceUid, 'grafana.datasourceUid', location);

  return { baseUrl, credentialsFile, timeoutSeconds, datasourceUid };
}

function parseKubernetes(
  raw: Record<string, unknown>,
  name: string,
  path: string,
): KubernetesAccess | null {
  const location = describe(name, path);
  const table = expectTable(raw.kubernetes, 'kubernetes', location);
  if (table === null) return null;

  const kubeconfig =
    table.kubeconfig === undefined
      ? null
      : normalizePath(expectString(table.kubeconfig, 'kubernetes.kubeconfig', location));
  const context =
    table.context === undefined ? null : expectString(table.context, 'kubernetes.context', location);

  return { kubeconfig, context };
}

export function parseProfile(
  raw: Record<string, unknown>,
  name: string,
  path: string,
  defaultCredentialsFile: string,
): Profile {
  const location = describe(name, path);
  const grafana = parseGrafana(raw, name, path, defaultCredentialsFile);
  const kubernetes = parseKubernetes(raw, name, path);
  const namespaceScope =
    raw.namespaceScope === undefined ? null : parseScope(raw.namespaceScope, 'namespaceScope', location);
  const repositoryRoots =
    raw.repositoryRoots === undefined
      ? []
      : expectStringList(raw.repositoryRoots, 'repositoryRoots', location).map(normalizePath);

  const journalDirectory = parseJournalDirectory(raw, location, path);

  return { name, path, grafana, kubernetes, namespaceScope, repositoryRoots, journalDirectory };
}

export function requireGrafana(profile: Profile): GrafanaAccess {
  if (profile.grafana === null) {
    throw new ToolError(
      'profile_incomplete',
      `В профиле ${profile.name} нет доступа к Grafana: раздел grafana отсутствует в ${profile.path}. Допишите раздел или выберите другой профиль.`,
      null,
      { profile: profile.name },
    );
  }
  return profile.grafana;
}

export function requireKubernetes(profile: Profile): KubernetesAccess {
  if (profile.kubernetes === null) {
    throw new ToolError(
      'profile_incomplete',
      `В профиле ${profile.name} нет доступа к кластеру: раздел kubernetes отсутствует в ${profile.path}. Допишите раздел или выберите другой профиль.`,
      null,
      { profile: profile.name },
    );
  }
  return profile.kubernetes;
}

export function defaultCredentialsFilePath(profileDirectory: string): string {
  return join(profileDirectory, 'credentials.json');
}

function toDisplayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length).replaceAll('\\', '/')}` : path;
}

export function buildProfileTemplate(profileDirectory: string): string {
  return `${JSON.stringify(
    {
      grafana: { credentialsFile: toDisplayPath(defaultCredentialsFilePath(profileDirectory)) },
      kubernetes: { kubeconfig: '~/.kube/config' },
      repositoryRoots: [],
      journal: { directory: toDisplayPath(join(profileDirectory, 'journal')) },
    },
    null,
    2,
  )}\n`;
}
