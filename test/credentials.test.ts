import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCredentials } from '../src/credentials.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-credentials-'));
}

test('отсутствующий файл учётных данных даёт credentials_missing', () => {
  const dir = workspace();
  try {
    assert.throws(
      () => readCredentials(join(dir, 'нет-файла'), null, 'default'),
      (error: Error & { errorClass?: string }) => error.errorClass === 'credentials_missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('прежний файл без обязательной строки называет её', () => {
  const dir = workspace();
  const path = join(dir, 'creds');
  writeFileSync(path, 'u=user\n');
  try {
    assert.throws(
      () => readCredentials(path, null, 'default'),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'credentials_incomplete' && /p=/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('прежний полный файл читается как basic, хвостовая косая черта убирается', () => {
  const dir = workspace();
  const path = join(dir, 'creds');
  writeFileSync(path, 'u=user\np=secret\ne=https://grafana.example.invalid/\n');
  try {
    const credentials = readCredentials(path, null, 'default');
    assert.equal(credentials.kind, 'basic');
    assert.equal(credentials.kind === 'basic' && credentials.login, 'user');
    assert.equal(credentials.baseUrl, 'https://grafana.example.invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('адрес из профиля важнее строки e= прежнего файла', () => {
  const dir = workspace();
  const path = join(dir, 'creds');
  writeFileSync(path, 'u=user\np=secret\ne=https://из-файла.example.invalid\n');
  try {
    const credentials = readCredentials(path, 'https://из-профиля.example.invalid', 'default');
    assert.equal(credentials.baseUrl, 'https://из-профиля.example.invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('адрес не задан ни профилем, ни файлом — profile_incomplete', () => {
  const dir = workspace();
  const path = join(dir, 'creds');
  writeFileSync(path, 'u=user\np=secret\n');
  try {
    assert.throws(
      () => readCredentials(path, null, 'default'),
      (error: Error & { errorClass?: string }) => error.errorClass === 'profile_incomplete',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('новый файл JSON с basic читается', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'basic', login: 'ro', password: 'секрет' }));
  try {
    const credentials = readCredentials(path, 'https://grafana.example.invalid', 'default');
    assert.equal(credentials.kind, 'basic');
    assert.equal(credentials.kind === 'basic' && credentials.password, 'секрет');
    assert.equal(credentials.baseUrl, 'https://grafana.example.invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('новый файл JSON с token читается и собирает доступ токеном', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'token', token: 'секрет-токен' }));
  try {
    const credentials = readCredentials(path, 'https://grafana.example.invalid', 'default');
    assert.equal(credentials.kind, 'token');
    assert.equal(credentials.kind === 'token' && credentials.token, 'секрет-токен');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('в JSON-файле basic не хватает пароля', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'basic', login: 'ro' }));
  try {
    assert.throws(
      () => readCredentials(path, 'https://grafana.example.invalid', 'default'),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'credentials_incomplete' && /password/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('неизвестный способ доступа перечисляет известные', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'oauth' }));
  try {
    assert.throws(
      () => readCredentials(path, 'https://grafana.example.invalid', 'default'),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'credentials_incomplete' &&
        /basic/.test(error.message) &&
        /token/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
