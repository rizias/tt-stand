import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { failureResponse } from '../src/cli/failure.ts';
import { ToolError } from '../src/errors.ts';

const run = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function tt(args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function emptyConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-cli-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ grafana: { credentialsFile: 'нет-такого-файла' } }));
  return { dir, path };
}

test('справка выводится и завершается нулевым кодом', async () => {
  const result = await tt(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /tt-stand logs query/);
});

test('вызов без команды выводит справку', async () => {
  const result = await tt([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Общие флаги/);
});

test('по умолчанию вывод — корректный JSON', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt(['logs', 'query', '--start', '-1h', '--end', 'now', '--config', path]);
    const parsed = JSON.parse(result.stdout) as { errorClass: string };
    assert.equal(parsed.errorClass, 'bad_request');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('пропущенный параметр даёт bad_request до обращения к источнику', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt(['logs', 'query', '--start', '-1h', '--end', 'now', '--config', path]);
    const parsed = JSON.parse(result.stdout) as {
      errorClass: string;
      error: string;
      echo: { query: string | null; start: string | null; end: string | null };
    };
    assert.equal(parsed.errorClass, 'bad_request');
    assert.match(parsed.error, /--query/);
    assert.equal(result.code, 1);
    assert.equal(parsed.echo.query, null);
    assert.equal(parsed.echo.start, '-1h');
    assert.equal(parsed.echo.end, 'now');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ответ при отказе идёт в стандартный вывод, а не в поток ошибок', async () => {
  const result = await tt(['logs', 'нетакой', '--start', '-1h', '--end', 'now']);
  assert.notEqual(result.stdout.trim().length, 0);
  const parsed = JSON.parse(result.stdout) as { errorClass: string; echo: unknown };
  assert.equal(parsed.errorClass, 'bad_request');
  assert.ok(parsed.echo, 'эхо обязано присутствовать и при отказе');
});

test('неизвестный флаг отвергается как ошибка аргументов', async () => {
  const result = await tt(['logs', 'query', '--нетакогофлага', 'x']);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'bad_request');
  assert.equal(result.code, 1);
});

test('флаг вместо значения не склеивается в значение', async () => {
  const result = await tt([
    'logs',
    'query',
    '--query',
    '--human',
    '--start',
    '-1h',
    '--end',
    'now',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /bad_request/);
});

test('нецелый лимит отвергается', async () => {
  const result = await tt([
    'logs',
    'query',
    '--query',
    '*',
    '--start',
    '-1h',
    '--end',
    'now',
    '--limit',
    'много',
  ]);
  const parsed = JSON.parse(result.stdout) as { errorClass: string; error: string };
  assert.equal(parsed.errorClass, 'bad_request');
  assert.match(parsed.error, /--limit/);
});

test('нецелый лимит не теряет уже разобранные query, start и end в эхе', async () => {
  const result = await tt([
    'logs',
    'query',
    '--query',
    '*',
    '--start',
    '-1h',
    '--end',
    'now',
    '--limit',
    'abc',
  ]);
  const parsed = JSON.parse(result.stdout) as {
    errorClass: string;
    echo: { query: string | null; start: string | null; end: string | null };
  };
  assert.equal(parsed.errorClass, 'bad_request');
  assert.equal(parsed.echo.query, '*');
  assert.equal(parsed.echo.start, '-1h');
  assert.equal(parsed.echo.end, 'now');
});

test('отсутствующий файл учётных данных доходит до пользователя своим классом', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'logs',
      'query',
      '--query',
      '*',
      '--start',
      '-1h',
      '--end',
      'now',
      '--config',
      path,
    ]);
    const parsed = JSON.parse(result.stdout) as { errorClass: string };
    assert.equal(parsed.errorClass, 'credentials_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('отказ при чтении учётных данных всё равно называет query, start и end', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'logs',
      'query',
      '--query',
      'phone:*',
      '--start',
      '-2d',
      '--end',
      'now',
      '--config',
      path,
    ]);
    const parsed = JSON.parse(result.stdout) as {
      errorClass: string;
      echo: { query: string | null; queryFile: string | null; start: string | null; end: string | null };
    };
    assert.equal(parsed.errorClass, 'credentials_missing');
    assert.equal(parsed.echo.query, 'phone:*');
    assert.equal(parsed.echo.queryFile, null);
    assert.equal(parsed.echo.start, '-2d');
    assert.equal(parsed.echo.end, 'now');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('токен раскрывается целиком и помечен непроверенной подписью', async () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'fictional-user', role: 'agent' })).toString(
    'base64url',
  );
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const result = await tt(['token', '--value', `${header}.${payload}.подпись`]);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { payload: Record<string, unknown>; signatureVerified: boolean };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.payload.sub, 'fictional-user');
  assert.equal(parsed.data.payload.role, 'agent');
  assert.equal(parsed.data.signatureVerified, false);
});

