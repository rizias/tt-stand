import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localEcho, renderHuman, type ToolResponse } from '../src/response.ts';

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
