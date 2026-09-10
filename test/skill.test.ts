import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ERROR_CLASSES, INCOMPLETENESS_REASONS } from '../src/errors.ts';

const root = join(import.meta.dirname, '..');
const skill = readFileSync(join(root, 'skills', 'tt-stand', 'SKILL.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[];
};

const UPSTREAM_SHAPED = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+-\d{2,5}\b/g;
const REAL_HOST = /\b[a-z0-9-]+\.(?:ru|com|net|local|internal|lan|corp)\b/g;

test('скилл поставляется вместе с пакетом', () => {
  assert.ok(manifest.files.includes('skills'), 'каталог скиллов должен входить в состав пакета');
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
  for (const marker of [
    'Исходная строка журнала',
    'Вызов:',
    'Фактический ответ',
    'Ожидаемый вывод',
  ]) {
    assert.ok(skill.includes(marker), `в примерах нет части «${marker}»`);
  }
  assert.match(skill, /Пример нарезки периода/);
});

test('скилл называет все три источника выбора профиля', () => {
  assert.ok(skill.includes('--profile <имя>'), 'не назван флаг --profile');
  assert.ok(skill.includes('TT_STAND_PROFILE'), 'не названа переменная окружения');
  assert.ok(skill.includes('defaultProfile'), 'не названо поле умолчания');
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
  for (const errorClass of [
    'credentials_missing',
    'credentials_incomplete',
    'auth_failed',
    'profile_incomplete',
  ]) {
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

test('скилл называет каждый из четырёх запретов и причину про журнал вызовов', () => {
  assert.match(skill, /## Запреты/);
  assert.ok(skill.includes('читать и выводить содержимое `credentials.json`'));
  assert.ok(skill.includes('записывать в него значения'));
  assert.ok(skill.includes('передавать логин, пароль или токен аргументом команды'));
  assert.ok(skill.includes('повторять в своём ответе значение доступа'));
  assert.match(skill, /вызов пишется в журнал целиком/iu);
  assert.match(skill, /останется в журнале открытым текстом/iu);
});

test('скилл направляет проверку заполненности учётных данных на команду, а не на чтение файла', () => {
  assert.match(skill, /используй `tt-stand config\s+profiles`: команда отвечает признаком заполненности/iu);
});

test('в скилле только вымышленные имена окружений и хостов', () => {
  const upstreamShaped = skill.match(UPSTREAM_SHAPED) ?? [];
  const foreign = upstreamShaped.filter((name) => !name.startsWith('fictional-'));
  assert.deepEqual(
    foreign,
    [],
    `имена окружений должны начинаться с fictional-: ${foreign.join(', ')}`,
  );

  const realHosts = skill.match(REAL_HOST) ?? [];
  assert.deepEqual(realHosts, [], `хосты должны быть вымышленными: ${realHosts.join(', ')}`);
});
