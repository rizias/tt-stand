import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { tt, homeEnv } from './ttRunner.ts';

function json(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-batch-'));
  const requests: Array<{ path: string; params: URLSearchParams }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      const path = request.url ?? '';
      const params = new URLSearchParams(body);
      requests.push({ path, params });
      response.setHeader('content-type', 'application/json');
      if (path === '/api/datasources') {
        response.end(JSON.stringify([{ uid: 'metrics', name: 'fixture', type: 'prometheus' }]));
        return;
      }
      if (params.get('query') === 'broken') {
        response.statusCode = 422;
        response.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'fixture rejection' }));
        return;
      }
      response.end(
        JSON.stringify({
          status: 'success',
          isPartial: params.get('query') === 'partial',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { namespace: 'fictional-a', pod: 'pod-a' },
                values: [
                  [1000.125, '1'],
                  [1060.125, '3'],
                ],
              },
            ],
          },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const config = join(root, 'config.json');
  const access = join(root, 'credentials.json');
  json(access, { kind: 'basic', login: 'fixture', password: 'fixture' });
  json(config, {
    grafana: { baseUrl: `http://127.0.0.1:${address.port}`, credentialsFile: access },
    journal: { directory: join(root, 'journal') },
  });
  const file = join(root, 'plan.json');
  const env = homeEnv(root);
  const run = (out: string, extra: string[] = []) =>
    tt(
      [
        'batch',
        '--config',
        config,
        '--file',
        file,
        '--out',
        join(root, out),
        '--start',
        '-1h',
        '--end',
        'now',
        ...extra,
      ],
      env,
    );
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-batch-')));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, requests, file, run, close };
}

function entry(id: string, query: string) {
  return { id, why: 'Синтетическая проверка измерения', argv: ['metrics', 'query', '--query', query] };
}

test('batch сохраняет полные ответы, наследует период и использует один каталог для метрик', async () => {
  const f = await fixture();
  try {
    json(f.file, { version: 1, goal: 'Синтетические ряды', requests: [entry('a', 'up'), entry('b', 'partial')] });
    const result = await f.run('data');
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.command, 'batch');
    assert.equal(body.incomplete, true);
    assert.equal(body.data.responses.length, 2);
    assert.equal(f.requests.filter((item) => item.path === '/api/datasources').length, 1);
    assert.equal(f.requests.length, 3);
    for (const request of f.requests.filter((item) => item.path !== '/api/datasources')) {
      assert.equal(request.params.get('start'), '-1h');
      assert.equal(request.params.get('end'), 'now');
      assert.equal(request.params.has('step'), false);
    }
    const response = JSON.parse(readFileSync(body.data.responses[0].file, 'utf8'));
    assert.deepEqual(response.data.result[0].values, [
      [1000.125, '1'],
      [1060.125, '3'],
    ]);
    assert.equal(body.summary.fetchAttempts, 3);
    assert.equal(body.echo.ignoredFlags.length, 0);
  } finally {
    await f.close();
  }
});

