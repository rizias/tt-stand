import { parseArgs } from 'node:util';
import { joinNegativeValues, OPTIONS } from './args.ts';

export const IGNORED_FLAGS_NOTE =
  'эти флаги команда не применяет: они не повлияли на результат';

const COMMON_FLAGS = new Set(['config', 'profile', 'human', 'help']);

const TWO_WORD_GROUPS = new Set(['logs', 'metrics', 'k8s', 'config']);

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  'logs query': ['query', 'query-file', 'start', 'end', 'limit'],
  'logs search': ['value', 'start', 'end', 'limit'],
  'logs http': ['query', 'query-file', 'value', 'start', 'end', 'limit'],
  'logs fields': ['field', 'query', 'query-file', 'start', 'end', 'limit'],
  'metrics query': ['query', 'query-file', 'start', 'end', 'step'],
  'metrics instant': ['query', 'query-file', 'time'],
  'metrics labels': ['label', 'match', 'start', 'end'],
  'metrics series': ['match', 'start', 'end'],
  'k8s get': ['namespace', 'name'],
  'k8s log': ['namespace', 'container', 'previous'],
  'k8s events': ['namespace'],
  'k8s pods': ['namespace'],
  'k8s history': ['namespace'],
  'config init': ['force'],
  'config profiles': [],
  token: ['value'],
  image: [],
  env: [],
  init: ['for'],
};

function commandKey(positionals: string[]): string {
  const group = positionals[0];
  if (group === undefined) return '';
  const action = positionals[1];
  if (TWO_WORD_GROUPS.has(group) && action !== undefined) return `${group} ${action}`;
  return group;
}

function commandPositionals(argv: string[]): string[] {
  try {
    return parseArgs({
      args: joinNegativeValues(argv),
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }).positionals;
  } catch {
    return [];
  }
}

function passedFlagNames(argv: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name.length === 0 || !(name in OPTIONS) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function computeIgnoredFlags(argv: string[]): string[] {
  const key = commandKey(commandPositionals(argv));
  const applicable = COMMAND_FLAGS[key];
  if (applicable === undefined) return [];
  const applicableSet = new Set(applicable);
  const ignored: string[] = [];
  for (const name of passedFlagNames(argv)) {
    if (COMMON_FLAGS.has(name) || applicableSet.has(name)) continue;
    ignored.push(`--${name}`);
  }
  return ignored;
}
