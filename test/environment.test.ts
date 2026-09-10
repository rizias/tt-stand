import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runEnv } from '../src/commands/env.ts';
import { type LogsContext, runLogsQuery } from '../src/commands/logs.ts';
import {
  hasIngressUpstream,
  labelRecord,
  labelRecords,
  NAMESPACE_FIELD,
  namespaceFromUpstream,
  readField,
  UNKNOWN_ENVIRONMENT,
} from '../src/environment.ts';

test('поле читается по плоскому ключу с точками', () => {
  const record = { [NAMESPACE_FIELD]: 'fictional-team-01' };
  assert.equal(readField(record, NAMESPACE_FIELD), 'fictional-team-01');
  assert.equal((record as Record<string, unknown>).kubernetes, undefined);
});

test('окружение прикладного лога равно namespace', () => {
  const labelled = labelRecord({ [NAMESPACE_FIELD]: 'fictional-team-02' }, []);
  assert.equal(labelled.environment, 'fictional-team-02');
  assert.equal(labelled.environmentSource, 'namespace');
});

test('namespace определяется по префиксу upstream', () => {
  const labelled = labelRecord({ upstream: 'fictional-production-fictional-admin-api-8000' }, [
    'fictional-production',
  ]);
  assert.equal(labelled.environment, 'fictional-production');
  assert.equal(labelled.environmentSource, 'upstream');
});

test('из совпавших префиксов upstream берётся самый длинный namespace', () => {
  const labelled = labelRecord({ upstream: 'fictional-team-long-api-8000' }, [
    'fictional-team',
    'fictional-team-long',
  ]);
  assert.equal(labelled.environment, 'fictional-team-long');
});

test('upstream без совпадения получает unknown и сохраняет исходное значение', () => {
  const labelled = labelRecord({ upstream: 'fictional-missing-api-8000' }, ['fictional-team-01']);
  assert.equal(labelled.environment, UNKNOWN_ENVIRONMENT);
  assert.equal(labelled.environmentValue, 'fictional-missing-api-8000');
});

test('upstream в виде HTTP-адреса получает unknown', () => {
  const labelled = labelRecord({ upstream: 'http://192.0.2.20:8000/items/' }, [
    'http',
    'fictional-team-01',
  ]);
  assert.equal(labelled.environment, UNKNOWN_ENVIRONMENT);
  assert.equal(labelled.environmentValue, 'http://192.0.2.20:8000/items/');
});

test('ни одного пригодного поля — окружение unknown', () => {
  const labelled = labelRecord({ _msg: 'служебная строка' }, []);
  assert.equal(labelled.environment, UNKNOWN_ENVIRONMENT);
  assert.equal(labelled.environmentSource, null);
});

test('сводка считает записи по namespace и сохраняет порядок неизвестных значений', () => {
  const { summary } = labelRecords(
    [
      { [NAMESPACE_FIELD]: 'fictional-team-01' },
      { upstream: 'fictional-missing-b-api-8000' },
      { upstream: 'fictional-missing-a-api-8000' },
    ],
    ['fictional-team-01'],
  );
  assert.equal(summary.byEnvironment['fictional-team-01'], 1);
  assert.equal(summary.unknownCount, 2);
  assert.deepEqual(summary.unknownValues, [
    'fictional-missing-b-api-8000',
    'fictional-missing-a-api-8000',
  ]);
});