test('batch проверяет неверный второй пункт и view до первого HTTP', async () => {
  const f = await fixture();
  try {
    json(f.file, {
      version: 1,
      goal: 'Проверка подготовки',
      requests: [entry('a', 'up'), { id: 'b', why: 'Нет выражения', argv: ['metrics', 'query'] }],
    });
    const result = await f.run('invalid');
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).errorClass, 'bad_request');
    assert.equal(f.requests.length, 0);
    json(f.file, { version: 1, goal: 'Проверка view', requests: [entry('a', 'up')] });
    const view = join(f.root, 'view.json');
    json(view, { version: 1, panels: [{ kind: 'line', response: 'a', format: 'prometheus-matrix', unit: 'none' }] });
    const missingTimezone = await f.run('missing-timezone', ['--view', view]);
    assert.match(JSON.parse(missingTimezone.stdout).error, /timezone/u);
    assert.equal(f.requests.length, 0);
    json(view, {
      version: 1,
      timezone: '+03:00',
      panels: [{ kind: 'line', response: 'a', format: 'prometheus-matrix', unit: 'none' }],
    });
    const offsetTimezone = await f.run('offset-timezone', ['--view', view]);
    assert.match(JSON.parse(offsetTimezone.stdout).error, /timezone/u);
    assert.equal(f.requests.length, 0);
    json(view, { version: 1, timezone: 'UTC', panels: [{ kind: 'line', response: 'a', format: 'prometheus-matrix' }] });
    const missingUnit = await f.run('missing-unit', ['--view', view]);
    assert.match(JSON.parse(missingUnit.stdout).error, /unit/u);
    assert.equal(f.requests.length, 0);
    json(view, {
      version: 1,
      timezone: 'UTC',
      panels: [{ kind: 'line', response: 'a', format: 'prometheus-matrix', unit: ' ' }],
    });
    const blankUnit = await f.run('blank-unit', ['--view', view]);
    assert.match(JSON.parse(blankUnit.stdout).error, /unit/u);
    assert.equal(f.requests.length, 0);
    json(view, {
      version: 1,
      timezone: 'UTC',
      panels: [{ kind: 'line', response: 'absent', format: 'prometheus-matrix', unit: 'none' }],
    });
    const invalidView = await f.run('invalid-view', ['--view', view]);
    assert.equal(invalidView.code, 1);
    assert.equal(f.requests.length, 0);
    json(view, {
      version: 1,
      timezone: 'UTC',
      panels: [{ kind: 'line', response: 'a', format: 'logs-records', unit: 'none' }],
    });
    const missingFields = await f.run('missing-view-fields', ['--view', view]);
    assert.equal(missingFields.code, 1);
    assert.match(JSON.parse(missingFields.stdout).error, /timeField/);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('batch сохраняет отказ и выполняет независимый следующий пункт', async () => {
  const f = await fixture();
  try {
    json(f.file, { version: 1, goal: 'Проверка отказа', requests: [entry('a', 'broken'), entry('b', 'up')] });
    const result = await f.run('failed');
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 1);
    assert.equal(body.errorClass, 'metrics_query_rejected');
    assert.equal(body.summary.executed, 2);
    const failed = JSON.parse(readFileSync(body.data.responses[0].file, 'utf8'));
    assert.equal(failed.errorClass, 'metrics_query_rejected');
    assert.equal(failed.echo.query, 'broken');
    assert.equal(JSON.parse(readFileSync(body.data.responses[1].file, 'utf8')).ok, true);
  } finally {
    await f.close();
  }
});

test('batch и дочерний пункт отмечают --server как неприменимый и читают прежнюю Grafana', async () => {
  const f = await fixture();
  try {
    for (const [index, flag] of [['--server', 'secondary'], ['--server=secondary']].entries()) {
      const overridden = entry('b', 'up');
      overridden.argv.push(...flag);
      json(f.file, { version: 1, goal: 'Проверка доступа', requests: [entry('a', 'up'), overridden] });
      const result = await f.run(`server-ignored-${index}`, ['--server', 'primary']);
      assert.equal(result.code, 0, result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body.echo.ignoredFlags, ['--server']);
      assert.equal(body.summary.fetchAttempts, 3);
      const first = JSON.parse(readFileSync(body.data.responses[0].file, 'utf8'));
      const second = JSON.parse(readFileSync(body.data.responses[1].file, 'utf8'));
      assert.deepEqual(first.echo.ignoredFlags, []);
      assert.deepEqual(second.echo.ignoredFlags, ['--server']);
      assert.deepEqual(second.data, first.data);
      assert.equal(second.echo.server, undefined);
      assert.equal(second.echo.datasourceUid, 'metrics');
    }
    assert.equal(f.requests.length, 6);
  } finally {
    await f.close();
  }
});

test('человек получает график и baseline одним CLI-вызовом без дополнительных запросов', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, 'queries'));
    writeFileSync(join(f.root, 'queries', 'cpu.promql'), 'partial', 'utf8');
    json(f.file, {
      version: 1,
      goal: 'График',
      requests: [
        {
          id: 'cpu',
          why: 'Синтетический CPU',
          argv: ['metrics', 'query', '--query-file', 'queries/cpu.promql'],
        },
      ],
    });
    const view = join(f.root, 'view.json');
    json(view, {
      version: 1,
      timezone: 'Europe/Moscow',
      panels: [{ kind: 'line', response: 'cpu', format: 'prometheus-matrix', labelKeys: ['pod'], unit: 'cores' }],
    });
    const first = await f.run('before', ['--view', view]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const firstBody = JSON.parse(first.stdout);
    assert.equal(firstBody.incomplete, true);
    const report = readFileSync(firstBody.data.report.reportFile, 'utf8');
    assert.ok(report.includes('Europe/Moscow'));
    assert.ok(report.includes('1000125'));
    assert.ok(report.includes('current/cpu/0'));
    assert.ok(report.includes('namespace'));
    const count = f.requests.length;
    writeFileSync(join(f.root, 'queries', 'cpu.promql'), 'up', 'utf8');
    const second = await f.run('after', ['--view', view, '--baseline', firstBody.data.manifest]);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.equal(f.requests.length - count, 2);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(secondBody.incomplete, true);
    assert.equal(secondBody.summary.incomplete, 0);
    assert.ok(readFileSync(secondBody.data.report.reportFile, 'utf8').includes('baseline/cpu/0'));
  } finally {
    await f.close();
  }
});
