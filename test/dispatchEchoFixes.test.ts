import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ParsedValues } from '../src/cli/args.ts';
import { dispatchLogs } from '../src/cli/dispatch.ts';
import { dispatchMetrics } from '../src/cli/dispatchMetrics.ts';

function installation(): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-dispatch-echofixes-'));
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

function stubFieldValues(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ values: [] })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function values(partial: Record<string, unknown>, config: string): ParsedValues {
  return { config, ...partial } as unknown as ParsedValues;
}

test('F1: metrics query — файла выражения нет, но заданы start/end/step — эхо их не теряет', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'нет-такого.promql');
    await assert.rejects(
      () =>
        dispatchMetrics(
          'query',
          values({ 'query-file': queryPath, start: '-1h', end: 'now', step: '5m' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.start === '-1h' &&
        error.echo?.end === 'now' &&
        error.echo?.step === '5m',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: metrics query — нет --end при заданном --step — эхо не теряет step', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('query', values({ query: 'up', start: '-1h', step: '5m' }, config)),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.query === 'up' &&
        error.echo?.start === '-1h' &&
        error.echo?.step === '5m',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: metrics instant — файла выражения нет, но задан --time — эхо его не теряет', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'нет-такого.promql');
    await assert.rejects(
      () =>
        dispatchMetrics(
          'instant',
          values({ 'query-file': queryPath, time: '2026-01-01T00:00:00Z' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' && error.echo?.time === '2026-01-01T00:00:00Z',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: logs query — файла выражения нет, но заданы start/end — эхо их не теряет', async () => {
  const { dir, config } = installation();
  try {
    const queryPath = join(dir, 'нет-такого.logsql');
    await assert.rejects(
      () =>
        dispatchLogs(
          'query',
          values({ 'query-file': queryPath, start: '-2d', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.start === '-2d' &&
        error.echo?.end === 'now' &&
        error.echo?.queryFile === queryPath,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: logs query — нет --start — эхо не теряет query', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchLogs('query', values({ query: '*', end: 'now' }, config)),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' && error.echo?.query === '*' && error.echo?.end === 'now',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: logs fields — нет --field — эхо не теряет query', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () =>
        dispatchLogs(
          'fields',
          values({ query: 'phone:*', start: '-1h', end: 'now' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.query === 'phone:*' &&
        error.echo?.start === '-1h' &&
        error.echo?.end === 'now',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: logs fields — echo.field называет переданное имя поля', async () => {
  const { dir, config } = installation();
  const restore = stubFieldValues();
  try {
    const response = await dispatchLogs(
      'fields',
      values({ field: 'pod', start: '-1h', end: 'now' }, config),
    );
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.field, 'pod');
    assert.equal(echo.value, null);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: logs search — echo.value называет переданные --value', async () => {
  const { dir, config } = installation();
  const captured: Captured[] = [];
  const restore = stubLogs(captured);
  try {
    const response = await dispatchLogs(
      'search',
      values({ value: ['a', 'b'], start: '-1h', end: 'now' }, config),
    );
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.deepEqual(echo.value, ['a', 'b']);
    assert.equal(echo.field, null);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G4: неизвестная подкоманда metrics не теряет уже переданные параметры в эхе', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () =>
        dispatchMetrics(
          'queryx',
          values({ query: 'up', start: '-1h' }, config),
        ),
      (error: Error & { errorClass?: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.echo?.query === 'up' &&
        error.echo?.start === '-1h',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F7: metrics labels --label "" называет иной текст, чем --label .', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '' }, config)),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' &&
        error.message.includes('api/v1/label//values') &&
        !error.message.includes('ссылку на каталог'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F7: metrics labels --label . называет прежний текст про ссылку на каталог', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () => dispatchMetrics('labels', values({ label: '.' }, config)),
      (error: Error & { errorClass?: string; message: string }) =>
        error.errorClass === 'bad_request' && error.message.includes('ссылку на каталог'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F15: logs query --start "" не считается отсутствующим — уходит на сервер как дано', async () => {
  const { dir, config } = installation();
  const captured: Captured[] = [];
  const restore = stubLogs(captured);
  try {
    const response = await dispatchLogs(
      'query',
      values({ query: '*', start: '', end: 'now' }, config),
    );
    assert.equal(response.ok, true);
    const sent = new URLSearchParams(captured[0]?.body);
    assert.equal(sent.get('start'), '');
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.start, '');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: неизвестная подкоманда logs называется раньше проверки --limit', async () => {
  const { dir, config } = installation();
  try {
    await assert.rejects(
      () =>
        dispatchLogs(
          'typo',
          values({ query: 'x', start: 'a', end: 'b', limit: 'abc' }, config),
        ),
      (error: Error & { errorClass?: string; message: string; echo?: Record<string, unknown> }) =>
        error.errorClass === 'bad_request' &&
        error.message.includes('Неизвестная команда logs: typo') &&
        error.echo?.query === 'x',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
