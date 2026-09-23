import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { runConfigInit } from '../src/commands/configInit.ts';
import { DEFAULT_ROOT_CONFIG, loadRootConfig, resolveConfigPath } from '../src/config.ts';
import { parseProfile } from '../src/profile.ts';
import { loadProfile, profilesDirectory } from '../src/profiles.ts';
import { expandHome, normalizePath, normalizePathFor } from '../src/paths.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-test-'));
}

test('без файла конфигурации в расположении по умолчанию берутся значения по умолчанию', () => {
  const dir = workspace();
  const saved = { home: process.env.HOME, profile: process.env.USERPROFILE, config: process.env.TT_STAND_CONFIG };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.TT_STAND_CONFIG;
  try {
    const loaded = loadRootConfig();
    assert.equal(loaded.exists, false);
    assert.equal(loaded.config.defaultProfile, DEFAULT_ROOT_CONFIG.defaultProfile);
  } finally {
    process.env.HOME = saved.home;
    process.env.USERPROFILE = saved.profile;
    if (saved.config === undefined) delete process.env.TT_STAND_CONFIG;
    else process.env.TT_STAND_CONFIG = saved.config;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('явно заданный аргументом отсутствующий файл конфигурации — config_invalid с полным путём', () => {
  const dir = workspace();
  const path = join(dir, 'нет-такого.json');
  try {
    assert.throws(
      () => loadRootConfig(path),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'config_invalid' &&
        error.message.includes(path) &&
        error.message.includes('--config'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('явно заданный переменной окружения отсутствующий файл конфигурации — config_invalid', () => {
  const dir = workspace();
  const path = join(dir, 'нет-такого.json');
  const saved = process.env.TT_STAND_CONFIG;
  process.env.TT_STAND_CONFIG = path;
  try {
    assert.throws(
      () => loadRootConfig(),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'config_invalid' &&
        error.message.includes(path) &&
        error.message.includes('TT_STAND_CONFIG'),
    );
  } finally {
    if (saved === undefined) delete process.env.TT_STAND_CONFIG;
    else process.env.TT_STAND_CONFIG = saved;
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

test('сетевой путь Windows: начальный двойной разделитель сохраняется', () => {
  assert.equal(
    normalizePathFor(win32, '\\\\fileserver.example.invalid\\share\\dir\\file'),
    '\\\\fileserver.example.invalid\\share\\dir\\file',
  );
  assert.equal(
    normalizePathFor(win32, '//fileserver.example.invalid//share/dir\\file'),
    '\\\\fileserver.example.invalid\\share\\dir\\file',
  );
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

test('существующий файл без терминала не перезаписывается, команда завершается успешно', async () => {
  const dir = workspace();
  const path = join(dir, 'config.json');
  writeFileSync(path, 'моё = "содержимое"\n');
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const response = await runConfigInit(path, false);
    assert.equal(response.ok, true);
    const data = response.data as { changed: boolean; existing: string[] };
    assert.equal(data.changed, false);
    assert.deepEqual(data.existing, [path]);
    assert.match(String((response.summary as { hint: string }).hint), /--force/);
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
