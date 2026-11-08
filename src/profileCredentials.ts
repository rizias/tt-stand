import { existsSync, readFileSync } from 'node:fs';
import { SERVER_SCHEMAS, type ServerKind } from './configSchemas.ts';
import { ToolError } from './errors.ts';

function credentialError(path: string, profile: string, server: string, rule: string): ToolError {
  return new ToolError(
    'credentials_incomplete',
    `Учётные данные сервера ${server} профиля ${profile} в ${path} ${rule}. ` +
      'Исправьте запись сервера в файле учётных данных.',
    null,
    { profile },
  );
}

function readDictionary(path: string, profile: string, server: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    if (text.trim().length === 0) return {};
    parsed = JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    throw credentialError(path, profile, server, 'должны содержать корректный JSON в UTF-8');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw credentialError(path, profile, server, 'должны быть словарём записей по имени сервера');
  }
  const dictionary = parsed as Record<string, unknown>;
  return dictionary;
}

function selectedRecord(
  path: string,
  serverName: string,
  profileName: string,
  fields: readonly string[],
): Record<string, string> {
  const dictionary = readDictionary(path, profileName, serverName);
  if (!Object.hasOwn(dictionary, serverName)) return {};
  const entry = dictionary[serverName];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw credentialError(path, profileName, serverName, 'должны содержать объект секретных полей');
  }
  const record = entry as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => !fields.includes(field));
  if (unknownField !== undefined) {
    throw credentialError(path, profileName, serverName, `содержат неизвестное поле ${unknownField}`);
  }
  const invalidField = Object.entries(record).find(([, value]) => typeof value !== 'string');
  if (invalidField !== undefined) {
    throw credentialError(path, profileName, serverName, `содержат нестроковое поле ${invalidField[0]}`);
  }
  return record as Record<string, string>;
}

export function readServerCredentials(
  path: string,
  serverName: string,
  profileName: string,
  kind: ServerKind,
): Record<string, string> {
  const fields = SERVER_SCHEMAS[kind].secrets;
  return selectedRecord(path, serverName, profileName, fields);
}

export function describeServerCredentials(
  path: string,
  serverName: string,
  profileName: string,
  kind: ServerKind,
): Record<string, { set: boolean; source: 'file' | 'default' }> {
  const fields = SERVER_SCHEMAS[kind].secrets;
  const record = selectedRecord(path, serverName, profileName, fields);
  return Object.fromEntries(
    fields.map((field) => [
      field,
      { set: record[field] !== undefined, source: record[field] === undefined ? 'default' : 'file' },
    ]),
  );
}
