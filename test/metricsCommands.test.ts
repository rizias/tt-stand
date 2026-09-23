import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMetricsInstant, runMetricsQuery, type MetricsContext } from '../src/commands/metrics.ts';
import type { Datasource } from '../src/datasource.ts';
import { GrafanaTransport } from '../src/grafanaTransport.ts';

const credentials = {
  kind: 'basic' as const,
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};

function datasource(candidates: Datasource['candidates'] = []): Datasource {
  return { uid: 'prom-uid', name: 'Prometheus', type: 'prometheus', candidates };
}

function context(namespaceScope: string[] | null, ds: Datasource = datasource()): MetricsContext {
  return {
    transport: new GrafanaTransport({ credentials, timeoutSeconds: null }),
    baseUrl: credentials.baseUrl,
    datasource: ds,
    profile: 'default',
    namespaceScope,
  };
}

interface Captured {
  url: string;
  body: string;
}

function stubJson(body: unknown, captured: Captured[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    captured.push({ url: String(url), body: String(init?.body ?? '') });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const matrixBody = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      {
        metric: { pod: 'a', namespace: 'stand-7' },
        values: [
          [1, '0.1'],
          [2, '0.2'],
        ],
      },
      { metric: { pod: 'b', namespace: 'other' }, values: [[1, '0.5']] },
      { metric: { pod: 'c' }, values: [[1, '0.9']] },
    ],
  },
};

test('ряд за период: запрос отправлен с четырьмя параметрами, ответ выводится целиком без области', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] } }, captured);
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'up',
      queryFile: null,
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
      step: '5m',
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('query'), 'up');
    assert.equal(sent.get('start'), '2026-01-01T00:00:00Z');
    assert.equal(sent.get('end'), '2026-01-01T01:00:00Z');
    assert.equal(sent.get('step'), '5m');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.step, '5m');
    assert.deepEqual(echo.serverChosen, []);
    assert.equal(echo.datasourceType, 'prometheus');
    assert.equal(echo.datasourceUid, 'prom-uid');
    assert.equal(echo.limit, null);
    assert.match(echo.limitNote as string, /у команд метрик лимита нет/);
  } finally {
    restore();
  }
});

test('шаг не задан: в запросе нет step, эхо называет, что его выбрал сервер', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] } }, captured);
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'up',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('step'), null);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.deepEqual(echo.serverChosen, ['step']);
  } finally {
    restore();
  }
});

test('область задана: ряд по namespace вне области исключён и учтён, ряд без namespace исключён отдельно', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(matrixBody, captured);
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const data = response.data as { result: Array<{ metric: Record<string, string> }> };
    assert.equal(data.result.length, 1);
    assert.equal(data.result[0]?.metric.namespace, 'stand-7');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.recordsOutOfScope, 1);
    assert.equal(echo.seriesWithoutNamespace, 1);
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /namespace вне области видимости профиля/);
    assert.match(response.incompleteReasons.join(' '), /ряды без метки namespace/);
    const summary = response.summary as { seriesCount: number; pointCount: number };
    assert.equal(summary.seriesCount, 1);
    assert.equal(summary.pointCount, 2);
  } finally {
    restore();
  }
});

test('область не задана: все ряды выводятся', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(matrixBody, captured);
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const data = response.data as { result: unknown[] };
    assert.equal(data.result.length, 3);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('сервер вернул isPartial и warnings — обе причины неполноты, warnings дословно в summary.server', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    {
      status: 'success',
      data: { resultType: 'matrix', result: [] },
      isPartial: true,
      warnings: ['частичный охват шардов'],
    },
    captured,
  );
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /isPartial/);
    assert.match(response.incompleteReasons.join(' '), /предупреждения/);
    const summary = response.summary as { server: { warnings: string[] } };
    assert.deepEqual(summary.server.warnings, ['частичный охват шардов']);
  } finally {
    restore();
  }
});

test('metrics instant: время не задано — serverChosen называет time, запрос без time', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'vector', result: [] } }, captured);
  try {
    const response = await runMetricsInstant(context(null), {
      query: 'up',
      queryFile: null,
      time: null,
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.has('time'), false);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.deepEqual(echo.serverChosen, ['time']);
    assert.equal(echo.start, null);
    assert.equal(echo.end, null);
  } finally {
    restore();
  }
});

test('metrics instant: точек столько же, сколько рядов у vector', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { pod: 'a' }, value: [1, '1'] },
          { metric: { pod: 'b' }, value: [1, '2'] },
        ],
      },
    },
    captured,
  );
  try {
    const response = await runMetricsInstant(context(null), {
      query: 'up',
      queryFile: null,
      time: '2026-01-01T00:00:00Z',
    });
    const summary = response.summary as { seriesCount: number; pointCount: number };
    assert.equal(summary.seriesCount, 2);
    assert.equal(summary.pointCount, 2);
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('time'), '2026-01-01T00:00:00Z');
  } finally {
    restore();
  }
});

