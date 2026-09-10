import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
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

function fakeNpm(exitCode: number): NodeJS.ProcessEnv {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm.cmd'), `@echo installed by fake npm\r\n@exit /b ${exitCode}\r\n`);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho installed by fake npm\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...homeEnv(home), [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
}

interface UpdateResponse {
  ok: boolean;
  command: string;
  data: { exitCode: number; npmOutput: string };
  errorClass: string | null;
}

test('update возвращает код npm и его вывод внутри документа ответа', async () => {
  const result = await tt(['update'], fakeNpm(7));
  assert.equal(result.code, 7);
  const response = JSON.parse(result.stdout) as UpdateResponse;
  assert.equal(response.ok, false);
  assert.equal(response.command, 'update');
  assert.equal(response.data.exitCode, 7);
  assert.match(response.data.npmOutput, /installed by fake npm/);
  assert.equal(response.errorClass, 'update_failed');
});

test('успешный update отвечает ok и нулевым кодом', async () => {
  const result = await tt(['update'], fakeNpm(0));
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout) as UpdateResponse;
  assert.equal(response.ok, true);
  assert.equal(response.errorClass, null);
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
