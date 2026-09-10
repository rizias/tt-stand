import { existsSync, readFileSync, statSync } from 'node:fs';
import { ToolError } from './errors.ts';

export type Credentials =
  | { kind: 'basic'; login: string; password: string; baseUrl: string }
  | { kind: 'token'; token: string; baseUrl: string };

export type CredentialsFileState = 'missing' | 'empty' | 'filled';

export function credentialsFileState(path: string): CredentialsFileState {
  if (!existsSync(path)) return 'missing';
  return statSync(path).size === 0 ? 'empty' : 'filled';
}

function readKey(text: string, key: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      const value = trimmed.slice(key.length + 1).trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

function readFile(path: string, profileName: string): string {
  const echo = { profile: profileName };
  if (!existsSync(path)) {
    throw new ToolError(
      'credentials_missing',
      `Файл учётных данных профиля ${profileName} не найден: ${path}. Нужен документ JSON с полем kind ("basic" — login и password, "token" — token) либо прежний построчный вид со строками u=, p=, e=.`,
      null,
      echo,
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new ToolError(
        'credentials_missing',
        `Файл учётных данных исчез при чтении: ${path}`,
        null,
        echo,
      );
    }
    throw new ToolError(
      'credentials_incomplete',
      `Файл учётных данных ${path} недоступен для чтения: ${error.message}`,
      null,
      echo,
    );
  }
}

function resolveBaseUrl(
  profileBaseUrl: string | null,
  legacyBaseUrl: string | null,
  profileName: string,
  path: string,
): string {
  const baseUrl = profileBaseUrl ?? legacyBaseUrl;
  if (baseUrl === null) {
    throw new ToolError(
      'profile_incomplete',
      `В профиле ${profileName} не задан базовый адрес Grafana: ни поле grafana.baseUrl, ни строка e= файла ${path} его не называют.`,
      null,
      { profile: profileName },
    );
  }
  return baseUrl.replace(/\/+$/, '');
}

function fromLegacy(
  text: string,
  path: string,
  profileBaseUrl: string | null,
  profileName: string,
): Credentials {
  const login = readKey(text, 'u');
  const password = readKey(text, 'p');
  const legacyBaseUrl = readKey(text, 'e');

  const missing = (
    [
      ['u', login],
      ['p', password],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([key]) => `${key}=`);
  if (missing.length > 0) {
    throw new ToolError(
      'credentials_incomplete',
      `В файле учётных данных ${path} отсутствует: ${missing.join(', ')}`,
      null,
      { profile: profileName },
    );
  }

  const baseUrl = resolveBaseUrl(profileBaseUrl, legacyBaseUrl, profileName, path);
  return { kind: 'basic', login: login as string, password: password as string, baseUrl };
}

const KNOWN_KINDS = ['basic', 'token'] as const;

function fromBasicJson(
  fields: Record<string, unknown>,
  path: string,
  profileBaseUrl: string | null,
  profileName: string,
): Credentials {
  const missing = (['login', 'password'] as const).filter(
    (key) => typeof fields[key] !== 'string' || (fields[key] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new ToolError(
      'credentials_incomplete',
      `В файле учётных данных ${path} для способа basic отсутствует: ${missing.join(', ')}`,
      null,
      { profile: profileName },
    );
  }
  const baseUrl = resolveBaseUrl(profileBaseUrl, null, profileName, path);
  return {
    kind: 'basic',
    login: fields.login as string,
    password: fields.password as string,
    baseUrl,
  };
}

function fromTokenJson(
  fields: Record<string, unknown>,
  path: string,
  profileBaseUrl: string | null,
  profileName: string,
): Credentials {
  const token = fields.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ToolError(
      'credentials_incomplete',
      `В файле учётных данных ${path} для способа token отсутствует значение token.`,
      null,
      { profile: profileName },
    );
  }
  const baseUrl = resolveBaseUrl(profileBaseUrl, null, profileName, path);
  return { kind: 'token', token, baseUrl };
}

function fromJson(
  raw: unknown,
  path: string,
  profileBaseUrl: string | null,
  profileName: string,
): Credentials {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ToolError(
      'credentials_incomplete',
      `Файл учётных данных ${path} не является объектом JSON.`,
      null,
      { profile: profileName },
    );
  }
  const fields = raw as Record<string, unknown>;
  const kind = fields.kind;

  if (kind === 'basic') return fromBasicJson(fields, path, profileBaseUrl, profileName);
  if (kind === 'token') return fromTokenJson(fields, path, profileBaseUrl, profileName);

  throw new ToolError(
    'credentials_incomplete',
    `Файл учётных данных ${path} называет неизвестный способ доступа «${String(kind)}». Известные способы: ${KNOWN_KINDS.join(', ')}.`,
    null,
    { profile: profileName },
  );
}

export function readCredentials(
  path: string,
  profileBaseUrl: string | null,
  profileName: string,
): Credentials {
  const text = readFile(path, profileName);

  let json: unknown;
  let isJson = true;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    isJson = false;
  }

  return isJson
    ? fromJson(json, path, profileBaseUrl, profileName)
    : fromLegacy(text, path, profileBaseUrl, profileName);
}
