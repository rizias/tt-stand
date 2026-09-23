import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOGS_DATASOURCE_TYPES,
  METRICS_DATASOURCE_TYPES,
  resolveDatasource,
} from '../src/datasource.ts';
import { GrafanaTransport } from '../src/grafanaTransport.ts';

const credentials = {
  kind: 'basic' as const,
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};

function transport(): GrafanaTransport {
  return new GrafanaTransport({ credentials, timeoutSeconds: 5 });
}

function stubJson(body: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function stubStatus(status: number, statusText: string, body = 'отказ'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status, statusText })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('явный uid не запрашивает список источников', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return Response.json([]);
  }) as unknown as typeof fetch;
  try {
    const resolved = await resolveDatasource(
      transport(),
      'explicit-uid',
      LOGS_DATASOURCE_TYPES,
      'grafana.datasourceUid',
    );
    assert.equal(resolved.uid, 'explicit-uid');
    assert.equal(resolved.type, null);
    assert.equal(called, false, 'список источников не должен запрашиваться');
  } finally {
    globalThis.fetch = original;
  }
});

test('несколько подходящих источников метрик — берётся первый, остальные названы с типами', async () => {
  const restore = stubJson([
    { uid: 'a', name: 'первый', type: 'prometheus' },
    { uid: 'b', name: 'второй', type: 'victoriametrics-metrics-datasource' },
    { uid: 'c', name: 'третий', type: 'victoriametrics-logs-datasource' },
  ]);
  try {
    const resolved = await resolveDatasource(
      transport(),
      null,
      METRICS_DATASOURCE_TYPES,
      'grafana.metricsDatasourceUid',
    );
    assert.equal(resolved.uid, 'a');
    assert.equal(resolved.type, 'prometheus');
    assert.deepEqual(resolved.candidates, [
      { uid: 'a', name: 'первый', type: 'prometheus' },
      { uid: 'b', name: 'второй', type: 'victoriametrics-metrics-datasource' },
    ]);
  } finally {
    restore();
  }
});

test('подходящего источника нет — текст называет перечень типов', async () => {
  const restore = stubJson([{ uid: 'x', name: 'чужой', type: 'loki' }]);
  try {
    await assert.rejects(
      () =>
        resolveDatasource(
          transport(),
          null,
          METRICS_DATASOURCE_TYPES,
          'grafana.metricsDatasourceUid',
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'datasource_not_found' &&
        METRICS_DATASOURCE_TYPES.every((type) => error.message.includes(type)) &&
        error.message.includes('grafana.metricsDatasourceUid'),
    );
  } finally {
    restore();
  }
});

test('подходящего источника логов нет — текст называет единственный тип', async () => {
  const restore = stubJson([]);
  try {
    await assert.rejects(
      () => resolveDatasource(transport(), null, LOGS_DATASOURCE_TYPES, 'grafana.datasourceUid'),
      (error: Error & { message: string }) =>
        error.message ===
        'Среди источников данных Grafana нет ни одного с типом victoriametrics-logs-datasource. Укажите источник явно: grafana.datasourceUid в файле конфигурации.',
    );
  } finally {
    restore();
  }
});

test('403 на списке источников называет нужную настройку профиля', async () => {
  const restore = stubStatus(403, 'Forbidden');
  try {
    await assert.rejects(
      () =>
        resolveDatasource(
          transport(),
          null,
          METRICS_DATASOURCE_TYPES,
          'grafana.metricsDatasourceUid',
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'datasource_list_forbidden' &&
        error.message.includes('grafana.metricsDatasourceUid') &&
        error.message.includes('отказ'),
    );
  } finally {
    restore();
  }
});

test('список источников не массивом даёт upstream_error с телом ответа целиком', async () => {
  const restore = stubJson({ не: 'массив' });
  try {
    await assert.rejects(
      () => resolveDatasource(transport(), null, LOGS_DATASOURCE_TYPES, 'grafana.datasourceUid'),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes('{"не":"массив"}'),
    );
  } finally {
    restore();
  }
});

test('код 200 с телом не JSON — upstream_error с телом ответа целиком', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html>не JSON</html>', { status: 200 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => resolveDatasource(transport(), null, LOGS_DATASOURCE_TYPES, 'grafana.datasourceUid'),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes('<html>не JSON</html>'),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('идентификатор источника из списка Grafana — «.» — upstream_error', async () => {
  const restore = stubJson([{ uid: '.', name: 'странный', type: 'prometheus' }]);
  try {
    await assert.rejects(
      () =>
        resolveDatasource(
          transport(),
          null,
          METRICS_DATASOURCE_TYPES,
          'grafana.metricsDatasourceUid',
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' &&
        error.message.includes('странный') &&
        error.message.includes('/api/datasources/proxy/uid/'),
    );
  } finally {
    restore();
  }
});

for (const [title, entry] of [
  ['пустой строкой', { uid: '', name: 'пустой', type: 'prometheus' }],
  ['без поля uid', { name: 'пустой', type: 'prometheus' }],
  ['со значением null', { uid: null, name: 'пустой', type: 'prometheus' }],
] as const) {
  test(`идентификатор источника из списка Grafana ${title} — upstream_error`, async () => {
    const restore = stubJson([entry]);
    try {
      await assert.rejects(
        () =>
          resolveDatasource(
            transport(),
            null,
            METRICS_DATASOURCE_TYPES,
            'grafana.metricsDatasourceUid',
          ),
        (error: Error & { errorClass?: string; message: string }) =>
          error.errorClass === 'upstream_error' &&
          error.message.includes('пустой') &&
          error.message.includes('grafana.metricsDatasourceUid'),
      );
    } finally {
      restore();
    }
  });
}

test('список источников JSON не того вида — тело в тексте в исходной записи', async () => {
  const original = globalThis.fetch;
  const raw = '{\n  "error": "plugin failed"\n}';
  globalThis.fetch = (async () => new Response(raw, { status: 200 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => resolveDatasource(transport(), null, LOGS_DATASOURCE_TYPES, 'grafana.datasourceUid'),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'upstream_error' && error.message.includes(raw),
    );
  } finally {
    globalThis.fetch = original;
  }
});
