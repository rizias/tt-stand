import type { FieldValue } from '../configSchemas.ts';
import { credentialsFileState, describeServerCredentials } from '../credentials.ts';
import { loadSelectedProfile, resolveProfileSelection, summarizeProfiles } from '../profiles.ts';
import { localEcho, type ToolResponse } from '../response.ts';

function response(command: string, data: unknown, profile: string): ToolResponse {
  return {
    ok: true,
    command,
    data,
    summary: null,
    echo: { ...localEcho(command), profile },
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}

function publicUrl(value: string): string {
  if (!/^\s*[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.href;
    }
    if (!['http:', 'https:', 'mongodb:', 'mongodb+srv:'].includes(url.protocol) && value.includes('@')) {
      return '[адрес с учётными данными скрыт]';
    }
  } catch {
    if (value.includes('@')) return '[некорректный адрес скрыт]';
  }
  return value;
}

function publicFields(fields: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      { ...field, value: typeof field.value === 'string' ? publicUrl(field.value) : field.value },
    ]),
  );
}

export function runConfigShow(configArgument?: string, profileArgument: string | null = null): ToolResponse {
  const selection = resolveProfileSelection(configArgument, profileArgument, { allowEmptyDefault: true });
  const profile = loadSelectedProfile(selection);
  const servers = Object.fromEntries(
    Object.entries(profile.servers).map(([name, server]) => [
      name,
      {
        fields: publicFields(profile.serverSources[name]!),
        secrets: describeServerCredentials(profile.credentialsFile, name, profile.name, server.kind),
      },
    ]),
  );
  return response(
    'config',
    {
      configPath: selection.rootPath,
      defaultProfile: selection.defaultProfile,
      profile: profile.name,
      profileSource: selection.source,
      profilePath: profile.path,
      credentialsPath: profile.credentialsFile,
      fields: publicFields(profile.fieldSources),
      grafana: profile.grafana
        ? {
            ...profile.grafana,
            baseUrl: profile.grafana.baseUrl === null ? null : publicUrl(profile.grafana.baseUrl),
            credentials: credentialsFileState(profile.grafana.credentialsFile),
          }
        : null,
      kubernetes: profile.kubernetes,
      servers,
    },
    profile.name,
  );
}

export function runConfigProfiles(configArgument?: string, profileArgument: string | null = null): ToolResponse {
  const summary = summarizeProfiles(configArgument, profileArgument);
  return {
    ...response('config profiles', summary, summary.currentProfile),
    summary: { profileCount: summary.profiles.length },
  };
}
