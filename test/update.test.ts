import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { homeEnv, root, tt } from './ttRunner.ts';

let sandbox: string;
let home: string;

const running = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
  .version;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tt-stand-update-'));
  home = join(sandbox, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function fakeInstalledPackage(version: string): string {
  const globalRoot = join(sandbox, 'global');
  const dir = join(globalRoot, '@rizias', 'tt-stand', 'dist');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(globalRoot, '@rizias', 'tt-stand', 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'cli.js'), 'process.exit(0);\n');
  return globalRoot;
}

function fakeNpm(options: {
  latest: string;
  installExit?: number;
  rootExit?: number;
}): NodeJS.ProcessEnv {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const globalRoot = fakeInstalledPackage(options.latest);
  const installExit = options.installExit ?? 0;
  const rootExit = options.rootExit ?? 0;
  const calls = join(sandbox, 'npm-calls.log');
  writeFileSync(
    join(bin, 'npm.cmd'),
    [
      `@echo %*>> "${calls}"`,
      `@if "%1"=="view" echo "${options.latest}"`,
      `@if "%1"=="view" exit /b 0`,
      `@if "%1"=="root" echo ${globalRoot}`,
      `@if "%1"=="root" exit /b ${rootExit}`,
      '@echo installed by fake npm',
      `@exit /b ${installExit}`,
      '',
    ].join('\r\n'),
  );
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${calls}'`,
      `if [ "$1" = view ]; then echo '"${options.latest}"'; exit 0; fi`,
      `if [ "$1" = root ]; then echo '${globalRoot}'; exit ${rootExit}; fi`,
      'echo installed by fake npm',
      `exit ${installExit}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...homeEnv(home), [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
}

function npmCalls(): string {
  const file = join(sandbox, 'npm-calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('update при уже последней версии отвечает одной строкой и не переустанавливает', async () => {
  const result = await tt(['update'], fakeNpm({ latest: running }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `tt-stand: уже последняя версия ${running}\n`);
  assert.doesNotMatch(npmCalls(), /^i -g/m);
});

test('update ставит новую версию, обновляет копии скилла и отвечает одной строкой', async () => {
  const result = await tt(['update'], fakeNpm({ latest: '9.9.9' }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `tt-stand: ${running} → 9.9.9, копий скилла в проектах нет\n`);
  assert.match(npmCalls(), /^i -g @rizias\/tt-stand@latest/m);
});

test('update при ошибке npm печатает код и вывод npm в поток ошибок', async () => {
  const result = await tt(['update'], fakeNpm({ latest: '9.9.9', installExit: 7 }));
  assert.equal(result.code, 7);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /tt-stand: обновление не выполнено \(установка\), npm завершился кодом 7/);
  assert.match(result.stderr, /installed by fake npm/);
});

test('update не пишет запись в журнал', async () => {
  const result = await tt(['update'], fakeNpm({ latest: running }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(home, '.tt-stand', 'journal')), false);
  assert.equal(existsSync(join(home, '.tt-stand', 'profiles')), false);
});

test('update при сбое npm root -g сообщает шаг и код', async () => {
  const result = await tt(['update'], fakeNpm({ latest: '9.9.9', rootExit: 3 }));
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /обновление не выполнено \(каталог глобальных пакетов\), npm завершился кодом 3/);
});

test('update --help показывает справку и не обновляет', async () => {
  const result = await tt(['update', '--help'], fakeNpm({ latest: '9.9.9' }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /tt-stand update/);
  assert.equal(npmCalls(), '');
});

test('update с лишним аргументом отказывает', async () => {
  const result = await tt(['update', 'now'], fakeNpm({ latest: '9.9.9' }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /update не принимает аргументов/);
  assert.equal(npmCalls(), '');
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