test('датасорс задан в конфигурации — заметка об источнике отсутствует', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] } }, captured);
  try {
    const explicit: Datasource = { uid: 'fixed', name: 'задан в конфигурации', type: null, candidates: [] };
    const response = await runMetricsQuery(context(null, explicit), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.datasourceNote, null);
    assert.equal(echo.datasource, 'задан в конфигурации');
  } finally {
    restore();
  }
});

test('несколько подходящих источников — заметка называет остальных с типами', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] } }, captured);
  try {
    const ds = datasource([
      { uid: 'a', name: 'первый', type: 'prometheus' },
      { uid: 'b', name: 'второй', type: 'victoriametrics-metrics-datasource' },
    ]);
    const response = await runMetricsQuery(context(null, ds), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.match(echo.datasourceNote as string, /^подходящих источников несколько/);
    assert.match(echo.datasourceNote as string, /первый \(prometheus\)/);
    assert.match(echo.datasourceNote as string, /второй \(victoriametrics-metrics-datasource\)/);
    assert.match(echo.datasourceNote as string, /grafana.metricsDatasourceUid/);
  } finally {
    restore();
  }
});

test('единственный подходящий источник — заметка про автоматический выбор', async () => {
  const captured: Captured[] = [];
  const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] } }, captured);
  try {
    const ds = datasource([{ uid: 'a', name: 'первый', type: 'prometheus' }]);
    const response = await runMetricsQuery(context(null, ds), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.datasourceNote, 'источник выбран автоматически: единственный подходящий по типу');
  } finally {
    restore();
  }
});

test('отказ сервера метрик сохраняет эхо запроса', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { status: 'error', errorType: 'bad_data', error: 'некорректное выражение' },
      { status: 422 },
    )) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        runMetricsQuery(context(null), {
          query: '((',
          queryFile: null,
          start: '-1h',
          end: 'now',
          step: null,
        }),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'metrics_query_rejected' &&
        error.echo?.query === '((' &&
        error.echo?.request === 'POST /api/v1/query_range query=%28%28&start=-1h&end=now' &&
        error.echo?.profile === 'default',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('область задана: одиночное значение scalar не выводится и учтено как ряд без namespace', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    { status: 'success', data: { resultType: 'scalar', result: [1, '42'] } },
    captured,
  );
  try {
    const response = await runMetricsInstant(context(['stand-*']), {
      query: 'scalar(sum(up))',
      queryFile: null,
      time: null,
    });
    assert.deepEqual(response.data, { resultType: 'scalar', result: null });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.seriesWithoutNamespace, 1);
    assert.equal(response.incomplete, true);
  } finally {
    restore();
  }
});

test('область не задана: одиночное значение scalar выводится как есть', async () => {
  const captured: Captured[] = [];
  const body = { status: 'success', data: { resultType: 'scalar', result: [1, '42'] } };
  const restore = stubJson(body, captured);
  try {
    const response = await runMetricsInstant(context(null), {
      query: 'scalar(sum(up))',
      queryFile: null,
      time: null,
    });
    assert.deepEqual(response.data, body.data);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('область задана: matrix с result не массивом не выводится, причина — ответ неожиданного вида', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    { status: 'success', data: { resultType: 'matrix', result: { неожиданно: true } } },
    captured,
  );
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.data, null);
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('область не задана: matrix с result не массивом отдаётся как есть', async () => {
  const captured: Captured[] = [];
  const body = { status: 'success', data: { resultType: 'matrix', result: { неожиданно: true } } };
  const restore = stubJson(body, captured);
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.deepEqual(response.data, body.data);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('pointCount matrix считает точки values и histograms', async () => {
  const captured: Captured[] = [];
  const restore = stubJson(
    {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          { metric: { pod: 'a' }, values: [[1, '1'], [2, '2']], histograms: [[1, {}]] },
        ],
      },
    },
    captured,
  );
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const summary = response.summary as { seriesCount: number; pointCount: number };
    assert.equal(summary.seriesCount, 1);
    assert.equal(summary.pointCount, 3);
  } finally {
    restore();
  }
});

test('G1: область не задана, result содержит null — подсчёт не падает, data отдаётся как пришла', async () => {
  const captured: Captured[] = [];
  const body = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [null, { metric: {}, values: [[1, '1']] }],
    },
  };
  const restore = stubJson(body, captured);
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.data, body.data);
    const summary = response.summary as { seriesCount: number; pointCount: number };
    assert.equal(summary.seriesCount, 1);
    assert.equal(summary.pointCount, 1);
  } finally {
    restore();
  }
});
