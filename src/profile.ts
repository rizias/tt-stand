import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FieldValue, type Server, type ServerKind } from './configSchemas.ts';
import { expectString, expectStringList, expectTable } from './configValues.ts';
import { ToolError } from './errors.ts';
import { normalizePath } from './paths.ts';
import { legacyGrafana, legacyKubernetes } from './profileLegacy.ts';
import { parseServers } from './profileServers.ts';
import { type NamespaceScope, parseScope } from './scope.ts';

export interface GrafanaAccess {
  baseUrl: string | null;
  timeoutSeconds: number | null;
  datasourceUid: string | null;
  metricsDatasourceUid: string | null;
  credentialsFile: string;
}

export interface KubernetesAccess {
  kubeconfig: string | null;
  context: string | null;
}

export interface MongoAccess {
  profileName: string;
  serverName: string;
  database: string;
  uri: string;
  credentialsFile: string;
  sshServerName: string;
  timeoutSeconds: number;
  ssh: {
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    knownHostsPath: string;
    timeoutSeconds: number;
  };
}

export interface Profile {
  name: string;
  path: string;
  servers: Record<string, Server>;
  serverSources: Record<string, Record<string, FieldValue>>;
  fieldSources: Record<string, FieldValue>;
  credentialsFile: string;
  grafana: GrafanaAccess | null;
  kubernetes: KubernetesAccess | null;
  namespaceScope: NamespaceScope;
  repositoryRoots: string[];
  journalDirectory: string;
}

export function defaultJournalDirectory(profilePath: string): string {
  return join(dirname(profilePath), 'journal');
}

export function parseProfile(
  raw: Record<string, unknown>,
  name: string,
  path: string,
  credentialsFile: string,
): Profile {
  const location = `профиле ${name} (${path})`;
  const { servers, sources } = parseServers(raw.servers, path);
  const grafana = legacyGrafana(raw.grafana, name, path, credentialsFile);
  const kubernetes = legacyKubernetes(raw.kubernetes, name, path);
  const namespaceScope =
    raw.namespaceScope === undefined ? null : parseScope(raw.namespaceScope, 'namespaceScope', location);
  const repositoryRoots =
    raw.repositoryRoots === undefined
      ? []
      : expectStringList(raw.repositoryRoots, 'repositoryRoots', location).map(normalizePath);
  const journal = expectTable(raw.journal, 'journal', location) ?? {};
  const directory =
    journal.directory === undefined
      ? defaultJournalDirectory(path)
      : expectString(journal.directory, 'journal.directory', location);
  const journalDirectory = normalizePath(directory);
  return {
    name,
    path,
    servers,
    serverSources: sources,
    credentialsFile,
    grafana,
    kubernetes,
    namespaceScope,
    repositoryRoots,
    journalDirectory,
    fieldSources: {
      namespaceScope: { value: namespaceScope, source: raw.namespaceScope === undefined ? 'default' : 'file' },
      repositoryRoots: { value: repositoryRoots, source: raw.repositoryRoots === undefined ? 'default' : 'file' },
      'journal.directory': { value: journalDirectory, source: journal.directory === undefined ? 'default' : 'file' },
    },
  };
}

function selectServer<Kind extends ServerKind>(
  profile: Profile,
  kind: Kind,
  name: string | null,
): {
  name: string;
  server: Extract<Server, { kind: Kind }>;
} {
  const candidates = Object.entries(profile.servers).filter(
    ([serverName, server]) => server.kind === kind && (name === null || serverName === name),
  );
  if (candidates.length === 0) {
    throw new ToolError(
      'profile_incomplete',
      `В профиле ${profile.name} (${profile.path}) отсутствует требуемый сервер вида ${kind}. ` +
        'Укажите сервер этого вида через --server или добавьте его в servers.',
      null,
      { profile: profile.name },
    );
  }
  if (candidates.length > 1) {
    throw new ToolError(
      'profile_ambiguous',
      `В профиле ${profile.name} несколько серверов вида ${kind}. Укажите --server. ` +
        `Доступные имена ${candidates.map(([serverName]) => serverName).join(', ')}.`,
      null,
      { profile: profile.name },
    );
  }
  const [serverName, server] = candidates[0]!;
  return { name: serverName, server: server as Extract<Server, { kind: Kind }> };
}

export function requireGrafana(profile: Profile): GrafanaAccess {
  if (profile.grafana === null) {
    throw new ToolError(
      'profile_incomplete',
      `В профиле ${profile.name} нет доступа к Grafana. Раздел grafana отсутствует в ${profile.path}. ` +
        'Допишите раздел или выберите другой профиль.',
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
      `В профиле ${profile.name} нет доступа к кластеру. Раздел kubernetes отсутствует в ${profile.path}. ` +
        'Допишите раздел или выберите другой профиль.',
      null,
      { profile: profile.name },
    );
  }
  return profile.kubernetes;
}

function requiredString(value: string | null, serverName: string, field: string, profile: Profile): string {
  if (value !== null && value.length > 0) return value;
  const flag = field === 'defaultDatabase' ? ' либо --database' : '';
  throw new ToolError(
    'profile_incomplete',
    `Заполните servers.${serverName}.${field} в профиле ${profile.name} (${profile.path})${flag}.`,
    null,
    { profile: profile.name },
  );
}

export function requireMongo(
  profile: Profile,
  serverName: string | null = null,
  database: string | null = null,
  fallbackDatabase: string | null = null,
): MongoAccess {
  const selected = selectServer(profile, 'mongodb', serverName);
  const server = selected.server;
  const sshServerName = requiredString(server.sshServer, selected.name, 'sshServer', profile);
  const ssh = selectServer(profile, 'ssh', sshServerName).server;
  return {
    profileName: profile.name,
    serverName: selected.name,
    database: requiredString(
      database ?? server.defaultDatabase ?? fallbackDatabase,
      selected.name,
      'defaultDatabase',
      profile,
    ),
    uri: requiredString(server.uri, selected.name, 'uri', profile),
    credentialsFile: profile.credentialsFile,
    sshServerName,
    timeoutSeconds: server.timeoutSeconds,
    ssh: {
      host: requiredString(ssh.host, sshServerName, 'host', profile),
      port: ssh.port,
      username: requiredString(ssh.username, sshServerName, 'username', profile),
      privateKeyPath: requiredString(ssh.privateKeyPath, sshServerName, 'privateKeyPath', profile),
      knownHostsPath: requiredString(ssh.knownHostsPath, sshServerName, 'knownHostsPath', profile),
      timeoutSeconds: ssh.timeoutSeconds,
    },
  };
}

export function defaultCredentialsFilePath(profileDirectory: string): string {
  return join(profileDirectory, 'credentials.json');
}

function toDisplayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length).replaceAll('\\', '/')}` : path;
}

export function buildProfileTemplate(profileDirectory: string): string {
  const template = {
    grafana: { credentialsFile: toDisplayPath(defaultCredentialsFilePath(profileDirectory)) },
    kubernetes: { kubeconfig: '~/.kube/config' },
    repositoryRoots: [],
    journal: { directory: toDisplayPath(join(profileDirectory, 'journal')) },
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}
