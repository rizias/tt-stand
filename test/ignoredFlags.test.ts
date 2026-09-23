import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeIgnoredFlags, IGNORED_FLAGS_NOTE } from '../src/cli/ignoredFlags.ts';

test('metrics query --limit: лимит эта команда не читает', () => {
  const ignored = computeIgnoredFlags([
    'metrics',
    'query',
    '--query',
    'up',
    '--start',
    '-1h',
    '--end',
    'now',
    '--limit',
    '1',
  ]);
  assert.deepEqual(ignored, ['--limit']);
});

test('logs search --query-file: файл выражения эта команда не читает', () => {
  const ignored = computeIgnoredFlags([
    'logs',
    'search',
    '--value',
    'x',
    '--query-file',
    'f.txt',
    '--start',
    '-1h',
    '--end',
    'now',
  ]);
  assert.deepEqual(ignored, ['--query-file']);
});

test('logs query: все переданные флаги применяются — перечень пуст', () => {
  const ignored = computeIgnoredFlags([
    'logs',
    'query',
    '--query',
    '*',
    '--start',
    '-1h',
    '--end',
    'now',
    '--limit',
    '10',
    '--config',
    'c.json',
    '--profile',
    'p',
    '--human',
  ]);
  assert.deepEqual(ignored, []);
});

test('metrics instant: start и end этой командой не читаются', () => {
  const ignored = computeIgnoredFlags([
    'metrics',
    'instant',
    '--query',
    'up',
    '--start',
    '-1h',
    '--end',
    'now',
  ]);
  assert.deepEqual(ignored, ['--start', '--end']);
});

test('image: позиционный аргумент не флаг — перечень пуст даже без применяемых флагов', () => {
  const ignored = computeIgnoredFlags(['image', 'example-api:1.2.3-abcdef']);
  assert.deepEqual(ignored, []);
});

test('повтор флага в перечне не дублируется', () => {
  const ignored = computeIgnoredFlags([
    'logs',
    'search',
    '--value',
    'a',
    '--value',
    'b',
    '--limit',
    '1',
    '--limit',
    '2',
    '--start',
    '-1h',
    '--end',
    'now',
  ]);
  assert.deepEqual(ignored, []);
});

test('неизвестная команда: перечень пуст, а не список всех флагов', () => {
  const ignored = computeIgnoredFlags(['logs', 'нетакой', '--start', '-1h']);
  assert.deepEqual(ignored, []);
});

test('форма --flag=значение распознаётся так же, как --flag значение', () => {
  assert.deepEqual(computeIgnoredFlags(['metrics', 'query', '--limit=1']), ['--limit']);
});

test('IGNORED_FLAGS_NOTE — фиксированный текст пояснения', () => {
  assert.equal(
    IGNORED_FLAGS_NOTE,
    'эти флаги команда не применяет: они не повлияли на результат',
  );
});
