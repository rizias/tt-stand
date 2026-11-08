import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { ERROR_CLASSES, INCOMPLETENESS_REASONS } from '../src/errors.ts';

const root = join(import.meta.dirname, '..');
const skillEntry = readFileSync(join(root, 'skills', 'tt-stand', 'SKILL.md'), 'utf8');
const referenceDirectory = join(root, 'skills', 'tt-stand', 'references');
const referenceContents = readdirSync(referenceDirectory)
  .filter((file) => file.endsWith('.md'))
  .map((file) => readFileSync(join(referenceDirectory, file), 'utf8'));
const skill = [skillEntry, ...referenceContents].join('\n\n');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[];
};

const UPSTREAM_SHAPED = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+-\d{2,5}\b/g;
const REAL_HOST = /\b[a-z0-9-]+\.(?:ru|com|net|local|internal|lan|corp)\b/g;

test('скилл поставляется вместе с пакетом', () => {
  assert.ok(manifest.files.includes('skills'), 'каталог скиллов должен входить в состав пакета');
});

test('точка входа содержит запуск, обновление и выбор справки без примера установки двух копий', () => {
  const headings = [...skillEntry.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, ['Первый запуск', 'Обновление', 'Справка']);
  assert.doesNotMatch(skillEntry, /--for claude,agents/u);
  assert.match(skillEntry, /Профили, credentials и приватные SSH-ключи читает только инструмент/u);
});

test('скилл называет каждый класс ошибки, который выдаёт код', () => {
  const missing = ERROR_CLASSES.filter((errorClass) => !skill.includes(errorClass));
  assert.deepEqual(missing, [], `в скилле не описаны классы: ${missing.join(', ')}`);
});

test('скилл называет каждую причину неполноты, которую выдаёт код', () => {
  const missing = Object.values(INCOMPLETENESS_REASONS)
    .map((reason) => reason.split(':')[0]?.split('—')[0]?.trim() ?? reason)
    .filter((fragment) => !skill.includes(fragment));
  assert.deepEqual(missing, [], `в скилле не описаны причины: ${missing.join(' | ')}`);
});

test('скилл предупреждает о потере ранней части периода при упоре в лимит', () => {
  assert.match(skill, /теряется ранняя часть периода/);
});

test('скилл называет умолчание: поиск идёт по всем окружениям сразу', () => {
  assert.match(skill, /по умолчанию поиск идёт по всем окружениям сразу/i);
});

test('скилл описывает порядок поиска: сначала дешёвое, потом дорогое', () => {
  assert.match(skill, /Порядок поиска/);
  assert.match(skill, /дешёвый фильтр/iu);
});

test('примеры содержат все четыре части', () => {
  for (const marker of ['Исходная строка журнала', 'Вызов:', 'Фактический ответ', 'Ожидаемый вывод']) {
    assert.ok(skill.includes(marker), `в примерах нет части «${marker}»`);
  }
  assert.match(skill, /Пример нарезки периода/);
});

test('скилл называет источники выбора профиля и сервера', () => {
  assert.ok(skill.includes('--profile <имя>'), 'не назван флаг --profile');
  assert.ok(skill.includes('TT_STAND_PROFILE'), 'не названа переменная окружения');
  assert.ok(skill.includes('defaultProfile'), 'не названо поле профиля по умолчанию');
  assert.ok(skill.includes('--config <путь к config.json>'));
  assert.ok(skill.includes('единственный доступный'));
  assert.ok(skill.includes('--server <имя>'));
});

test('скилл называет команду перечисления профилей', () => {
  assert.ok(skill.includes('tt-stand config profiles'));
});

test('скилл запрещает дублировать условие области в запросе', () => {
  assert.match(skill, /дублировать условие области[^.]*не нужно и вредно/iu);
  assert.match(skill, /сужает выборку внутри области, но не расширяет её/iu);
});

test('скилл описывает реакцию на выход за область', () => {
  assert.ok(skill.includes('namespace_out_of_scope'));
  assert.match(skill, /сообщить человеку об ограничении\s+профиля/iu);
  assert.match(skill, /не подбирать другой запрос к тому же namespace/iu);
});

