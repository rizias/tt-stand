import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import type { ParsedValues } from '../src/cli/args.ts';
import { buildLogsContext, dispatchLogs } from '../src/cli/dispatch.ts';
import { failureResponse } from '../src/cli/failure.ts';
import { runEnv } from '../src/commands/env.ts';
import { ToolError } from '../src/errors.ts';

function installation(grafana: Record<string, unknown>): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-logs-datasource-echo-'));
  const profileDir = join(dir, 'profiles', 'default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({
      grafana: { baseUrl: 'https://grafana.example.invalid', ...grafana },
    }),
  );
  writeFileSync(join(profileDir, 'credentials.json'), JSON.stringify({ kind: 'basic', login: 'u', password: 'p' }));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ defaultProfile: 'default' }));
  return { dir, config };
}

function stub(datasources: unknown[], status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith('/api/datasources')) return Response.json(datasources);
    if (String(url).includes('field_values')) return Response.json({ values: [] }, { status });
    return new Response('', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function values(partial: Record<string, unknown>, config: string): ParsedValues {
  return { config, ...partial } as unknown as ParsedValues;
}

const LOGS = { uid: 'logs-auto', name: 'Логи', type: 'victoriametrics-logs-datasource' };
const PERIOD = { start: '-1h', end: 'now' };

for (const [subcommand, extra] of [
  ['query', { query: '*' }],
  ['search', { value: ['x'] }],
  ['http', { query: '*' }],
  ['fields', { field: 'f' }],
] as const) {
  test(`logs ${subcommand}: эхо называет имя, тип и идентификатор найденного источника`, async () => {
    const { dir, config } = installation({});
    const restore = stub([LOGS]);
    try {
      const response = await dispatchLogs(subcommand, values({ ...extra, ...PERIOD }, config));
      const echo = response.echo as unknown as Record<string, unknown>;
      assert.equal(echo.datasource, 'Логи');
      assert.equal(echo.datasourceType, 'victoriametrics-logs-datasource');
      assert.equal(echo.datasourceUid, 'logs-auto');
      assert.equal(echo.datasourceNote, null);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('env: эхо называет тип и идентификатор источника', async () => {
  const { dir, config } = installation({});
  const restore = stub([LOGS, { ...LOGS, uid: 'logs-second', name: 'Логи-2' }]);
  try {
    const response = await runEnv(await buildLogsContext(values({}, config)));
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.datasourceType, 'victoriametrics-logs-datasource');
    assert.equal(echo.datasourceUid, 'logs-auto');
    assert.match(String(echo.datasourceNote), /Логи, Логи-2/u);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('источник задан в настройке: эхо называет его идентификатор, тип — null', async () => {
  const { dir, config } = installation({ datasourceUid: 'logs-set' });
  const restore = stub([]);
  try {
    const response = await dispatchLogs('query', values({ query: '*', ...PERIOD }, config));
    const echo = response.echo as unknown as Record<string, unknown>;
    assert.equal(echo.datasourceUid, 'logs-set');
    assert.equal(echo.datasourceType, null);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const command of ['logs fields', 'env']) {
  test(`${command}: отказ сервера сохраняет источник и запрос в конечном ответе`, async () => {
    const { dir, config } = installation({});
    const restore = stub([LOGS], 403);
    try {
      await assert.rejects(
        () =>
          command === 'env'
            ? buildLogsContext(values({}, config)).then(runEnv)
            : dispatchLogs('fields', values({ field: 'f', ...PERIOD }, config)),
        (cause: unknown) => {
          assert.ok(cause instanceof ToolError);
          const response = failureResponse(cause, command);
          const echo = response.echo as unknown as Record<string, unknown>;
          assert.equal(response.errorClass, 'auth_failed');
          assert.equal(response.error, cause.message);
          assert.equal(echo.datasource, LOGS.name);
          assert.equal(echo.datasourceType, LOGS.type);
          assert.equal(echo.datasourceUid, LOGS.uid);
          assert.equal(echo.profile, 'default');
          assert.equal(echo.namespaceScope, null);
          assert.match(String(echo.request), /^POST \/select\/logsql\/field_values /u);
          return true;
        },
      );
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
