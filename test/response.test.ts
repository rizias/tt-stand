import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localEcho, renderHuman, renderJson, type ToolResponse } from '../src/response.ts';

function response(data: unknown): ToolResponse {
  return {
    ok: true,
    command: 'metrics labels',
    data,
    summary: { valueCount: Array.isArray(data) ? data.length : 0 },
    echo: localEcho('metrics labels'),
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}

test('G2: элемент массива data, не являющийся объектом, печатается одной строкой своим значением', () => {
  const output = renderHuman(response(['pod-a', 'pod-b']));
  assert.match(output, /^pod-a$/m);
  assert.match(output, /^pod-b$/m);
});

test('G2: null в массиве data печатается как null и не роняет вывод', () => {
  const output = renderHuman(response(['pod-a', null]));
  assert.match(output, /^pod-a$/m);
  assert.match(output, /^null$/m);
});

test('MongoDB сохраняет поля record, http и environment в обоих форматах', () => {
  const document = {
    record: { nested: { $numberLong: '9007199254740993' } },
    http: 'исходное поле',
    environment: { name: 'fictional' },
    additional: { $oid: '507f1f77bcf86cd799439011' },
  };
  const result = response([document]);
  result.command = 'mongo';
  result.echo = localEcho('mongo');
  assert.deepEqual(JSON.parse(renderJson(result)).data, [document]);
  assert.ok(renderHuman(result).includes(JSON.stringify([document], null, 2)));
});

test('обычная запись с полем record полностью выводится в human', () => {
  const output = renderHuman(response([{ record: 'исходное поле', value: 7 }]));
  assert.match(output, /record: исходное поле/u);
  assert.match(output, /value: 7/u);
});
