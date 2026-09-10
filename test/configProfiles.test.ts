import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarizeProfiles } from '../src/profiles.ts';
import { homeEnv, tt } from './ttRunner.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-configprofiles-'));
}

test('пустая установка даёт пустой перечень профилей', () => {
  const dir = workspace();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({}));
    const result = summarizeProfiles(configPath);
    assert.deepEqual(result.profiles, []);
    assert.equal(result.defaultProfile, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('перечень называет состав доступа, область и умолчание, без значений доступа', () => {
  const dir = workspace();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ defaultProfile: 'stand-a' }));
    mkdirSync(join(dir, 'profiles', 'stand-a'), { recursive: true });
    mkdirSync(join(dir, 'profiles', 'stand-b'), { recursive: true });
    writeFileSync(
      join(dir, 'profiles', 'stand-a', 'profile.json'),
      JSON.stringify({
        grafana: { baseUrl: 'https://a.example.invalid' },
        namespaceScope: ['stand-*'],
      }),
    );
    writeFileSync(
      join(dir, 'profiles', 'stand-a', 'credentials.json'),
      JSON.stringify({ kind: 'token', token: 'секрет-a' }),
    );
    writeFileSync(
      join(dir, 'profiles', 'stand-b', 'profile.json'),
      JSON.stringify({ kubernetes: { kubeconfig: 'k' } }),
    );

    const result = summarizeProfiles(configPath);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('секрет-a'), 'значение доступа не должно попасть в ответ');

    const a = result.profiles.find((profile) => profile.name === 'stand-a');
    const b = result.profiles.find((profile) => profile.name === 'stand-b');
    assert.equal(a?.hasGrafana, true);
    assert.equal(a?.hasKubernetes, false);
    assert.equal(a?.hasNamespaceScope, true);
    assert.equal(a?.isDefault, true);
    assert.equal(a?.credentials, 'filled');

    assert.equal(b?.hasGrafana, false);
    assert.equal(b?.hasKubernetes, true);
    assert.equal(b?.isDefault, false);
    assert.equal(b?.credentials, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('состояние файла учётных данных различает нет / пуст / заполнен', () => {
  const dir = workspace();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({}));
    for (const name of ['no-file', 'empty-file', 'filled-file']) {
      mkdirSync(join(dir, 'profiles', name), { recursive: true });
    }
    writeFileSync(join(dir, 'profiles', 'empty-file', 'credentials.json'), '');
    writeFileSync(
      join(dir, 'profiles', 'filled-file', 'credentials.json'),
      JSON.stringify({ kind: 'token', token: 'x' }),
    );

    const result = summarizeProfiles(configPath);
    const stateOf = (name: string) => result.profiles.find((profile) => profile.name === name)?.credentials;
    assert.equal(stateOf('no-file'), 'missing');
    assert.equal(stateOf('empty-file'), 'empty');
    assert.equal(stateOf('filled-file'), 'filled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config profiles на пустой установке — ok и нулевой код через CLI', async () => {
  const sandbox = workspace();
  const home = join(sandbox, 'home');
  mkdirSync(home);
  try {
    const result = await tt(['config', 'profiles'], homeEnv(home));
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; data: { profiles: unknown[] } };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.profiles, []);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('config init затем config profiles показывают профиль default', async () => {
  const sandbox = workspace();
  const home = join(sandbox, 'home');
  mkdirSync(home);
  try {
    await tt(['config', 'init'], homeEnv(home));
    const result = await tt(['config', 'profiles'], homeEnv(home));
    const parsed = JSON.parse(result.stdout) as {
      data: { profiles: Array<{ name: string; credentials: string; isDefault: boolean }> };
    };
    const profile = parsed.data.profiles.find((item) => item.name === 'default');
    assert.equal(profile?.credentials, 'empty');
    assert.equal(profile?.isDefault, true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('справка называет флаг --profile и переменную TT_STAND_PROFILE', async () => {
  const result = await tt(['--help']);
  assert.match(result.stdout, /--profile/);
  assert.match(result.stdout, /TT_STAND_PROFILE/);
});

test('неизвестное имя профиля даёт profile_missing', async () => {
  const sandbox = workspace();
  const home = join(sandbox, 'home');
  mkdirSync(home);
  try {
    await tt(['config', 'init'], homeEnv(home));
    const result = await tt(['env', '--profile', 'нет-такого'], homeEnv(home));
    const parsed = JSON.parse(result.stdout) as { errorClass: string };
    assert.equal(parsed.errorClass, 'profile_missing');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('флага для передачи логина, пароля или токена не существует', async () => {
  const result = await tt([
    'logs',
    'query',
    '--query',
    '*',
    '--start',
    '-1h',
    '--end',
    'now',
    '--password',
    'секрет',
  ]);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'bad_request');
});
