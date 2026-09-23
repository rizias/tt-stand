import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { homeEnv, tt } from './ttRunner.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-ignored-flags-'));
}

async function startFakeMetricsServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url === '/api/datasources') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ uid: 'prom-uid', name: 'прометей', type: 'prometheus' }]));
      return;
    }
    if (request.url?.startsWith('/api/datasources/proxy/uid/prom-uid/api/v1/query_range')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              { metric: { pod: 'a' }, values: [[1, '1']] },
              { metric: { pod: 'b' }, values: [[1, '2']] },
              { metric: { pod: 'c' }, values: [[1, '3']] },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

function installation(home: string, baseUrl: string): void {
  const profileDirectory = join(home, '.tt-stand', 'profiles', 'default');
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(join(home, '.tt-stand', 'config.json'), JSON.stringify({ defaultProfile: 'default' }));
  writeFileSync(join(profileDirectory, 'profile.json'), JSON.stringify({ grafana: { baseUrl } }));
  writeFileSync(
    join(profileDirectory, 'credentials.json'),
    JSON.stringify({ kind: 'basic', login: 'reader', password: 'секрет' }),
  );
}

test('metrics query --limit 1: лимит не применяется, ряды выведены целиком, код 0', async () => {
  const home = workspace();
  const { url, server } = await startFakeMetricsServer();
  try {
    installation(home, url);
    const result = await tt(
      ['metrics', 'query', '--query', 'up', '--start', '-1h', '--end', 'now', '--limit', '1'],
      homeEnv(home),
    );
    assert.equal(result.code, 0, result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { result: unknown[] };
      echo: { ignoredFlags: string[]; ignoredFlagsNote: string };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.result.length, 3);
    assert.deepEqual(parsed.echo.ignoredFlags, ['--limit']);
    assert.equal(
      parsed.echo.ignoredFlagsNote,
      'эти флаги команда не применяет: они не повлияли на результат',
    );
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('metrics query --limit abc: некорректное значение неприменяемого флага — не отказ', async () => {
  const home = workspace();
  const { url, server } = await startFakeMetricsServer();
  try {
    installation(home, url);
    const result = await tt(
      ['metrics', 'query', '--query', 'up', '--start', '-1h', '--end', 'now', '--limit', 'abc'],
      homeEnv(home),
    );
    assert.equal(result.code, 0, result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      errorClass: string | null;
      data: { result: unknown[] };
      echo: { ignoredFlags: string[] };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.errorClass, null);
    assert.equal(parsed.data.result.length, 3);
    assert.deepEqual(parsed.echo.ignoredFlags, ['--limit']);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('metrics query без лишних флагов: ignoredFlags пуст, ignoredFlagsNote — null', async () => {
  const home = workspace();
  const { url, server } = await startFakeMetricsServer();
  try {
    installation(home, url);
    const result = await tt(
      ['metrics', 'query', '--query', 'up', '--start', '-1h', '--end', 'now'],
      homeEnv(home),
    );
    assert.equal(result.code, 0, result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      echo: { ignoredFlags: string[]; ignoredFlagsNote: string | null };
    };
    assert.deepEqual(parsed.echo.ignoredFlags, []);
    assert.equal(parsed.echo.ignoredFlagsNote, null);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('logs search --query-file: файл не читается, ignoredFlags называет флаг и при отказе', async () => {
  const home = workspace();
  const queryFilePath = join(home, 'query.txt');
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(queryFilePath, '*');
    const result = await tt(
      [
        'logs',
        'search',
        '--value',
        'x',
        '--query-file',
        queryFilePath,
        '--start',
        '-1h',
        '--end',
        'now',
      ],
      homeEnv(home),
    );
    const parsed = JSON.parse(result.stdout) as {
      errorClass: string;
      echo: { ignoredFlags: string[] };
    };
    assert.equal(result.code, 1);
    assert.deepEqual(parsed.echo.ignoredFlags, ['--query-file']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
