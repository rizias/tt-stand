import type { parseArgs } from 'node:util';
import { ToolError } from '../errors.ts';

export const USAGE = `tt-stand — чтение логов и состояния тестовых окружений. Только чтение.

  tt-stand logs query  --query <LogsQL> --start <время> --end <время> [--limit N]
  tt-stand logs search --value <значение> [--value ...] --start <время> --end <время> [--limit N]
  tt-stand logs http [--query <LogsQL> | --value <значение> [--value ...]] --start <время> --end <время> [--limit N]
  tt-stand logs fields --field <имя поля> --start <время> --end <время> [--query <LogsQL>] [--limit N]
  tt-stand token [--value <токен>]
  tt-stand k8s get <ресурс> [--namespace <ns>] [--name <имя>]
  tt-stand k8s log <под> [--namespace <ns>] [--container <имя>] [--previous]
  tt-stand k8s events [--namespace <ns>]
  tt-stand k8s pods [--namespace <ns>]
  tt-stand k8s history <рабочая нагрузка> [--namespace <ns>]
  tt-stand image <образ или тег>
  tt-stand env
  tt-stand config init [--force]
  tt-stand config profiles
  tt-stand init [путь к проекту] [--for claude,agents]
  tt-stand update

Общие флаги:
  --human            человекочитаемый вывод (по умолчанию JSON)
  --config <путь>    файл конфигурации (иначе TT_STAND_CONFIG, иначе ~/.tt-stand/config.json)
  --profile <имя>    профиль доступа (иначе TT_STAND_PROFILE, иначе defaultProfile из config.json)
  --help             эта справка

Данные отдаются как есть. Границы периода и выражение запроса уходят в хранилище
как даны. Инструмент не подставляет своих лимитов, не сокращает период и не порождает
вариантов написания искомого значения. Рекомендации по поиску — в скилле для агента.`;

export const OPTIONS = {
  query: { type: 'string' },
  value: { type: 'string', multiple: true },
  field: { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  limit: { type: 'string' },
  config: { type: 'string' },
  profile: { type: 'string' },
  human: { type: 'boolean' },
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
  '--start',
  '--end',
  '--value',
  '--query',
  '--field',
  '--limit',
  '--config',
  '--profile',
  '--namespace',
  '--name',
  '--container',
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

export function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
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
    throw new ToolError(
      'bad_request',
      `Значение --limit должно быть целым числом больше нуля, получено «${raw}».`,
    );
  }
  return value;
}
