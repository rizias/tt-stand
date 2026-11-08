import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRootConfig, resolveConfigPath } from './config.ts';
import { readConfigDocument } from './configValues.ts';
import { type CredentialsFileState, credentialsFileState } from './credentials.ts';
import { ToolError } from './errors.ts';
import { defaultCredentialsFilePath, parseProfile, type Profile } from './profile.ts';

export const PROFILE_VARIABLE = 'TT_STAND_PROFILE';

export interface ProfileSelection {
  rootPath: string;
  name: string;
  source: 'flag' | 'env' | 'config' | 'default';
  profilePath: string;
  credentialsPath: string;
  defaultProfile: string | null;
  legacy?: boolean;
}

interface SelectionOptions {
  rootPath?: string;
  environment?: NodeJS.ProcessEnv;
  allowEmptyDefault?: boolean;
}

export function profilesDirectory(configPath: string): string {
  return join(dirname(configPath), 'profiles');
}

export function listProfileNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadProfile(name: string, directory: string): Profile {
  const profileDirectory = join(directory, name);
  const path = join(profileDirectory, 'profile.json');
  const raw = existsSync(path) ? readConfigDocument(path) : {};
  return parseProfile(raw, name, path, defaultCredentialsFilePath(profileDirectory));
}

function legacyProfileFromRoot(raw: Record<string, unknown>, path: string): Profile {
  const credentialsFile = join(homedir(), '.tt-stand', '.grafana-ro');
  const profile = parseProfile(raw, 'default', path, defaultCredentialsFilePath(dirname(path)));
  const grafana = profile.grafana ?? {
    baseUrl: null,
    credentialsFile,
    timeoutSeconds: null,
    datasourceUid: null,
    metricsDatasourceUid: null,
  };
  if (raw.grafana && typeof raw.grafana === 'object' && !Object.hasOwn(raw.grafana, 'credentialsFile')) {
    grafana.credentialsFile = credentialsFile;
  }
  return { ...profile, grafana, kubernetes: profile.kubernetes ?? { kubeconfig: null, context: null } };
}

export function discoverProfiles(configArgument?: string): {
  rootPath: string;
  profilesDir: string;
  defaultProfile: string | null;
  names: string[];
  legacyProfile: Profile | null;
} {
  const root = loadRootConfig(configArgument);
  const profilesDir = profilesDirectory(root.path);
  const names = listProfileNames(profilesDir);
  const legacy =
    root.raw !== null && ['grafana', 'kubernetes', 'repositoryRoots'].some((key) => root.raw![key] !== undefined);
  const legacyProfile = names.length === 0 && legacy ? legacyProfileFromRoot(root.raw!, root.path) : null;
  return {
    rootPath: root.path,
    profilesDir,
    defaultProfile: root.config.defaultProfile,
    names: legacyProfile ? ['default'] : names,
    legacyProfile,
  };
}

export function resolveProfileName(
  argument: string | null,
  names: string[],
  defaultProfile: string | null,
  profilesDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const requested = argument ?? (environment[PROFILE_VARIABLE] || null) ?? defaultProfile;
  if (requested !== null) {
    if (!names.includes(requested)) {
      throw new ToolError(
        'profile_missing',
        `Профиль ${requested} отсутствует по пути ${join(profilesDir, requested, 'profile.json')}. ` +
          `Имеющиеся профили ${names.join(', ') || '(нет ни одного)'}.`,
        null,
        { requestedProfile: requested, profiles: names },
      );
    }
    return requested;
  }
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new ToolError(
      'profile_missing',
      `Профилей не найдено в ${profilesDir}. Создайте профиль командой tt-stand config init.`,
      null,
      { profiles: names },
    );
  }
  throw new ToolError(
    'profile_ambiguous',
    `Профиль не выбран. Укажите --profile, ${PROFILE_VARIABLE} или defaultProfile в config.json. ` +
      `Имеющиеся профили ${names.join(', ')}.`,
    null,
    { profiles: names },
  );
}

function selectionSource(
  argument: string | null,
  environment: NodeJS.ProcessEnv,
  defaultProfile: string | null,
): ProfileSelection['source'] {
  if (argument !== null) return 'flag';
  if (environment[PROFILE_VARIABLE]) return 'env';
  return defaultProfile !== null ? 'config' : 'default';
}

export function resolveProfileSelection(
  configArgument?: string,
  profileArgument: string | null = null,
  options: SelectionOptions = {},
): ProfileSelection {
  const rootArgument = options.rootPath ?? configArgument;
  const rootPath = resolveConfigPath(rootArgument);
  const environment = options.environment ?? process.env;
  const discovery = discoverProfiles(rootArgument);
  const effectiveDefault = discovery.defaultProfile;
  const name =
    options.allowEmptyDefault &&
    discovery.names.length === 0 &&
    profileArgument === null &&
    !environment[PROFILE_VARIABLE] &&
    effectiveDefault === null
      ? 'default'
      : resolveProfileName(profileArgument, discovery.names, effectiveDefault, discovery.profilesDir, environment);
  const source = selectionSource(profileArgument, environment, discovery.defaultProfile);
  const profilePath = discovery.legacyProfile?.path ?? join(discovery.profilesDir, name, 'profile.json');
  return {
    rootPath,
    name,
    source,
    profilePath,
    defaultProfile: discovery.defaultProfile,
    credentialsPath: defaultCredentialsFilePath(dirname(profilePath)),
    legacy: discovery.legacyProfile !== null,
  };
}

export function loadSelectedProfile(selection: ProfileSelection): Profile {
  const raw = existsSync(selection.profilePath) ? readConfigDocument(selection.profilePath) : {};
  return selection.legacy
    ? legacyProfileFromRoot(raw, selection.profilePath)
    : parseProfile(raw, selection.name, selection.profilePath, selection.credentialsPath);
}

export function resolveActiveProfile(configArgument: string | undefined, profileArgument: string | null): Profile {
  return loadSelectedProfile(resolveProfileSelection(configArgument, profileArgument));
}

export interface ProfileSummary {
  name: string;
  servers: Record<string, string>;
  hasGrafana: boolean;
  hasKubernetes: boolean;
  hasNamespaceScope: boolean;
  isDefault: boolean;
  isCurrent: boolean;
  credentials: CredentialsFileState;
}

export function summarizeProfiles(
  configArgument?: string,
  profileArgument: string | null = null,
  rootPath?: string,
): { profiles: ProfileSummary[]; defaultProfile: string | null; currentProfile: string } {
  const discovery = discoverProfiles(rootPath ?? configArgument);
  const profiles = discovery.legacyProfile
    ? [discovery.legacyProfile]
    : discovery.names.map((name) => loadProfile(name, discovery.profilesDir));
  const defaultProfile = discovery.defaultProfile ?? (profiles.length === 1 ? profiles[0]!.name : null);
  const currentProfile = profileArgument ?? (process.env[PROFILE_VARIABLE] || null) ?? defaultProfile ?? 'default';
  return {
    defaultProfile,
    currentProfile,
    profiles: profiles.map((profile) => ({
      name: profile.name,
      servers: Object.fromEntries(Object.entries(profile.servers).map(([name, server]) => [name, server.kind])),
      hasGrafana: profile.grafana !== null,
      hasKubernetes: profile.kubernetes !== null,
      hasNamespaceScope: profile.namespaceScope !== null,
      isDefault: profile.name === defaultProfile,
      isCurrent: profile.name === currentProfile,
      credentials: credentialsFileState(profile.grafana?.credentialsFile ?? profile.credentialsFile),
    })),
  };
}
