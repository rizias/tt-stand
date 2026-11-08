import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { describeServerCredentials, readCredentials, readServerCredentials } from '../src/credentials.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-credentials-'));
}

afterEach(() => vi.unstubAllEnvs());

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

test.each(['', 'synthetic-secret-not-json', '{"kind":"basic","password":"synthetic-secret"'])(
  'некорректный JSON отклоняется без раскрытия содержимого (%#)',
  (contents) => {
    const dir = workspace();
    const path = join(dir, 'credentials.json');
    writeFileSync(path, contents);
    try {
      assert.throws(
        () => readCredentials(path, null, 'default'),
        (error: Error & { errorClass?: string; echo?: { profile?: string } }) =>
          error.errorClass === 'credentials_incomplete' &&
          error.echo?.profile === 'default' &&
          error.message.includes(path) &&
          error.message.includes('JSON') &&
          !error.message.includes('synthetic-secret'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('адрес Grafana не задан в профиле — profile_incomplete', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'basic', login: 'ro', password: 'секрет' }));
  try {
    assert.throws(
      () => readCredentials(path, null, 'default'),
      (error: Error & { errorClass?: string }) => error.errorClass === 'profile_incomplete',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON с basic читается, хвостовая косая черта адреса убирается', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ kind: 'basic', login: 'ro', password: 'секрет' }));
  try {
    const credentials = readCredentials(path, 'https://grafana.example.invalid/', 'default');
    assert.equal(credentials.kind, 'basic');
    assert.equal(credentials.kind === 'basic' && credentials.password, 'секрет');
    assert.equal(credentials.baseUrl, 'https://grafana.example.invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON с token и UTF-8 BOM читается', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  writeFileSync(path, `\uFEFF${JSON.stringify({ kind: 'token', token: 'секрет-токен' })}`);
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
        error.errorClass === 'credentials_incomplete' && /basic/.test(error.message) && /token/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Grafana использует прежний файл credentials независимо от новых переменных окружения', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  vi.stubEnv('TT_STAND_SERVER_GRAFANA_TOKEN', 'synthetic-env-token');
  vi.stubEnv('TT_STAND_SERVER_GRAFANA_USERNAME', 'synthetic-env-user');
  vi.stubEnv('TT_STAND_SERVER_GRAFANA_PASSWORD', 'synthetic-env-password');
  try {
    assert.throws(() => readCredentials(path, 'https://grafana.example.invalid', 'selected'), {
      errorClass: 'credentials_missing',
    });
    writeFileSync(path, '{"kind":"token","token":"synthetic-file-token"}');
    assert.deepEqual(readCredentials(path, 'https://grafana.example.invalid', 'selected'), {
      kind: 'token',
      token: 'synthetic-file-token',
      baseUrl: 'https://grafana.example.invalid',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('секреты SSH и MongoDB читаются по имени из файла независимо от env', () => {
  const dir = workspace();
  const path = join(dir, 'credentials.json');
  vi.stubEnv('TT_STAND_SERVER_DATABASE_PASSWORD', 'synthetic-env-password');
  vi.stubEnv('TT_STAND_SERVER_TUNNEL_PASSPHRASE', 'synthetic-env-passphrase');
  try {
    assert.deepEqual(readServerCredentials(path, 'database', 'selected', 'mongodb'), {});
    assert.deepEqual(readServerCredentials(path, 'tunnel', 'selected', 'ssh'), {});
    writeFileSync(
      path,
      JSON.stringify({
        database: { username: 'synthetic-user', password: 'synthetic-password' },
        tunnel: { passphrase: 'synthetic-passphrase' },
      }),
    );
    assert.deepEqual(readServerCredentials(path, 'database', 'selected', 'mongodb'), {
      username: 'synthetic-user',
      password: 'synthetic-password',
    });
    assert.deepEqual(readServerCredentials(path, 'tunnel', 'selected', 'ssh'), { passphrase: 'synthetic-passphrase' });
    assert.deepEqual(describeServerCredentials(path, 'tunnel', 'selected', 'ssh'), {
      passphrase: { set: true, source: 'file' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