test('скилл содержит раздел первичной настройки с действием на каждый класс отказа', () => {
  assert.match(skill, /## Первичная настройка/);
  for (const errorClass of ['credentials_missing', 'credentials_incomplete', 'auth_failed', 'profile_incomplete']) {
    assert.ok(skill.includes(errorClass), `не назван класс отказа ${errorClass}`);
  }
  assert.match(skill, /не приняты Grafana/iu);
  assert.match(skill, /не подбирать их перебором/iu);
  assert.match(skill, /назвать профиль и недостающую часть настроек/iu);
});

test('скилл называет, кто правит настройки, а кто вписывает доступ', () => {
  assert.match(skill, /правит агент по прямому указанию человека/iu);
  assert.match(skill, /credentials\.json.*заполняет человек сам/isu);
});

test('скилл называет запреты и безопасную диагностику аргументов', () => {
  assert.match(skill, /## Запреты/);
  assert.ok(skill.includes('читать и выводить содержимое `credentials.json`'));
  assert.ok(skill.includes('записывать в него значения'));
  assert.ok(skill.includes('передавать логин, пароль или токен доступа Grafana аргументом команды'));
  assert.ok(skill.includes('повторять в своём ответе значение доступа'));
  assert.match(skill, /Неизвестные флаги отклоняются, их значения исключаются из вывода и журнала/iu);
});

test('скилл направляет проверку заполненности учётных данных на команду, а не на чтение файла', () => {
  assert.match(skill, /используй `tt-stand config\s+profiles`: команда отвечает признаком заполненности/iu);
});

test('процедура «Кто нагружает окружение» группирует ряд по namespace и поду вместе', () => {
  const section = skill.split('## Кто нагружает окружение')[1]?.split('\n## ')[0] ?? '';
  assert.notEqual(section, '', 'раздел «Кто нагружает окружение» не найден');
  assert.match(section, /by \(namespace, pod\)/);
  assert.doesNotMatch(section, /by \(pod\)/);
  assert.doesNotMatch(section, /stand-7/);
});

test('в скилле только вымышленные имена окружений и хостов', () => {
  const upstreamShaped = skill.match(UPSTREAM_SHAPED) ?? [];
  const foreign = upstreamShaped.filter((name) => !name.startsWith('fictional-'));
  assert.deepEqual(foreign, [], `имена окружений должны начинаться с fictional-: ${foreign.join(', ')}`);

  const documentationLink = /\]\(https:\/\/grafana\.com\/docs\/[^)]*\)/gu;
  const realHosts = skill.replace(documentationLink, '').match(REAL_HOST) ?? [];
  assert.deepEqual(realHosts, [], `хосты должны быть вымышленными: ${realHosts.join(', ')}`);
});

test('первый абзац после шапки — дословно о файлах пользователя, пользователь прав', () => {
  const body = skillEntry.replace(/^---\n[\s\S]*?\n---\n\n/u, '');
  assert.ok(
    body.startsWith(
      'В папке этого скилла могут лежать файлы пользователя — всё, кроме `SKILL.md` и `references/`. Прежде чем работать, посмотри список файлов папки скилла и прочитай файлы пользователя: это его правила и заметки к этому скиллу. Профили, файлы учётных данных и приватные ключи не открывай. При расхождении со скиллом прав пользователь.\n',
    ),
  );
  assert.match(body, /Пиши только после его согласия/u);
  assert.match(body, /Значения паролей, токенов и секретов\s+не записывай никогда/u);
});

test('раздел «Справка» называет каждый файл references/ и только их', () => {
  const section = skillEntry.split('\n## Справка\n')[1]?.split('\n## ')[0] ?? '';
  const listed = [...section.matchAll(/`references\/([^`]+)`/gu)].map((match) => match[1]).sort();
  const shipped = readdirSync(join(root, 'skills', 'tt-stand', 'references')).sort();
  assert.deepEqual(listed, shipped);
});

test('рецепты нагрузки по записям входного сервера проверяют пустой разбор', () => {
  const section = skill.split('## Кто нагружает окружение')[1]?.split('\n## ')[0] ?? '';
  assert.match(section, /stats by \(_time:1h, upstream\) count\(\) requests/);
  assert.match(section, /count\(\) if \(upstream:""\) unparsed/);
  assert.match(section, /quantile\(0\.95, request_time\)/);
  assert.match(section, /У секретов читай\s+только имена/u);
  assert.match(section, /node_uname_info/);
});
