import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { homeEnv, tt } from './ttRunner.ts';

let sandbox: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tt-stand-update-'));
  home = join(sandbox, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

function fakeNpm(installExit = 0): NodeJS.ProcessEnv {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(sandbox, 'npm-calls.log');
  writeFileSync(
    join(bin, 'npm.cmd'),
    [
      `@echo %*>> "${calls}"`,
      '@echo installed by fake npm',
      '@echo diagnostic from fake npm 1>&2',
      `@exit /b ${installExit}`,
      '',
    ].join('\r\n'),
  );
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${calls}'`,
      'echo installed by fake npm',
      'echo diagnostic from fake npm >&2',
      `exit ${installExit}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { ...homeEnv(home), [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
}

function npmCalls(): string[] {
  const file = join(sandbox, 'npm-calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\r?\n/) : [];
}

test('update напрямую устанавливает latest и передаёт пользователю оба потока npm', async () => {
  const result = await tt(['update'], fakeNpm());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'installed by fake npm');
  assert.match(result.stderr, /diagnostic from fake npm/);
  assert.deepEqual(npmCalls(), ['i -g @rizias/tt-stand@latest']);
});

test('повторный update повторно выполняет явную установку latest', async () => {
  const env = fakeNpm();
  const first = await tt(['update'], env);
  const second = await tt(['update'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(npmCalls(), ['i -g @rizias/tt-stand@latest', 'i -g @rizias/tt-stand@latest']);
});

test('update сохраняет ненулевой код npm и его вывод', async () => {
  const result = await tt(['update'], fakeNpm(7));
  assert.equal(result.code, 7);
  assert.equal(result.stdout.trim(), 'installed by fake npm');
  assert.match(result.stderr, /diagnostic from fake npm/);
});

test('update не пишет запись в журнал и не создаёт профили', async () => {
  const result = await tt(['update'], fakeNpm());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(home, '.tt-stand', 'journal')), false);
  assert.equal(existsSync(join(home, '.tt-stand', 'profiles')), false);
});

test('update сообщает об отсутствующем npm и возвращает код 1', async () => {
  const result = await tt(['update'], { ...homeEnv(home), [pathKey]: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /npm/);
});

test('update --help показывает справку и не обновляет', async () => {
  const result = await tt(['update', '--help'], fakeNpm());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /tt-stand update/);
  assert.deepEqual(npmCalls(), []);
});

test('update с лишним аргументом отказывает', async () => {
  const result = await tt(['update', 'now'], fakeNpm());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /update не принимает аргументов/);
  assert.deepEqual(npmCalls(), []);
});

test('команда с выводом не в терминал не создаёт кэш уведомителя', async () => {
  const result = await tt(['--help'], {
    ...homeEnv(home),
    NODE_ENV: 'production',
    CI: 'false',
    XDG_CONFIG_HOME: join(home, '.config'),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(home, '.config', 'configstore')), false);
});
