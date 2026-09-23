import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runMetricsInstant,
  runMetricsLabels,
  runMetricsQuery,
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

function stubJson(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('query: data — JSON-массив при заданной области не выводится, причина — ответ неожиданного вида', async () => {
  const restore = stubJson({ status: 'success', data: [1, 2, 3] });
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.data, null);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('instant: data — число при заданной области не выводится, причина — ответ неожиданного вида', async () => {
  const restore = stubJson({ status: 'success', data: 42 });
  try {
    const response = await runMetricsInstant(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      time: null,
    });
    assert.equal(response.data, null);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('query: data — объект без известного resultType при заданной области не выводится', async () => {
  const restore = stubJson({ status: 'success', data: { resultType: 'histogram', result: [] } });
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.data, null);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('query: data — JSON-массив без заданной области отдаётся как есть', async () => {
  const restore = stubJson({ status: 'success', data: [1, 2, 3] });
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.deepEqual(response.data, [1, 2, 3]);
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('series: элемент не объект исключён и учтён причиной ответа неожиданного вида, остальные фильтруются как обычно', async () => {
  const restore = stubJson({
    status: 'success',
    data: ['не набор меток', { __name__: 'up', namespace: 'stand-7', pod: 'a' }],
  });
  try {
    const response = await runMetricsSeries(context(['stand-*']), {
      match: ['up'],
      start: null,
      end: null,
    });
    assert.deepEqual(response.data, [{ __name__: 'up', namespace: 'stand-7', pod: 'a' }]);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('metrics labels --label namespace при области: элемент не строкой исключён причиной ответа неожиданного вида, а не «вне области»', async () => {
  const restore = stubJson({ status: 'success', data: ['stand-7', 42] });
  try {
    const response = await runMetricsLabels(context(['stand-*']), {
      label: 'namespace',
      match: null,
      start: null,
      end: null,
    });
    assert.deepEqual(response.data, ['stand-7']);
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.recordsOutOfScope, 0);
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
    assert.doesNotMatch(response.incompleteReasons.join(' '), /часть значений метки namespace не попала в ответ/);
  } finally {
    restore();
  }
});

test('warnings строкой — причина serverWarnings, текст дословно в summary.server.warnings', async () => {
  const restore = stubJson({
    status: 'success',
    data: { resultType: 'matrix', result: [] },
    warnings: 'шардирование неполное',
  });
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /предупреждения/);
    const summary = response.summary as { server: { warnings: string } };
    assert.equal(summary.server.warnings, 'шардирование неполное');
  } finally {
    restore();
  }
});

test('warnings объектом с полями — причина serverWarnings', async () => {
  const restore = stubJson({
    status: 'success',
    data: { resultType: 'matrix', result: [] },
    warnings: { partial: true },
  });
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /предупреждения/);
  } finally {
    restore();
  }
});

test('query: элемент result не объект исключён причиной ответа неожиданного вида, а не «ряды без namespace»', async () => {
  const restore = stubJson({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: ['не ряд', { metric: { namespace: 'stand-7' }, values: [[1, '1']] }],
    },
  });
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.deepEqual(response.data, {
      resultType: 'matrix',
      result: [{ metric: { namespace: 'stand-7' }, values: [[1, '1']] }],
    });
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
    assert.doesNotMatch(response.incompleteReasons.join(' '), /ряды без метки namespace/);
  } finally {
    restore();
  }
});

test('query: у data есть поле кроме resultType и result — оно не выводится, причина — ответ неожиданного вида', async () => {
  const restore = stubJson({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: { namespace: 'stand-7' }, values: [[1, '1']] }],
      stats: { seriesFetched: '1' },
    },
  });
  try {
    const response = await runMetricsQuery(context(['stand-*']), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    assert.deepEqual(response.data, {
      resultType: 'matrix',
      result: [{ metric: { namespace: 'stand-7' }, values: [[1, '1']] }],
    });
    assert.match(response.incompleteReasons.join(' '), /ответ сервера неожиданного вида показан не целиком/);
  } finally {
    restore();
  }
});

test('query: без заданной области поля data кроме resultType и result сохраняются', async () => {
  const restore = stubJson({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: { namespace: 'stand-7' }, values: [[1, '1']] }],
      stats: { seriesFetched: '1' },
    },
  });
  try {
    const response = await runMetricsQuery(context(null), {
      query: 'x',
      queryFile: null,
      start: '-1h',
      end: 'now',
      step: null,
    });
    const data = response.data as { stats?: unknown };
    assert.deepEqual(data.stats, { seriesFetched: '1' });
    assert.equal(response.incomplete, false);
  } finally {
    restore();
  }
});

test('warnings пустой строкой, пустым массивом и пустым объектом — причины нет', async () => {
  for (const warnings of ['', [], {}]) {
    const restore = stubJson({ status: 'success', data: { resultType: 'matrix', result: [] }, warnings });
    try {
      const response = await runMetricsQuery(context(null), {
        query: 'x',
        queryFile: null,
        start: '-1h',
        end: 'now',
        step: null,
      });
      assert.equal(response.incomplete, false);
    } finally {
      restore();
    }
  }
});
