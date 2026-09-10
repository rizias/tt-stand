import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverProfiles,
  PROFILE_VARIABLE,
  resolveActiveProfile,
  resolveProfileName,
} from '../src/profiles.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-profiles-'));
}

function rootConfigPath(dir: string): string {
  return join(dir, 'config.json');
}

test('аргумент важнее переменной окружения', () => {
  const name = resolveProfileName('a', ['a', 'b'], null, 'C:/fictional/profiles', {
    [PROFILE_VARIABLE]: 'b',
  });
  assert.equal(name, 'a');
});

test('переменная окружения берётся, если аргумент не задан', () => {
  const name = resolveProfileName(null, ['a', 'b'], null, 'C:/fictional/profiles', {
    [PROFILE_VARIABLE]: 'b',
  });
  assert.equal(name, 'b');
});

test('единственный профиль берётся без указания', () => {
  const name = resolveProfileName(null, ['solo'], null, 'C:/fictional/profiles', {});
  assert.equal(name, 'solo');
});

test('профиль по умолчанию берётся из корневого файла', () => {
  const name = resolveProfileName(null, ['a', 'b'], 'b', 'C:/fictional/profiles', {});
  assert.equal(name, 'b');
});

test('профиль не выбран, а их несколько — profile_ambiguous с перечнем имён', () => {
  assert.throws(
    () => resolveProfileName(null, ['a', 'b'], null, 'C:/fictional/profiles', {}),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'profile_ambiguous' && /a/.test(error.message) && /b/.test(error.message),
  );
});

test('названного профиля нет — profile_missing с перечнем имеющихся', () => {
  assert.throws(
    () => resolveProfileName('c', ['a', 'b'], null, 'C:/fictional/profiles', {}),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'profile_missing' && /c/.test(error.message) && /a, b/.test(error.message),
  );
});

test('профилей нет вовсе — profile_missing', () => {
  assert.throws(
    () => resolveProfileName(null, [], null, 'C:/fictional/profiles', {}),
    (error: Error & { errorClass?: string }) => error.errorClass === 'profile_missing',
  );
});

test('настоящие профили обнаруживаются в каталоге рядом с config.json', () => {
  const dir = workspace();
  try {
    const configPath = rootConfigPath(dir);
    writeFileSync(configPath, JSON.stringify({ defaultProfile: 'stand-a' }));
    mkdirSync(join(dir, 'profiles', 'stand-a'), { recursive: true });
    mkdirSync(join(dir, 'profiles', 'stand-b'), { recursive: true });
    writeFileSync(
      join(dir, 'profiles', 'stand-a', 'profile.json'),
      JSON.stringify({ grafana: { baseUrl: 'https://a.example.invalid' } }),
    );

    const profile = resolveActiveProfile(configPath, null);
    assert.equal(profile.name, 'stand-a');
    assert.equal(profile.grafana?.baseUrl, 'https://a.example.invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('совместимость: плоский корневой файл без каталога профилей — профиль default', () => {
  const dir = workspace();
  try {
    const configPath = rootConfigPath(dir);
    writeFileSync(
      configPath,
      JSON.stringify({
        grafana: { credentialsFile: 'нет-такого' },
        kubernetes: {},
        repositoryRoots: [],
      }),
    );

    const profile = resolveActiveProfile(configPath, null);
    assert.equal(profile.name, 'default');
    assert.notEqual(profile.grafana, null);
    assert.notEqual(
      profile.kubernetes,
      null,
      'раздел kubernetes прежнего файла считается настроенным даже без kubeconfig',
    );
    assert.equal(profile.kubernetes?.kubeconfig, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('совместимость: раздел kubernetes отсутствует в файле вовсе — всё равно настроен', () => {
  const dir = workspace();
  try {
    const configPath = rootConfigPath(dir);
    writeFileSync(configPath, JSON.stringify({ grafana: { credentialsFile: 'нет-такого' } }));

    const profile = resolveActiveProfile(configPath, null);
    assert.equal(profile.name, 'default');
    assert.notEqual(profile.kubernetes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('запрошенный профиль, отличный от default, при легаси-режиме — profile_missing', () => {
  const dir = workspace();
  try {
    const configPath = rootConfigPath(dir);
    writeFileSync(configPath, JSON.stringify({ grafana: { credentialsFile: 'нет-такого' } }));

    assert.throws(
      () => resolveActiveProfile(configPath, 'другой'),
      (error: Error & { errorClass?: string }) => error.errorClass === 'profile_missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('корневой файл без прежних полей не считается легаси — пустая установка', () => {
  const dir = workspace();
  try {
    const configPath = rootConfigPath(dir);
    writeFileSync(configPath, JSON.stringify({ defaultProfile: 'x' }));

    const discovery = discoverProfiles(configPath);
    assert.equal(discovery.legacyProfile, null);
    assert.deepEqual(discovery.names, []);
    assert.throws(
      () => resolveActiveProfile(configPath, null),
      (error: Error & { errorClass?: string }) => error.errorClass === 'profile_missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
