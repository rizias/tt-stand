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
    const parsed = JSON.parse(result.stdout) as { errorClass: string; error: string };
    assert.equal(parsed.errorClass, 'bad_request');
    assert.match(parsed.error, /--query/);
    assert.equal(result.code, 1);
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