test('нераскрываемое значение даёт token_invalid', async () => {
  const result = await tt(['token', '--value', 'это-не-токен']);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'token_invalid');
});

test('повтор --value у token отвергается', async () => {
  const result = await tt(['token', '--value', 'a.b.c', '--value', 'd.e.f']);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'bad_request');
});

test('составное относительное время передаётся как дано', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'logs',
      'query',
      '--query',
      '*',
      '--start',
      '-1d2h',
      '--end',
      'now',
      '--config',
      path,
    ]);
    assert.match(result.stdout, /credentials_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('значение, похожее на чужой флаг, склеивается с параметром', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'logs',
      'query',
      '--query',
      '*',
      '--start',
      '-xyz',
      '--end',
      'now',
      '--config',
      path,
    ]);
    assert.match(result.stdout, /credentials_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--time с отрицательным значением не проглатывается как отдельный флаг', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'metrics',
      'instant',
      '--query',
      'up',
      '--time',
      '-1h',
      '--config',
      path,
    ]);
    assert.match(result.stdout, /credentials_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics query без --query и --query-file — bad_request', async () => {
  const result = await tt(['metrics', 'query', '--start', '-1h', '--end', 'now']);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'bad_request');
});

test('metrics query: отказ при чтении учётных данных называет query, start, end и step', async () => {
  const { dir, path } = emptyConfig();
  try {
    const result = await tt([
      'metrics',
      'query',
      '--query',
      'up',
      '--start',
      '-1h',
      '--end',
      'now',
      '--step',
      '5m',
      '--config',
      path,
    ]);
    const parsed = JSON.parse(result.stdout) as {
      errorClass: string;
      echo: {
        query: string | null;
        start: string | null;
        end: string | null;
        step: string | null;
      };
    };
    assert.equal(parsed.errorClass, 'credentials_missing');
    assert.equal(parsed.echo.query, 'up');
    assert.equal(parsed.echo.start, '-1h');
    assert.equal(parsed.echo.end, 'now');
    assert.equal(parsed.echo.step, '5m');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('справка содержит команды metrics', async () => {
  const result = await tt(['--help']);
  assert.match(result.stdout, /tt-stand metrics query/);
  assert.match(result.stdout, /tt-stand metrics series/);
});

test('конверт отказа сохраняет то, что фактически выполнялось', () => {
  const cause = new ToolError('timeout_client', 'таймаут', { records: [{ _msg: 'a' }] }).withEcho({
    query: 'phone:*',
    start: '-2d',
    end: 'now',
    request: 'POST /select/logsql/query query=phone%3A*',
    datasource: 'логи',
  });
  const response = failureResponse(cause, 'logs query');
  const echo = response.echo as unknown as Record<string, unknown>;
  assert.equal(echo.query, 'phone:*');
  assert.equal(echo.start, '-2d');
  assert.equal(echo.end, 'now');
  assert.equal(echo.datasource, 'логи');
  assert.equal(echo.recordsReturned, 1);
  assert.equal(response.errorClass, 'timeout_client');
});
