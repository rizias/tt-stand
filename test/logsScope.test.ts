import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runLogsQuery } from '../src/commands/logs.ts';
import { GrafanaClient, type Datasource } from '../src/grafana.ts';
import type { Credentials } from '../src/credentials.ts';
import type { LogsContext } from '../src/commands/logs.ts';

const credentials: Credentials = {
  kind: 'basic',
  login: 'user',
  password: 'pass',
  baseUrl: 'https://grafana.example.invalid',
};
const datasource: Datasource = {
  uid: 'ds',
  name: 'фиктивный источник',
  type: 'victoriametrics-logs-datasource',
  candidates: [],
};

function context(namespaceScope: string[] | null): LogsContext {
  return {
    client: new GrafanaClient({ credentials, timeoutSeconds: null }),
    datasource,
    profile: 'default',
    namespaceScope,
  };
}

interface Captured {
  url: string;
  body: string;
}

function stubQueryAndFieldValues(queryBody: string, fieldValuesBody: string, captured: Captured[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    captured.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url).includes('field_values')) {
      return new Response(fieldValuesBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(queryBody, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('без области видимости параметр extra_filters не уходит в хранилище', async () => {
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues('', '{"values":[]}', captured);
  try {
    const response = await runLogsQuery(context(null), {
      command: 'logs query',
      query: 'error | stats count()',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('extra_filters'), null);
    assert.equal(sent.get('query'), 'error | stats count()');
    assert.equal((response.echo as unknown as { query: string }).query, 'error | stats count()');
  } finally {
    restore();
  }
});

test('область уходит отдельным параметром, выражение с конвейером не меняется', async () => {
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues('', '{"values":[]}', captured);
  try {
    await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: 'error | stats count()',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('query'), 'error | stats count()');
    assert.match(sent.get('extra_filters') ?? '', /kubernetes\.pod_namespace/);
    assert.match(sent.get('extra_filters') ?? '', /stand/);
  } finally {
    restore();
  }
});

test('пустой результат несёт полное эхо: профиль, область, число вне области', async () => {
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues('', '{"values":[]}', captured);
  try {
    const response = await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.profile, 'default');
    assert.deepEqual(echo.namespaceScope, ['stand-*']);
    assert.equal(echo.recordsOutOfScope, 0);
    assert.deepEqual(response.data, []);
  } finally {
    restore();
  }
});

test('записи вне области, определённые по upstream, отбрасываются и считаются', async () => {
  const records = [
    '{"_msg":"a","kubernetes.pod_namespace":"stand-1"}',
    '{"_msg":"b","upstream":"stand-2-8080"}',
    '{"_msg":"c","upstream":"prod-9-8080"}',
    '{"_msg":"d","upstream":"https://external.example.invalid/thing"}',
  ].join('\n');
  const namespaces =
    '{"values":[{"value":"stand-1","hits":1},{"value":"stand-2","hits":1},{"value":"prod-9","hits":1}]}';
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues(`${records}\n`, namespaces, captured);
  try {
    const response = await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    assert.equal(response.ok, true);
    assert.equal((response.data as unknown[]).length, 3, 'запись c вне области должна быть отброшена');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.profile, 'default');
    assert.deepEqual(echo.namespaceScope, ['stand-*']);
    assert.equal(echo.query, '*');
    assert.equal(echo.recordsOutOfScope, 1);
    assert.equal(response.incomplete, true);
    assert.match(response.incompleteReasons.join(' '), /не попала в ответ/);
    assert.match(response.incompleteReasons.join(' '), /namespace не определён/);
  } finally {
    restore();
  }
});

test('запись с явным namespace вне области отбрасывается даже при нарушении фильтра сервером', async () => {
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues('{"kubernetes.pod_namespace":"prod-1"}\n', '{"values":[]}', captured);
  try {
    const response = await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    assert.deepEqual(response.data, []);
    assert.equal(response.echo.recordsOutOfScope, 1);
  } finally {
    restore();
  }
});

test('настоящий namespace unknown не обходит область видимости', async () => {
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues('{"kubernetes.pod_namespace":"unknown"}\n', '{"values":[]}', captured);
  try {
    const response = await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    assert.deepEqual(response.data, []);
    assert.equal(response.echo.recordsOutOfScope, 1);
  } finally {
    restore();
  }
});

test('частичный ответ при таймауте проходит разметку и проверку области', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"kubernetes.pod_namespace":"prod-1"}\n'));
        controller.enqueue(new TextEncoder().encode('{"kubernetes.pod_namespace":"stand-1"}\n'));
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const slow = context(['stand-*']);
    slow.client = new GrafanaClient({ credentials, timeoutSeconds: 0.05 });
    const response = await runLogsQuery(slow, {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    assert.equal(response.errorClass, 'timeout_client');
    assert.equal((response.data as unknown[]).length, 1);
    assert.equal(response.echo.recordsOutOfScope, 1);
    assert.equal((response.data as Array<{ environment: string }>)[0]?.environment, 'stand-1');
  } finally {
    globalThis.fetch = original;
  }
});

test('ничего не отброшено — признак неполноты по этой причине не выставляется', async () => {
  const records = ['{"_msg":"a","kubernetes.pod_namespace":"stand-1"}'].join('\n');
  const captured: Captured[] = [];
  const restore = stubQueryAndFieldValues(`${records}\n`, '{"values":[]}', captured);
  try {
    const response = await runLogsQuery(context(['stand-*']), {
      command: 'logs query',
      query: '*',
      start: '-1h',
      end: 'now',
      limit: null,
    });
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.recordsOutOfScope, 0);
    assert.ok(!response.incompleteReasons.join(' ').includes('не попала в ответ'));
  } finally {
    restore();
  }
});
