import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runConfigInit } from '../src/commands/configInit.ts';
import { DEFAULT_ROOT_CONFIG, loadRootConfig, resolveConfigPath } from '../src/config.ts';
import { parseProfile } from '../src/profile.ts';
import { loadProfile, profilesDirectory } from '../src/profiles.ts';
import { expandHome, normalizePath } from '../src/paths.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-test-'));
}

test('без файла конфигурации берутся значения по умолчанию', () => {
  const dir = workspace();
  try {
    const loaded = loadRootConfig(join(dir, 'нет-такого.json'));
    assert.equal(loaded.exists, false);
    assert.equal(loaded.config.defaultProfile, DEFAULT_ROOT_CONFIG.defaultProfile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('неразбираемый файл конфигурации даёт config_invalid', () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ это не JSON');
  try {
    assert.throws(
      () => loadRootConfig(path),
      (error: Error & { errorClass?: string }) => error.errorClass === 'config_invalid',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('неверный тип поля называет само поле', () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ defaultProfile: 123 }));
  try {
    assert.throws(
      () => loadRootConfig(path),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'config_invalid' && /defaultProfile/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('каталог журнала профиля задаётся явно', () => {
  const dir = workspace();
  const path = join(dir, 'profile.json');
  const profile = parseProfile(
    { journal: { directory: '/задано/явно' } },
    'вымышленный',
    path,
    join(dir, 'credentials.json'),
  );
  try {
    assert.match(profile.journalDirectory, /явно$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('каталог журнала по умолчанию лежит внутри каталога профиля', () => {
  const dir = workspace();
  const path = join(dir, 'profile.json');
  const profile = parseProfile({}, 'вымышленный', path, join(dir, 'credentials.json'));
  try {
    assert.equal(profile.journalDirectory, join(dir, 'journal'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('аргумент важнее переменной окружения для пути конфигурации', () => {
  const saved = process.env.TT_STAND_CONFIG;
  process.env.TT_STAND_CONFIG = normalizePath('из-переменной.json');
  try {
    assert.equal(resolveConfigPath('из-аргумента.json'), normalizePath('из-аргумента.json'));
    assert.equal(resolveConfigPath(undefined), normalizePath('из-переменной.json'));
  } finally {
    if (saved === undefined) delete process.env.TT_STAND_CONFIG;
    else process.env.TT_STAND_CONFIG = saved;
  }
});

test('тильда раскрывается инструментом, косые черты принимаются любые', () => {
  assert.notEqual(expandHome('~/подкаталог'), '~/подкаталог');
  assert.equal(normalizePath('a/b\\c'), normalizePath('a\\b/c'));
});

test('config init создаёт корневой файл, профиль default и пустой файл учётных данных', async () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  try {
    const response = await runConfigInit(path, false);
    assert.equal(response.ok, true);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.defaultProfile, 'default');

    const loadedRoot = loadRootConfig(path);
    assert.equal(loadedRoot.config.defaultProfile, 'default');

    const profile = loadProfile('default', profilesDirectory(path));
    assert.match(profile.grafana?.credentialsFile ?? '', /credentials\.json$/u);
    assert.equal(profile.kubernetes?.kubeconfig, normalizePath('~/.kube/config'));
    assert.deepEqual(profile.repositoryRoots, []);

    const data = response.data as { credentialsPath: string; credentialsCreated: boolean };
    assert.equal(data.credentialsCreated, true);
    assert.equal(readFileSync(data.credentialsPath, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('существующий файл без терминала не перезаписывается', async () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  writeFileSync(path, 'моё = "содержимое"\n');
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    await assert.rejects(
      () => runConfigInit(path, false),
      (error: Error & { errorClass?: string }) => error.errorClass === 'config_exists',
    );
    assert.match(readFileSync(path, 'utf8'), /моё/);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('существующий заполненный файл учётных данных не перезаписывается даже с --force', async () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  try {
    await runConfigInit(path, false);
    const profileDirectory = join(profilesDirectory(path), 'default');
    const credentialsPath = join(profileDirectory, 'credentials.json');
    writeFileSync(credentialsPath, JSON.stringify({ kind: 'token', token: 'секрет-для-теста' }));

    const response = await runConfigInit(path, true);
    assert.equal(response.ok, true);
    assert.equal(
      readFileSync(credentialsPath, 'utf8'),
      JSON.stringify({ kind: 'token', token: 'секрет-для-теста' }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
