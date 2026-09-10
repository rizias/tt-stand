import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertInScope, matchesScope, parseScope, scopeExtraFilter } from '../src/scope.ts';

test('пустой перечень образцов отвергается как config_invalid', () => {
  assert.throws(
    () => parseScope([], 'namespaceScope', 'профиле broken (путь)'),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'config_invalid' &&
      /namespaceScope/.test(error.message) &&
      /broken/.test(error.message),
  );
});

test('значение не списком строк отвергается', () => {
  assert.throws(
    () => parseScope('stand-*', 'namespaceScope', 'путь'),
    (error: Error & { errorClass?: string }) => error.errorClass === 'config_invalid',
  );
});

test('пустой образец в перечне отвергается', () => {
  assert.throws(
    () => parseScope(['stand-*', '   '], 'namespaceScope', 'путь'),
    (error: Error & { errorClass?: string }) => error.errorClass === 'config_invalid',
  );
});

test('образец совпадает с именем целиком', () => {
  assert.equal(matchesScope('stand-7', ['stand-*']), true);
});

test('совпадение только части имени не считается', () => {
  assert.equal(matchesScope('pre-stand-7', ['stand-*']), false);
});

test('сопоставление чувствительно к регистру', () => {
  assert.equal(matchesScope('Stand-7', ['stand-*']), false);
});

test('без области видимости совпадает всё', () => {
  assert.equal(matchesScope('что-угодно', null), true);
});

test('выход за область — namespace_out_of_scope с профилем, именем и образцами', () => {
  assert.throws(
    () => assertInScope('prod-1', ['stand-*'], 'default'),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'namespace_out_of_scope' &&
      /prod-1/.test(error.message) &&
      /default/.test(error.message) &&
      /stand-\*/.test(error.message),
  );
});

test('без области видимости параметр ограничения не строится', () => {
  assert.equal(scopeExtraFilter(null, 'kubernetes.pod_namespace'), null);
});

test('параметр ограничения перечисляет образцы через OR регулярным фильтром', () => {
  const filter = scopeExtraFilter(['stand-*', 'qa-1'], 'kubernetes.pod_namespace');
  assert.equal(
    filter,
    '(kubernetes.pod_namespace:~"^stand-.*$" OR kubernetes.pod_namespace:~"^qa-1$")',
  );
});

test('allowMissing добавляет отдельную альтернативу для отсутствующего поля', () => {
  const filter = scopeExtraFilter(['stand-*'], 'kubernetes.pod_namespace', { allowMissing: true });
  assert.equal(filter, '(kubernetes.pod_namespace:~"^stand-.*$" OR kubernetes.pod_namespace:"")');
});

test('без allowMissing альтернативы для отсутствующего поля нет', () => {
  const filter = scopeExtraFilter(['stand-*'], 'kubernetes.pod_namespace');
  assert.ok(!filter?.includes('""'));
});
