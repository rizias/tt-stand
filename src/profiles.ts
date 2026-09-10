import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expectTable } from './configValues.ts';
import { loadRootConfig } from './config.ts';
import { type CredentialsFileState, credentialsFileState } from './credentials.ts';
import { ToolError } from './errors.ts';
import { defaultCredentialsFilePath, parseProfile, type Profile } from './profile.ts';

export const PROFILE_VARIABLE = 'TT_STAND_PROFILE';
const LEGACY_PROFILE_NAME = 'default';

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

function readProfileDocument(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (cause) {
    throw new ToolError(
      'config_invalid',
      `Файл профиля ${path} не разбирается как JSON: ${(cause as Error).message}`,
    );
  }
  return expectTable(raw, 'корень файла профиля', path) ?? {};
}

export function loadProfile(name: string, directory: string): Profile {
  const profileDirectory = join(directory, name);
  const path = join(profileDirectory, 'profile.json');
  const raw = existsSync(path) ? readProfileDocument(path) : {};
  return parseProfile(raw, name, path, defaultCredentialsFilePath(profileDirectory));
}

function hasLegacyFields(raw: Record<string, unknown>): boolean {
  return raw.grafana !== undefined || raw.kubernetes !== undefined || raw.repositoryRoots !== undefined;
}

function legacyProfileFromRoot(raw: Record<string, unknown>, path: string): Profile {
  const legacyCredentialsFile = join(homedir(), '.tt-stand', '.grafana-ro');
  const profile = parseProfile(raw, LEGACY_PROFILE_NAME, path, legacyCredentialsFile);
  return {
    ...profile,
    grafana: profile.grafana ?? {
      baseUrl: null,
      credentialsFile: legacyCredentialsFile,
      timeoutSeconds: null,
      datasourceUid: null,
    },
    kubernetes: profile.kubernetes ?? { kubeconfig: null, context: null },
  };
}

export interface ProfilesDiscovery {
  rootPath: string;
  profilesDir: string;
  defaultProfile: string | null;
  names: string[];
  legacyProfile: Profile | null;
}

export function discoverProfiles(configArgument?: string): ProfilesDiscovery {
  const root = loadRootConfig(configArgument);
  const profilesDir = profilesDirectory(root.path);
  const names = listProfileNames(profilesDir);
  const legacyProfile =
    names.length === 0 && root.raw !== null && hasLegacyFields(root.raw)
      ? legacyProfileFromRoot(root.raw, root.path)
      : null;

  return {
    rootPath: root.path,
    profilesDir,
    defaultProfile: root.config.defaultProfile,
    names: legacyProfile ? [legacyProfile.name] : names,
    legacyProfile,
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

export function resolveProfileName(
  argument: string | null,
  names: string[],
  defaultProfile: string | null,
  profilesDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const requested = argument ?? emptyToNull(environment[PROFILE_VARIABLE]) ?? defaultProfile;

  if (requested !== null) {
    if (!names.includes(requested)) {
      throw new ToolError(
        'profile_missing',
        `Профиль «${requested}» не найден. Имеющиеся профили: ${names.length > 0 ? names.join(', ') : '(нет ни одного)'}.`,
        null,
        { requestedProfile: requested, profiles: names },
      );
    }
    return requested;
  }

  if (names.length === 1) return names[0] as string;
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
    `Профиль не выбран, а их несколько: ${names.join(', ')}. Укажите --profile <имя>, переменную ${PROFILE_VARIABLE} либо defaultProfile в config.json.`,
    null,
    { profiles: names },
  );
}

export function resolveActiveProfile(
  configArgument: string | undefined,
  profileArgument: string | null,
): Profile {
  const discovery = discoverProfiles(configArgument);
  const name = resolveProfileName(
    profileArgument,
    discovery.names,
    discovery.defaultProfile,
    discovery.profilesDir,
  );
  return discovery.legacyProfile ?? loadProfile(name, discovery.profilesDir);
}

export interface ProfileSummary {
  name: string;
  hasGrafana: boolean;
  hasKubernetes: boolean;
  hasNamespaceScope: boolean;
  isDefault: boolean;
  credentials: CredentialsFileState;
}

function credentialsPathFor(name: string, profile: Profile, profilesDir: string): string {
  return profile.grafana?.credentialsFile ?? defaultCredentialsFilePath(join(profilesDir, name));
}

export function summarizeProfiles(configArgument?: string): {
  profiles: ProfileSummary[];
  defaultProfile: string | null;
} {
  const discovery = discoverProfiles(configArgument);
  const profiles = discovery.legacyProfile
    ? [discovery.legacyProfile]
    : discovery.names.map((name) => loadProfile(name, discovery.profilesDir));
  const effectiveDefault =
    discovery.defaultProfile ?? (profiles.length === 1 ? (profiles[0] as Profile).name : null);

  return {
    defaultProfile: effectiveDefault,
    profiles: profiles.map((profile) => ({
      name: profile.name,
      hasGrafana: profile.grafana !== null,
      hasKubernetes: profile.kubernetes !== null,
      hasNamespaceScope: profile.namespaceScope !== null,
      isDefault: profile.name === effectiveDefault,
      credentials: credentialsFileState(credentialsPathFor(profile.name, profile, discovery.profilesDir)),
    })),
  };
}
