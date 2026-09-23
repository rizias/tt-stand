import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runMetricsLabels,
  runMetricsSeries,
  type MetricsContext,
} from '../src/commands/metrics.ts';
import type { Datasource } from '../src/datasource.ts';
import { GrafanaTransport } from '../src/grafanaTransport.ts';

const credentials = {
  kind: 'basic' as const,
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};

const datasource: Datasource = { uid: 'prom-uid', name: 'Prometheus', type: 'prometheus', candidates: [] };

function context(namespaceScope: string[] | null): MetricsContext {
  return {
    transport: new GrafanaTransport({ credentials, timeoutSeconds: null }),
    baseUrl: credentials.baseUrl,
    datasource,
    profile: 'default',
    namespaceScope,
  };
}

interface Captured {
  url: string;
  method: string;
  body: string;
}

function stubJson(body: unknown, captured: Captured[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    captured.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('metrics labels без --label: POST api/v1/labels, перечень не фильтруется областью', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: ['__name__', 'namespace', 'pod'] }, captured);
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: null,
      match: null,
      start: null,
      end: null,
    });
    assert.equal(captured[0]?.method, 'POST');
    assert.match(captured[0]?.url ?? '', /api\/v1\/labels$/);
    assert.deepEqual(response.data, ['__name__', 'namespace', 'pod']);
    assert.equal(response.incomplete, false);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.deepEqual(echo.serverChosen, ['start', 'end', 'match[]']);
  } finally {
    restore();
  }
});

test('metrics labels без параметров запроса: echo.request — без завершающего пробела', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: [] }, captured);
  try {
    const response = await runMetricsLabels(context(null), {
      label: null,
      match: null,
      start: null,
      end: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.request, 'POST /api/v1/labels');
  } finally {
    restore();
  }
});

test('metrics labels --label namespace: GET, значения фильтруются как имена namespace', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: ['stand-7', 'other'] }, captured);
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: 'namespace',
      match: null,
      start: '-1h',
      end: 'now',
    });
    assert.equal(captured[0]?.method, 'GET');
    assert.match(captured[0]?.url ?? '', /api\/v1\/label\/namespace\/values/);
    assert.deepEqual(response.data, ['stand-7']);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.recordsOutOfScope, 1);
    assert.equal(response.incomplete, true);
    assert.match(
      response.incompleteReasons.join(' '),
      /часть значений метки namespace не попала в ответ/,
    );
    assert.doesNotMatch(response.incompleteReasons.join(' '), /часть рядов не попала в ответ/);
  } finally {
    restore();
  }
});

test('metrics labels --label namespace при заданной области: data не массив не выводится, причина — ответ неожиданного вида', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { не: 'массив' } }, captured);
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: 'namespace',
      match: null,
      start: null,
      end: null,
    });
    assert.equal(response.data, null);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('metrics labels --label pod при заданной области: значения скрыты целиком', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: ['a-7f', 'b-9c'] }, captured);
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: 'pod',
      match: null,
      start: null,
      end: null,
    });
    assert.deepEqual(response.data, []);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.valuesHiddenByScope, 2);
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /metrics series показывает значения вместе с namespace/);
    assert.match(response.incompleteReasons.join(' '), /\(скрыто: 2\)/);
  } finally {
    restore();
  }
});

test('metrics labels --label pod при заданной области: data не массив не выводится, причина — ответ неожиданного вида', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { не: 'массив' } }, captured);
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: 'pod',
      match: null,
      start: null,
      end: null,
    });
    assert.equal(response.data, null);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.valuesHiddenByScope, 0);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('metrics labels --label pod без области: значения выводятся целиком', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: ['a-7f', 'b-9c'] }, captured);
  try {
    const response = await runMetricsLabels(context(null), {
      label: 'pod',
      match: null,
      start: null,
      end: null,
    });
    assert.deepEqual(response.data, ['a-7f', 'b-9c']);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('metrics series: набор меток фильтруется как ряд, без namespace исключён отдельно', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    {
      status: 'success',
      data: [
        { __name__: 'up', namespace: 'stand-7', pod: 'a' },
        { __name__: 'up', namespace: 'other', pod: 'b' },
        { __name__: 'up', pod: 'c' },
      ],
    },
    captured,
  );
  try {
    const response = await runMetricsSeries(context(['stand-*']), {
      match: ['up'],
      start: '-1h',
      end: 'now',
    });
    assert.equal(captured[0]?.method, 'POST');
    const sent = new URLSearchParams(captured[0]?.body);
    assert.deepEqual(sent.getAll('match[]'), ['up']);
    assert.deepEqual(response.data, [{ __name__: 'up', namespace: 'stand-7', pod: 'a' }]);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.recordsOutOfScope, 1);
    assert.equal(echo.seriesWithoutNamespace, 1);
    const summary = response.summary as { valueCount: number };
    assert.equal(summary.valueCount, 1);
  } finally {
    restore();
  }
});

test('metrics series: несколько --match уходят отдельными match[]', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: [] }, captured);
  try {
    await runMetricsSeries(context(null), {
      match: ['up', 'down{namespace="stand-7"}'],
      start: null,
      end: null,
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.deepEqual(sent.getAll('match[]'), ['up', 'down{namespace="stand-7"}']);
  } finally {
    restore();
  }
});

test('metrics series при заданной области: data не массив не выводится, причина — ответ неожиданного вида', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { не: 'массив' } }, captured);
  try {
    const response = await runMetricsSeries(context(['stand-*']), {
      match: ['up'],
      start: null,
      end: null,
    });
    assert.equal(response.data, null);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('metrics series без области: data не массив отдаётся как есть', async () => {
  const captured: Captured[] = [];
  const body = { status: 'success', data: { не: 'массив' } };
  const restore = stubJson(body, captured);
  try {
    const response = await runMetricsSeries(context(null), {
      match: ['up'],
      start: null,
      end: null,
    });
    assert.deepEqual(response.data, body.data);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});