test('каждый вызов с ingress запрашивает полный каталог без периода и лимита', async () => {
  const requests: URLSearchParams[] = [];
  const context = {
    client: {
      queryLogs: async () => ({
        records: [{ upstream: 'fictional-team-01-api-8000' }],
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
      fieldValues: async (_datasource: unknown, params: URLSearchParams) => {
        requests.push(new URLSearchParams(params));
        return {
          values: [
            { value: 'fictional-team-02', hits: 2 },
            { value: 'fictional-team-01', hits: 1 },
          ],
          raw: {},
        };
      },
    },
    datasource: { uid: 'fictional-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;
  const options = {
    command: 'logs query',
    query: '*',
    start: '-2m',
    end: 'now',
    limit: null,
  };

  await runLogsQuery(context, options);
  await runLogsQuery(context, options);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.get('field'), NAMESPACE_FIELD);
    assert.equal(request.get('query'), '*');
    assert.equal(request.get('start'), null);
    assert.equal(request.get('end'), null);
    assert.equal(request.get('limit'), null);
  }
});

test('набор без ingress-upstream не вызывает запрос каталога', async () => {
  let fieldValueCalls = 0;
  const context = {
    client: {
      queryLogs: async () => ({
        records: [{ [NAMESPACE_FIELD]: 'fictional-team-01' }],
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
      fieldValues: async () => {
        fieldValueCalls += 1;
        return { values: [], raw: {} };
      },
    },
    datasource: { uid: 'fictional-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runLogsQuery(context, {
    command: 'logs query',
    query: '*',
    start: '-2m',
    end: 'now',
    limit: null,
  });

  assert.equal(fieldValueCalls, 0);
  assert.equal(
    (response.data as Array<{ environment: string }>)[0]?.environment,
    'fictional-team-01',
  );
});

test('env показывает список в порядке хранилища, время и параметры запроса', async () => {
  const requests: URLSearchParams[] = [];
  const context = {
    client: {
      fieldValues: async (_datasource: unknown, params: URLSearchParams) => {
        requests.push(new URLSearchParams(params));
        return {
          values: [
            { value: 'fictional-team-02', hits: 2 },
            { value: 'fictional-team-01', hits: 1 },
          ],
          raw: {},
        };
      },
    },
    datasource: { uid: 'fictional-env-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runEnv(context);
  const data = response.data as { namespaces: string[]; acquiredAt: string };
  assert.deepEqual(data.namespaces, ['fictional-team-02', 'fictional-team-01']);
  assert.match(data.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(data), ['namespaces', 'acquiredAt']);
  assert.deepEqual(Object.keys(response.summary as Record<string, unknown>), [
    'namespaceCount',
    'acquiredAt',
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.get('field'), NAMESPACE_FIELD);
  assert.equal(requests[0]?.get('query'), '*');
  assert.equal(requests[0]?.get('start'), null);
  assert.equal(requests[0]?.get('end'), null);
  assert.equal(requests[0]?.get('limit'), null);
  assert.equal(response.incomplete, false);
});

test('команда логов получает каталог и размечает ingress по namespace', async () => {
  const record = {
    _msg:
      '192.0.2.11 - - [01/Jan/2026:00:00:00 +0000] "GET /items/ HTTP/1.1" 200 2 "-" ' +
      '"FictionalAgent/1.0" 1 0.001 [fictional-team-01-api-8000] [] 192.0.2.20:8000 2 0.001 200 abc',
  };
  const context = {
    client: {
      queryLogs: async () => ({
        records: [record],
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
      fieldValues: async () => ({
        values: [{ value: 'fictional-team-01', hits: 1 }],
        raw: {},
      }),
    },
    datasource: { uid: 'fictional-logs-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runLogsQuery(context, {
    command: 'logs query',
    query: '*',
    start: '-1h',
    end: 'now',
    limit: null,
  });
  const data = response.data as Array<{ environment: string; record: unknown }>;
  assert.equal(data[0]?.environment, 'fictional-team-01');
  assert.strictEqual(data[0]?.record, record);
});

test('полный каталог сохраняет планку разметки 799 записей из 800', async () => {
  const records = [
    ...Array.from({ length: 799 }, (_, index) => ({
      upstream: 'fictional-team-01-api-8000',
      sequence: index,
    })),
    { upstream: 'fictional-missing-api-8000', sequence: 799 },
  ];
  const context = {
    client: {
      queryLogs: async () => ({
        records,
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
      fieldValues: async () => ({
        values: [{ value: 'fictional-team-01', hits: 799 }],
        raw: {},
      }),
    },
    datasource: { uid: 'fictional-coverage-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runLogsQuery(context, {
    command: 'logs query',
    query: '*',
    start: '-2m',
    end: 'now',
    limit: null,
  });
  const data = response.data as Array<{ environment: string; record: unknown }>;
  const summary = response.summary as { unknownCount: number };
  assert.equal(data.length, 800);
  assert.equal(data.filter((item) => item.environment === 'fictional-team-01').length, 799);
  assert.equal(summary.unknownCount, 1);
  assert.deepEqual(
    data.map((item) => item.record),
    records,
  );
});

test('недоступный каталог не скрывает полученную ingress-запись', async () => {
  const record = { upstream: 'fictional-team-01-api-8000', marker: 'сохранить' };
  const context = {
    client: {
      queryLogs: async () => ({
        records: [record],
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
      fieldValues: async () => {
        throw new Error('вымышленный отказ каталога');
      },
    },
    datasource: { uid: 'fictional-failing-source', name: 'вымышленный источник', candidates: [] },
    profile: "default",
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runLogsQuery(context, {
    command: 'logs query',
    query: '*',
    start: '-1h',
    end: 'now',
    limit: null,
  });
  const data = response.data as Array<{ environment: string; record: unknown }>;
  assert.equal(data[0]?.environment, UNKNOWN_ENVIRONMENT);
  assert.strictEqual(data[0]?.record, record);
  assert.equal(response.incomplete, true);
  assert.match(response.incompleteReasons.join(' '), /список namespace/u);
});

test('при наличии обоих полей окружение берётся из namespace записи', () => {
  const record = {
    [NAMESPACE_FIELD]: 'fictional-team-03',
    _msg: '10.0.0.1 - - "GET /items/ HTTP/1.1" 200 12 "-" "agent" 1 0.1 [other-ns-api-8000] []',
  };
  const labelled = labelRecord(record, ['other-ns-api', 'fictional-team-03']);
  assert.equal(labelled.environment, 'fictional-team-03');
  assert.equal(labelled.environmentSource, 'namespace');
});

test('без поля namespace окружение берётся из upstream', () => {
  const record = {
    _msg: '10.0.0.1 - - "GET /items/ HTTP/1.1" 200 12 "-" "agent" 1 0.1 [fictional-team-04-api-8000] []',
  };
  const labelled = labelRecord(record, ['fictional-team-04']);
  assert.equal(labelled.environment, 'fictional-team-04');
  assert.equal(labelled.environmentSource, 'upstream');
});

test('список namespace не запрашивается, если у всех записей есть своё поле', () => {
  const records = [
    {
      [NAMESPACE_FIELD]: 'fictional-team-05',
      _msg: '"GET /x HTTP/1.1" 200 1 "-" "a" 1 0.1 [ns-api-8000] []',
    },
  ];
  assert.equal(hasIngressUpstream(records), false);
});

test('namespace не совпадает с более длинным именем без границы', () => {
  assert.equal(namespaceFromUpstream('production-api-8000', ['prod']), null);
  assert.equal(namespaceFromUpstream('prod-api-8000', ['prod']), 'prod');
  assert.equal(namespaceFromUpstream('prod', ['prod']), 'prod');
});
