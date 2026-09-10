import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchQuery } from '../src/commands/logs.ts';

test('поиск ищет переданные значения и не порождает вариантов', () => {
  const query = buildSearchQuery(['+70000000000', '%2B70000000000']);
  assert.equal(query, '("+70000000000" OR "%2B70000000000")');
  assert.ok(!query.includes('80000000000'), 'инструмент не должен выдумывать варианты');
});

test('одно значение уходит без скобок и без изменений', () => {
  assert.equal(buildSearchQuery(['+70000000000']), '"+70000000000"');
});

test('кавычки и обратные слеши в значении экранируются, значение не теряется', () => {
  assert.equal(buildSearchQuery(['путь\\с "кавычками"']), '"путь\\\\с \\"кавычками\\""');
});

test('поиск без значений отвергается понятной ошибкой', () => {
  assert.throws(
    () => buildSearchQuery([]),
    (error: Error & { errorClass?: string }) => error.errorClass === 'bad_request',
  );
});
