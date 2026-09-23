import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Datasource } from '../src/datasource.ts';
import { callMetrics } from '../src/metrics.ts';
import { GrafanaTransport } from '../src/grafanaTransport.ts';

const credentials = {
  kind: 'basic' as const,
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};

const datasource: Datasource = {
  uid: 'prom-uid',
  name: 'Prometheus',
  type: 'prometheus',
  candidates: [],
};

function transport(): GrafanaTransport {
  return new GrafanaTransport({ credentials, timeoutSeconds: 5 });
}

const lastRequest = { url: '', method: '' };

function stubResponse(body: string, status: number, statusText = 'OK'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    lastRequest.url = String(url);
    lastRequest.method = init?.method ?? 'GET';
    return new Response(body, { status, statusText });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('успешный ответ query_range возвращается целиком', async () => {
  const restore = stubResponse(
    JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    200,
  );
  try {
    const call = await callMetrics(
      transport(),
      credentials.baseUrl,
      datasource,
      'POST',
      'api/v1/query_range',
      new URLSearchParams({ query: 'up', start: '-1h', end: 'now' }),
    );
    assert.equal(call.envelope.status, 'success');
    assert.deepEqual(call.envelope.data, { resultType: 'matrix', result: [] });
    assert.equal(call.request, 'POST /api/v1/query_range query=up&start=-1h&end=now');
  } finally {
    restore();
  }
});

test('status: error при 200 даёт metrics_query_rejected', async () => {
  const restore = stubResponse(
    JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'выражение не разобрано' }),
    200,
  );
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: '((' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'metrics_query_rejected' &&
        error.message.includes('HTTP 200') &&
        error.message.includes('bad_data') &&
        error.message.includes('выражение не разобрано'),
    );
  } finally {
    restore();
  }
});

test('status: error при 422 называет код и сообщение сервера целиком', async () => {
  const restore = stubResponse(
    JSON.stringify({
      status: 'error',
      errorType: 'bad_data',
      error: 'query processing would load too many samples into memory',
    }),
    422,
    'Unprocessable Entity',
  );
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query_range',
          new URLSearchParams({ query: 'up', start: '-30d', end: 'now', step: '1s' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'metrics_query_rejected' &&
        error.message.includes('HTTP 422') &&
        error.message.includes('query processing would load too many samples into memory'),
    );
  } finally {
    restore();
  }
});

test('status: error — текст дописывает тело ответа целиком после error', async () => {
  const body = JSON.stringify({
    status: 'error',
    errorType: 'bad_data',
    error: 'query processing would load too many samples into memory',
  });
  const restore = stubResponse(body, 422, 'Unprocessable Entity');
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query_range',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'metrics_query_rejected' &&
        error.message.includes(`error: query processing would load too many samples into memory; тело ответа: ${body}`),
    );
  } finally {
    restore();
  }
});

test('отказ без status: error разбирается общим путём транспорта', async () => {
  const restore = stubResponse('внутренняя ошибка', 500, 'Internal Server Error');
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes('внутренняя ошибка'),
    );
  } finally {
    restore();
  }
});

test('401 без status: error даёт auth_failed', async () => {
  const restore = stubResponse('unauthorized', 401, 'Unauthorized');
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'auth_failed',
    );
  } finally {
    restore();
  }
});

test('401 с телом status: error всё равно даёт auth_failed, а не metrics_query_rejected', async () => {
  const restore = stubResponse(
    JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'выражение не разобрано' }),
    401,
    'Unauthorized',
  );
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'auth_failed',
    );
  } finally {
    restore();
  }
});

test('403 с телом status: error всё равно даёт auth_failed', async () => {
  const restore = stubResponse(
    JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'выражение не разобрано' }),
    403,
    'Forbidden',
  );
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'auth_failed',
    );
  } finally {
    restore();
  }
});

