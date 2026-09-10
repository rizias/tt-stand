import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GrafanaClient } from '../src/grafana.ts';

const credentials = {
  kind: 'basic' as const,
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};

const datasource = { uid: 'test-uid', name: 'тестовый источник', candidates: [] };

function client(timeoutSeconds: number | null = 5): GrafanaClient {
  return new GrafanaClient({ credentials, timeoutSeconds });
}

function stubFetch(body: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function stubStatus(status: number, statusText: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('отказ', { status, statusText })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function stubJson(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('нечитаемая строка не прерывает разбор и считается', async () => {
  const restore = stubFetch('{"_time":"1"}\nне json\n{"_time":"2"}\n');
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), null);
    assert.equal(result.records.length, 2, 'годные строки потеряны');
    assert.equal(result.unparsableLines, 1);
  } finally {
    restore();
  }
});

test('лимит уходит как дан, все пришедшие записи отдаются', async () => {
  const restore = stubFetch('{"_time":"1"}\n{"_time":"2"}\n');
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), 2);
    assert.equal(result.records.length, 2, 'записи не должны выбрасываться');
    assert.equal(result.hitLimit, true, 'упор в лимит должен быть отмечен');
  } finally {
    restore();
  }
});

test('записей меньше лимита — упора в лимит нет', async () => {
  const restore = stubFetch('{"_time":"1"}\n');
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), 5);
    assert.equal(result.hitLimit, false);
    assert.equal(result.records.length, 1);
  } finally {
    restore();
  }
});

test('битая строка не влияет на признак упора в лимит', async () => {
  const restore = stubFetch('{"_time":"1"}\nне json\n{"_time":"2"}\n');
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), 3);
    assert.equal(result.hitLimit, false, 'битая строка не должна считаться записью');
    assert.equal(result.unparsableLines, 1);
  } finally {
    restore();
  }
});

test('строка, разорванная между кусками потока, собирается целиком', async () => {
  const original = globalThis.fetch;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"_time":"1","_ms'));
      controller.enqueue(encoder.encode('g":"склеено"}\n'));
      controller.close();
    },
  });
  globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), null);
    assert.equal(result.unparsableLines, 0);
    assert.equal(result.records[0]?._msg, 'склеено');
  } finally {
    globalThis.fetch = original;
  }
});

test('несколько источников — берётся первый, остальные названы', async () => {
  const restore = stubJson([
    { uid: 'a', name: 'первый', type: 'victoriametrics-logs-datasource' },
    { uid: 'b', name: 'второй', type: 'victoriametrics-logs-datasource' },
  ]);
  try {
    const resolved = await client().resolveDatasource(null);
    assert.equal(resolved.uid, 'a', 'инструмент не должен отказывать в работе');
    assert.deepEqual(resolved.candidates, ['первый', 'второй']);
  } finally {
    restore();
  }
});

test('ответ без тела не выдаётся за честное «ничего не найдено»', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  try {
    const result = await client().queryLogs(datasource, new URLSearchParams(), null);
    assert.equal(result.bodyMissing, true);
    assert.equal(result.records.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('401 от Grafana даёт auth_failed', async () => {
  const restore = stubStatus(401, 'Unauthorized');
  try {
    await assert.rejects(
      () => client().queryLogs(datasource, new URLSearchParams(), null),
      (error: Error & { errorClass?: string }) => error.errorClass === 'auth_failed',
    );
  } finally {
    restore();
  }
});

test('403 на списке источников даёт datasource_list_forbidden', async () => {
  const restore = stubStatus(403, 'Forbidden');
  try {
    await assert.rejects(
      () => client().resolveDatasource(null),
      (error: Error & { errorClass?: string }) => error.errorClass === 'datasource_list_forbidden',
    );
  } finally {
    restore();
  }
});

test('5xx даёт upstream_error с кодом состояния', async () => {
  const restore = stubStatus(503, 'Service Unavailable');
  try {
    await assert.rejects(
      () => client().queryLogs(datasource, new URLSearchParams(), null),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && /503/.test(error.message),
    );
  } finally {
    restore();
  }
});

test('список источников не массивом даёт upstream_error', async () => {
  const restore = stubJson({ не: 'массив' });
  try {
    await assert.rejects(
      () => client().resolveDatasource(null),
      (error: Error & { errorClass?: string }) => error.errorClass === 'upstream_error',
    );
  } finally {
    restore();
  }
});

test('ответ field_values без перечня значений — отказ, а не пустой результат', async () => {
  const restore = stubJson({ ошибка: 'что-то' });
  try {
    await assert.rejects(
      () => client().fieldValues(datasource, new URLSearchParams()),
      (error: Error & { errorClass?: string }) => error.errorClass === 'upstream_error',
    );
  } finally {
    restore();
  }
});

test('таймаут при чтении тела даёт timeout_client и сохраняет пришедшие записи', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"_time":"1"}\n'));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new Error('aborted'));
        });
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => client(0.05).queryLogs(datasource, new URLSearchParams(), null),
      (error: Error & { errorClass?: string; partialPayload?: { records?: unknown[] } }) =>
        error.errorClass === 'timeout_client' && error.partialPayload?.records?.length === 1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('доступ токеном собирает заголовок Bearer, а не Basic', async () => {
  const original = globalThis.fetch;
  let seenAuthorization: string | undefined;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    seenAuthorization = init?.headers?.Authorization;
    return new Response('', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as unknown as typeof fetch;
  try {
    const tokenClient = new GrafanaClient({
      credentials: { kind: 'token', token: 'секрет-токен', baseUrl: 'https://grafana.example.invalid' },
      timeoutSeconds: 5,
    });
    await tokenClient.queryLogs(datasource, new URLSearchParams(), null);
    assert.equal(seenAuthorization, 'Bearer секрет-токен');
  } finally {
    globalThis.fetch = original;
  }
});
