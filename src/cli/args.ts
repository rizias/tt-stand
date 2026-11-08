import { parseArgs } from 'node:util';
import { ToolError } from '../errors.ts';

export const USAGE = `tt-stand — чтение логов и состояния тестовых окружений. Только чтение.

  tt-stand logs query  (--query <LogsQL> | --query-file <путь>) --start <время> --end <время> [--limit N]
  tt-stand logs search --value <значение> [--value ...] --start <время> --end <время> [--limit N]
  tt-stand logs http [--query <LogsQL> | --query-file <путь> | --value <значение> [--value ...]] --start <время> --end <время> [--limit N]
  tt-stand logs fields --field <имя поля> --start <время> --end <время> [--query <LogsQL> | --query-file <путь>] [--limit N]
  tt-stand metrics query   (--query <PromQL> | --query-file <путь>) --start <время> --end <время> [--step <шаг>]
  tt-stand metrics instant (--query <PromQL> | --query-file <путь>) [--time <время>]
  tt-stand metrics labels  [--label <имя>] [--match <селектор> ...] [--start <время>] [--end <время>]
  tt-stand metrics series  --match <селектор> [--match ...] [--start <время>] [--end <время>]
  tt-stand batch --file <пакет.json> --out <каталог> [--start <время>] [--end <время>] [--view <вид.json>] [--baseline <manifest.json>]
  tt-stand token [--value <токен>]
  tt-stand k8s get <ресурс> [--namespace <ns>] [--name <имя>]
  tt-stand k8s log <под> [--namespace <ns>] [--container <имя>] [--previous]
  tt-stand k8s events [--namespace <ns>]
  tt-stand k8s pods [--namespace <ns>]
  tt-stand k8s history <рабочая нагрузка> [--namespace <ns>]
  tt-stand image <образ или тег>
  tt-stand mongo (--query <JSON> | --query-file <путь>) [--server <имя>] [--database <база>]
  tt-stand env
  tt-stand config [--json]
  tt-stand config init [--profile <имя>] [--force]
  tt-stand config profiles
  tt-stand init [путь к проекту] [--for <назначение>]
  tt-stand update

Общие флаги:
  --human            человекочитаемый вывод (по умолчанию JSON)
  --config <путь>    файл конфигурации (иначе TT_STAND_CONFIG, иначе ~/.tt-stand/config.json)
  --profile <имя>    профиль доступа (затем TT_STAND_PROFILE, defaultProfile — профиль по умолчанию)
  --json             машиночитаемый вывод (включён по умолчанию)
  --help             эта справка

Данные отдаются как есть. Границы периода и выражение запроса уходят в хранилище
как даны. Инструмент не подставляет своих лимитов, не сокращает период и не порождает
вариантов написания искомого значения. Рекомендации по поиску — в скилле для агента.`;

export const OPTIONS = {
  file: { type: 'string' },
  out: { type: 'string' },
  view: { type: 'string' },
  baseline: { type: 'string' },
  query: { type: 'string' },
  'query-file': { type: 'string' },
  value: { type: 'string', multiple: true },
  field: { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  step: { type: 'string' },
  time: { type: 'string' },
  match: { type: 'string', multiple: true },
  label: { type: 'string' },
  limit: { type: 'string' },
  config: { type: 'string' },
  profile: { type: 'string' },
  server: { type: 'string' },
  database: { type: 'string' },
  human: { type: 'boolean' },
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  for: { type: 'string' },
  namespace: { type: 'string' },
  name: { type: 'string' },
  container: { type: 'string' },
  previous: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

export type ParsedValues = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];

const VALUE_FLAGS = new Set([
  '--file',
  '--out',
  '--view',
  '--baseline',
  '--start',
  '--end',
  '--value',
  '--query',
  '--query-file',
  '--field',
  '--limit',
  '--config',
  '--profile',
  '--server',
  '--database',
  '--namespace',
  '--name',
  '--container',
  '--step',
  '--time',
  '--match',
  '--label',
]);

const KNOWN_FLAGS = new Set(Object.keys(OPTIONS).map((name) => `--${name}`));

function isKnownFlag(token: string): boolean {
  return KNOWN_FLAGS.has(token) || KNOWN_FLAGS.has(token.slice(0, token.indexOf('=')));
}

export function joinNegativeValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(token) && next?.startsWith('-') && !isKnownFlag(next)) {
      out.push(`${token}=${next}`);
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

export function publicInvocation(argv: string[]): string[] {
  try {
    parseArgs({ args: joinNegativeValues(argv), options: OPTIONS, allowPositionals: true, strict: true });
    return argv;
  } catch {
    return ['[некорректные аргументы скрыты]'];
  }
}

export function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new ToolError('bad_request', `Не задан обязательный параметр --${name}.`);
  }
  return value;
}

export function requiredPositional(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new ToolError('bad_request', `Не задан обязательный позиционный аргумент <${name}>.`);
  }
  return value;
}

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToolError('bad_request', `Значение --limit должно быть целым числом больше нуля, получено «${raw}».`);
  }
  return value;
}