test('status: error без полей errorType и error — текст называет их «отсутствует»', async () => {
  const restore = stubResponse(JSON.stringify({ status: 'error' }), 200);
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'metrics_query_rejected' &&
        error.message.includes('errorType: отсутствует') &&
        error.message.includes('error: отсутствует'),
    );
  } finally {
    restore();
  }
});

test('status: error с error не строкового типа — текст содержит его представление JSON', async () => {
  const restore = stubResponse(
    JSON.stringify({ status: 'error', errorType: 'bad_data', error: { code: 42 } }),
    200,
  );
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'metrics_query_rejected' && error.message.includes('error: {"code":42}'),
    );
  } finally {
    restore();
  }
});

test('GET без параметров уходит без «?» в конце пути', async () => {
  const restore = stubResponse(JSON.stringify({ status: 'success', data: [] }), 200);
  try {
    await callMetrics(
      transport(),
      credentials.baseUrl,
      datasource,
      'GET',
      'api/v1/labels',
      new URLSearchParams(),
    );
    assert.doesNotMatch(lastRequest.url, /\?$/);
    assert.match(lastRequest.url, /api\/v1\/labels$/);
  } finally {
    restore();
  }
});

test('GET уходит с параметрами в строке запроса, а не в теле', async () => {
  const restore = stubResponse(JSON.stringify({ status: 'success', data: ['stand-7'] }), 200);
  try {
    await callMetrics(
      transport(),
      credentials.baseUrl,
      datasource,
      'GET',
      'api/v1/label/namespace/values',
      new URLSearchParams({ start: '-1h', end: 'now' }),
    );
    assert.match(lastRequest.url, /api\/v1\/label\/namespace\/values\?start=-1h&end=now/);
    assert.equal(lastRequest.method, 'GET');
  } finally {
    restore();
  }
});

test('echo.request у GET без параметров — путь без «?»', async () => {
  const restore = stubResponse(JSON.stringify({ status: 'success', data: [] }), 200);
  try {
    const call = await callMetrics(
      transport(),
      credentials.baseUrl,
      datasource,
      'GET',
      'api/v1/labels',
      new URLSearchParams(),
    );
    assert.equal(call.request, 'GET /api/v1/labels');
  } finally {
    restore();
  }
});

test('echo.request у GET с параметрами — путь и строка запроса через «?», без тела', async () => {
  const restore = stubResponse(JSON.stringify({ status: 'success', data: ['stand-7'] }), 200);
  try {
    const call = await callMetrics(
      transport(),
      credentials.baseUrl,
      datasource,
      'GET',
      'api/v1/label/namespace/values',
      new URLSearchParams({ start: '-1h', end: 'now' }),
    );
    assert.equal(call.request, 'GET /api/v1/label/namespace/values?start=-1h&end=now');
  } finally {
    restore();
  }
});

test('тело 2xx — корректный JSON-массив — upstream_error независимо от области', async () => {
  const restore = stubResponse(JSON.stringify([1, 2, 3]), 200);
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes('[1,2,3]'),
    );
  } finally {
    restore();
  }
});

test('тело 2xx — объект без status: success — upstream_error', async () => {
  const restore = stubResponse(JSON.stringify({ data: { resultType: 'vector', result: [] } }), 200);
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'upstream_error',
    );
  } finally {
    restore();
  }
});

test('тело 2xx не разобралось как JSON — текст содержит тело целиком, а не только сообщение разборщика', async () => {
  const restore = stubResponse('это не JSON вовсе', 200);
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes('это не JSON вовсе'),
    );
  } finally {
    restore();
  }
});

test('пустое тело успешного ответа даёт upstream_error, а не пустой success', async () => {
  const restore = stubResponse('', 200);
  try {
    await assert.rejects(
      () =>
        callMetrics(
          transport(),
          credentials.baseUrl,
          datasource,
          'POST',
          'api/v1/query',
          new URLSearchParams({ query: 'up' }),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'upstream_error',
    );
  } finally {
    restore();
  }
});
