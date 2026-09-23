import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ParsedValues } from '../src/cli/args.ts';
import { dispatchLogs } from '../src/cli/dispatch.ts';
import { dispatchMetrics } from '../src/cli/dispatchMetrics.ts';

function installation(): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-dispatch-queryfile-'));
  const profileDir = join(dir, 'profiles', 'default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({
      grafana: {
        baseUrl: 'https://grafana.example.invalid',
        datasourceUid: 'logs-uid',
        metricsDatasourceUid: 'metrics-uid',
      },
    }),
  );
  writeFileSync(
    join(profileDir, 'credentials.json'),
    JSON.stringify({ kind: 'basic', login: 'u', password: 'p' }),
  );
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ defaultProfile: 'default' }));
  return { dir, config };
}

interface Captured {
  body: string;
}

function stubLogs(captured: Captured[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured.push({ body: String(init?.body ?? '') });
    return new Response('', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function stubMetrics(captured: Captured[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured.push({ body: String(init?.body ?? '') });
    return Response.json({ status: 'success', data: { resultType: 'matrix', result: [] } });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function values(partial: Record<string, unknown>, config: string): ParsedValues {
  return { config, ...partial } as unknown as ParsedValues;
}

test('logs query --query-file: содержимое файла доходит до сервера и в эхо', async () => {
  const { dir, config } = installation();
  const captured: Captured[] = [];
  const restore = stubLogs(captured);
  try {
    const queryPath = join(dir, 'query.logsql');
    writeFileSync(queryPath, 'upstream:"<a>|b&c" | stats count()');
    const response = await dispatchLogs(
      'query',
      values({ 'query-file': queryPath, start: '-1h', end: 'now' }, config),
    );
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('query'), 'upstream:"<a>|b&c" | stats count()');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.query, 'upstream:"<a>|b&c" | stats count()');
    assert.equal(echo.queryFile, queryPath);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs query: оба флага сразу — bad_request до обращения к источнику', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'query.logsql');
    writeFileSync(queryPath, '*');
    await assert.rejects(
      () =>
        dispatchLogs(
          'query',
          values({ query: '*', 'query-file': queryPath, start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'bad_request',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs query --query-file: файла нет — bad_request называет путь', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'нет-такого.logsql');
    await assert.rejects(
      () =>
        dispatchLogs(
          'query',
          values({ 'query-file': queryPath, start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' && error.message.includes(queryPath),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics query --query-file: содержимое файла доходит до сервера и в эхо', async () => {
  const { dir, config } = installation();
  const captured: Captured[] = [];
  const restore = stubMetrics(captured);
  try {
    const queryPath = join(dir, 'query.promql');
    writeFileSync(queryPath, 'sum(rate(http_requests_total[5m])) by (pod)');
    const response = await dispatchMetrics(
      'query',
      values({ 'query-file': queryPath, start: '-1h', end: 'now' }, config),
    );
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('query'), 'sum(rate(http_requests_total[5m])) by (pod)');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.query, 'sum(rate(http_requests_total[5m])) by (pod)');
    assert.equal(echo.queryFile, queryPath);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics query: оба флага сразу — bad_request', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'query.promql');
    writeFileSync(queryPath, 'up');
    await assert.rejects(
      () =>
        dispatchMetrics(
          'query',
          values({ query: 'up', 'query-file': queryPath, start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string }) => error.errorClass === 'bad_request',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics series: без --match — bad_request', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('series', values({}, config)),
      (error: Error & { errorClass?: string }) => error.errorClass === 'bad_request',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics labels --label . — bad_request до построения пути запроса', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '.' }, config)),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' && error.message.includes('api/v1/label'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics labels --label "" — bad_request так же, как . и ..', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '' }, config)),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' && error.message.includes('api/v1/label'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics labels --label .: эхо отказа называет переданную метку', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '.', start: '-1h', end: 'now' }, config)),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.label === '.' &&
        error.echo?.start === '-1h' &&
        error.echo?.end === 'now',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics series: без --match — эхо отказа называет match: []', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('series', values({ start: '-1h', end: 'now' }, config)),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        Array.isArray(error.echo?.match) &&
        (error.echo?.match as unknown[]).length === 0 &&
        error.echo?.start === '-1h',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics query --query-file: файла нет — эхо отказа называет переданный путь', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'нет-такого.promql');
    await assert.rejects(
      () =>
        dispatchMetrics(
          'query',
          values({ 'query-file': queryPath, start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' && error.echo?.queryFile === queryPath,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs http: --query-file и --value одновременно — эхо отказа называет и выражение, и путь файла', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'query.logsql');
    writeFileSync(queryPath, '*');
    await assert.rejects(
      () =>
        dispatchLogs(
          'http',
          values(
            { 'query-file': queryPath, value: ['x'], start: '-1h', end: 'now' },
            config,
          ),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.query === '*' &&
        error.echo?.queryFile === queryPath,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics labels --label .. — bad_request до построения пути запроса', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '..' }, config)),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' && error.message.includes('api/v1/label'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics query: отказ при выборе источника несёт query, start и end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-dispatch-queryfile-nods-'));
  const profileDir = join(dir, 'profiles', 'default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({ grafana: { baseUrl: 'https://grafana.example.invalid' } }),
  );
  writeFileSync(
    join(profileDir, 'credentials.json'),
    JSON.stringify({ kind: 'basic', login: 'u', password: 'p' }),
  );
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ defaultProfile: 'default' }));

  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json([{ uid: 'a', name: 'логи', type: 'victoriametrics-logs-datasource' }])) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        dispatchMetrics(
          'query',
          values({ query: 'up', start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'datasource_not_found' &&
        error.echo?.query === 'up' &&
        error.echo?.start === '-1h' &&
        error.echo?.end === 'now',
    );
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
