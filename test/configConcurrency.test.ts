import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterEach, test } from 'vitest';
import { withFileLock, withFileLockAsync } from '../src/lock.ts';

const lockModule = new URL('../src/lock.ts', import.meta.url).href;
const initModule = new URL('../src/commands/configInit.ts', import.meta.url).href;
const directories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tt-stand-concurrency-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function child(script: string): Promise<void> {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
  let stderr = '';
  process.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(process, 'exit');
  assert.equal(code, 0, stderr);
}

test('несколько процессов изменяют общий JSON без потери обновлений', async () => {
  const path = join(workspace(), 'counter.json');
  writeFileSync(path, '{"value":0,"binding":"preserved"}');
  const script = `
    import { readFileSync } from 'node:fs';
    import { withFileLock, atomicWriteFile } from ${JSON.stringify(lockModule)};
    const path = ${JSON.stringify(path)};
    for (let index = 0; index < 20; index++) {
      withFileLock(path + '.lock', () => {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        current.value++;
        atomicWriteFile(path, JSON.stringify(current));
      });
    }
  `;
  const readerFailures: unknown[] = [];
  const reader = setInterval(() => {
    try {
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { value: number; binding: string };
      assert.equal(snapshot.binding, 'preserved');
      assert.ok(Number.isInteger(snapshot.value));
    } catch (error) {
      readerFailures.push(error);
    }
  }, 5);
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => child(script)));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
  } finally {
    clearInterval(reader);
  }
  assert.deepEqual(readerFailures, []);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 100, binding: 'preserved' });
  assert.equal(existsSync(`${path}.lock`), false);
});

test('async блокировка удерживается через await и освобождается при ошибке', async () => {
  const path = join(workspace(), 'async.lock');
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withFileLockAsync(path, async () => {
        active++;
        maximum = Math.max(maximum, active);
        await setTimeout(20);
        active--;
      }),
    ),
  );
  assert.equal(maximum, 1);
  await assert.rejects(
    withFileLockAsync(path, async () => {
      throw new Error('synthetic failure');
    }),
  );
  assert.equal(
    withFileLock(path, () => 'released'),
    'released',
  );
});

test('завершившийся владелец блокировки допускает повторный запуск', async () => {
  const path = join(workspace(), 'stale.lock');
  await child(`
    import { withFileLock } from ${JSON.stringify(lockModule)};
    withFileLock(${JSON.stringify(path)}, () => process.exit(0));
  `);
  assert.equal(existsSync(path), true);
  assert.equal(
    withFileLock(path, () => 'recovered'),
    'recovered',
  );
  assert.equal(existsSync(path), false);
});

test('живой владелец сохраняет блокировку при таймауте конкурента', () => {
  const path = join(workspace(), 'timeout.lock');
  withFileLock(path, () => {
    assert.throws(() => withFileLock(path, () => undefined, 30), /таймаут/u);
    assert.equal(existsSync(path), true);
  });
  assert.equal(existsSync(path), false);
});

test('параллельный init создаёт целые файлы и повторный запуск сохраняет секреты', async () => {
  const rootPath = join(workspace(), 'config.json');
  const script = `
    import { runConfigInit } from ${JSON.stringify(initModule)};
    await runConfigInit(${JSON.stringify(rootPath)}, false);
  `;
  await Promise.all(Array.from({ length: 4 }, () => child(script)));
  assert.equal(JSON.parse(readFileSync(rootPath, 'utf8')).defaultProfile, 'default');
  const credentialsPath = join(rootPath, '..', 'profiles', 'default', 'credentials.json');
  const content = '{"ssh":{"passphrase":"synthetic-secret"}}';
  writeFileSync(credentialsPath, content);
  await Promise.all([child(script), child(script)]);
  assert.equal(readFileSync(credentialsPath, 'utf8'), content);
});

test('параллельный init именованных профилей сохраняет общий config', async () => {
  const directory = workspace();
  const rootPath = join(directory, 'config.json');
  const create = `
    import { runConfigInit } from ${JSON.stringify(initModule)};
    await runConfigInit(${JSON.stringify(rootPath)}, false, 'first');
  `;
  await child(create);
  const content = '{\n  "defaultProfile": "first",\n  "extra": "synthetic-value"\n}\n';
  writeFileSync(rootPath, content);
  await Promise.all(
    ['first', 'second', 'third', 'second'].map((name) =>
      child(`
    import { runConfigInit } from ${JSON.stringify(initModule)};
    await runConfigInit(${JSON.stringify(rootPath)}, false, ${JSON.stringify(name)});
  `),
    ),
  );
  assert.equal(readFileSync(rootPath, 'utf8'), content);
  for (const name of ['first', 'second', 'third']) {
    const profile = JSON.parse(readFileSync(join(directory, 'profiles', name, 'profile.json'), 'utf8'));
    assert.ok(profile.grafana);
    assert.ok(profile.kubernetes);
  }
});
