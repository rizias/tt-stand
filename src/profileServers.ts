import { dirname } from 'node:path';
import { SERVER_SCHEMAS, type FieldSchema, type FieldValue, type Server, type ServerKind } from './configSchemas.ts';
import { assertKnownFields, expectNumber, expectString, expectTable } from './configValues.ts';
import { ToolError } from './errors.ts';
import { normalizePathFrom } from './paths.ts';

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

function invalidField(field: string, location: string, rule: string): never {
  throw new ToolError('config_invalid', `Поле ${field} в ${location} ${rule}. Исправьте поле в файле профиля.`);
}

function validateUri(value: string, field: string, location: string): void {
  if (value !== value.trim()) invalidField(field, location, 'должно содержать URI без окружающих пробелов');
  const authority = /^mongodb(?:\+srv)?:\/\/([^/?#]+)/u.exec(value)?.[1];
  if (!authority) {
    invalidField(field, location, 'должно содержать URI MongoDB с адресом сервера');
  }
  if (authority.includes('@')) {
    invalidField(field, location, 'должно содержать URI без учётных данных');
  }
  const query = /^[^?#]*\?([^#]*)/u.exec(value.replace(/[\t\r\n]/gu, ''))?.[1] ?? '';
  const forbidden = new Set([
    'tlscertificatekeyfilepassword',
    'passphrase',
    'key',
    'pfx',
    'authmechanismproperties',
    'proxyusername',
    'proxypassword',
  ]);
  for (const key of new URLSearchParams(query).keys()) {
    if (forbidden.has(key.toLowerCase())) invalidField(field, location, 'содержит секретный параметр URI');
  }
}

function validateString(value: string, schema: FieldSchema, field: string, location: string): string {
  if (schema.uri) validateUri(value, field, location);
  if (schema.path && /[\u0000\r\n]/u.test(value)) invalidField(field, location, 'должно содержать путь');
  return value;
}

function numberValue(value: unknown, schema: FieldSchema, field: string, location: string): number {
  const parsed = expectNumber(value, field, location);
  if (schema.positive && parsed <= 0) invalidField(field, location, 'должно быть больше нуля');
  if (field.endsWith('.timeoutSeconds') && parsed > MAX_TIMEOUT_SECONDS) {
    invalidField(field, location, `должно быть не больше ${MAX_TIMEOUT_SECONDS} секунды`);
  }
  if (schema.port && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
    invalidField(field, location, 'должно быть целым числом от 1 до 65535');
  }
  return parsed;
}

function resolveField(raw: unknown, schema: FieldSchema, field: string, path: string): FieldValue {
  const source = raw === undefined ? 'default' : 'file';
  const value = raw === undefined ? schema.default : raw;
  if (value === null && raw === undefined) return { value, source };
  if (schema.type === 'number') return { value: numberValue(value, schema, field, path), source };
  const parsed = validateString(expectString(value, field, path), schema, field, path);
  return { value: schema.path && parsed.length > 0 ? normalizePathFrom(dirname(path), parsed) : parsed, source };
}

function resolveKind(value: unknown, name: string, path: string): FieldValue {
  if (typeof value !== 'string' || !Object.hasOwn(SERVER_SCHEMAS, value)) {
    invalidField(`servers.${name}.kind`, path, 'должно быть ssh или mongodb');
  }
  return { value, source: 'file' };
}

export function parseServers(
  raw: unknown,
  path: string,
): {
  servers: Record<string, Server>;
  sources: Record<string, Record<string, FieldValue>>;
} {
  const servers: Record<string, Server> = {};
  const sources: Record<string, Record<string, FieldValue>> = {};
  for (const [name, entry] of Object.entries(expectTable(raw, 'servers', path) ?? {})) {
    if (!/^[\p{L}\p{N}_.-]+$/u.test(name) || ['.', '..', '__proto__'].includes(name)) {
      invalidField(
        'servers',
        path,
        'должно содержать непустые имена серверов из букв, цифр, точек, дефисов и подчёркиваний',
      );
    }
    if (['kind', 'login', 'password', 'token'].includes(name)) {
      invalidField('servers', path, `содержит зарезервированное имя сервера ${name}`);
    }
    const table = expectTable(entry, `servers.${name}`, path) ?? {};
    const kindField = resolveKind(table.kind, name, path);
    const kind = kindField.value as ServerKind;
    const schema = SERVER_SCHEMAS[kind];
    assertKnownFields(table, ['kind', ...Object.keys(schema.fields)], `servers.${name}`, path);
    const fields: Record<string, FieldValue> = { kind: kindField };
    for (const [field, definition] of Object.entries(schema.fields)) {
      fields[field] = resolveField(table[field], definition, `servers.${name}.${field}`, path);
    }
    servers[name] = Object.fromEntries(
      Object.entries(fields).map(([field, resolved]) => [field, resolved.value]),
    ) as unknown as Server;
    sources[name] = fields;
  }
  validateReferences(servers, path);
  return { servers, sources };
}

function validateReferences(servers: Record<string, Server>, path: string): void {
  for (const [name, server] of Object.entries(servers)) {
    if (server.kind === 'mongodb' && server.sshServer !== null && server.sshServer !== '') {
      if (servers[server.sshServer]?.kind !== 'ssh') {
        invalidField(`servers.${name}.sshServer`, path, 'должно ссылаться на SSH-сервер этого профиля');
      }
    }
  }
}
