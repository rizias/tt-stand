import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { resolveActiveProfile, summarizeProfiles } from '../src/profiles.ts';
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
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { profiles: unknown[] };
      summary: { profileCount: number };
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.profiles, []);
    assert.equal(parsed.summary.profileCount, 0);
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
      summary: { profileCount: number };
    };
    const profile = parsed.data.profiles.find((item) => item.name === 'default');
    assert.equal(profile?.credentials, 'empty');
    assert.equal(profile?.isDefault, true);
    assert.equal(parsed.summary.profileCount, 1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('пустой TT_STAND_PROFILE сохраняет профиль по умолчанию и его журнал', async () => {
  const home = workspace();
  const root = join(home, 'config.json');
  const journal = join(home, 'selected-journal');
  writeFileSync(root, JSON.stringify({ defaultProfile: 'one' }));
  for (const name of ['one', 'two']) {
    const directory = join(home, 'profiles', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'profile.json'), JSON.stringify({ journal: { directory: journal } }));
  }
  try {
    const result = await tt(['config', 'profiles', '--config', root], {
      ...homeEnv(home),
      TT_STAND_PROFILE: '',
    });
    assert.equal(result.code, 0, result.stdout);
    const body = JSON.parse(result.stdout) as {
      data: { currentProfile: string; profiles: Array<{ name: string; isCurrent: boolean }> };
      summary: { profileCount: number };
      echo: { profile: string; journal: string };
    };
    assert.equal(body.data.currentProfile, 'one');
    assert.deepEqual(
      body.data.profiles.map(({ name, isCurrent }) => ({ name, isCurrent })),
      [
        { name: 'one', isCurrent: true },
        { name: 'two', isCurrent: false },
      ],
    );
    assert.equal(body.summary.profileCount, 2);
    assert.equal(body.echo.profile, 'one');
    assert.equal(dirname(body.echo.journal), journal);
    assert.equal(JSON.parse(readFileSync(body.echo.journal, 'utf8')).profile, 'one');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  'passphrase',
  'key',
  'pfx',
  'appName=test?x&passphrase',
  'appName=test?x&key',
  'appName=test?x&pfx',
  'appName=test?x&pass\tphrase',
  'appName=test?x&\tkey',
  'appName=test?x&pfx\t',
  'appName=test?x&%70ass\tphrase',
  'appName=test?x&pass\rphrase',
  'appName=test?x&pass\nphrase',
])('секрет URI %s исключён из обоих выводов и журнала config', async (option) => {
  const home = workspace();
  const root = join(home, 'config.json');
  const directory = join(home, 'profiles', 'selected');
  mkdirSync(directory, { recursive: true });
  writeFileSync(root, JSON.stringify({ defaultProfile: 'selected' }));
  const content = JSON.stringify({
    servers: { mongodb: { kind: 'mongodb', uri: `mongodb://db.example.invalid/?${option}=synthetic-uri-secret` } },
  });
  const profilePath = join(directory, 'profile.json');
  writeFileSync(profilePath, content);
  try {
    const result = await tt(['config', '--config', root], homeEnv(home));
    assert.equal(result.code, 1, result.stdout);
    const body = JSON.parse(result.stdout) as { errorClass: string; echo: { journal: string } };
    assert.equal(body.errorClass, 'config_invalid');
    const human = await tt(['config', '--config', root, '--human'], homeEnv(home));
    assert.equal(human.code, 1, human.stdout);
    const journal = dirname(body.echo.journal);
    const records = readdirSync(journal).map((name) => readFileSync(join(journal, name), 'utf8'));
    assert.equal(records.length, 2);
    for (const published of [result.stdout, result.stderr, human.stdout, human.stderr, ...records]) {
      assert.ok(!published.includes('synthetic-uri-secret'));
    }
    assert.equal(readFileSync(profilePath, 'utf8'), content);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
  const result = await tt(['logs', 'query', '--query', '*', '--start', '-1h', '--end', 'now', '--password', 'секрет']);
  const parsed = JSON.parse(result.stdout) as { errorClass: string };
  assert.equal(parsed.errorClass, 'bad_request');
});

test('config исключает userinfo из старого URL, сохраняя профиль', async () => {
  const home = workspace();
  const root = join(home, 'config.json');
  const baseUrl = 'https://synthetic-user:synthetic-password@grafana.example.invalid/path/';
  const content = JSON.stringify({
    grafana: { baseUrl },
    journal: { directory: join(home, 'journal') },
  });
  writeFileSync(root, content);
  try {
    const result = await tt(['config', '--config', root], homeEnv(home));
    assert.equal(result.code, 0, result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.data.grafana.baseUrl, 'https://grafana.example.invalid/path/');
    for (const published of [result.stdout, result.stderr, readFileSync(body.echo.journal, 'utf8')]) {
      assert.ok(!published.includes('synthetic-password'));
      assert.ok(!published.includes('synthetic-user'));
    }
    assert.equal(readFileSync(root, 'utf8'), content);
    assert.equal(resolveActiveProfile(root, null).grafana?.baseUrl, baseUrl);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('явный config init создаёт выбранный профиль и сохраняет существующий root', async () => {
  const home = workspace();
  const env = homeEnv(home);
  const root = join(home, '.tt-stand', 'config.json');
  try {
    const first = await tt(['config', 'init', '--profile', 'first'], env);
    assert.equal(first.code, 0, first.stdout);
    assert.deepEqual(JSON.parse(readFileSync(root, 'utf8')), { defaultProfile: 'first' });
    const shown = await tt(['config'], env);
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal(JSON.parse(shown.stdout).data.profile, 'first');
    const rootContent = JSON.stringify({ defaultProfile: 'first', extra: 'synthetic-value' });
    writeFileSync(root, rootContent);
    for (const name of ['second', 'default']) {
      const created = await tt(['config', 'init', '--profile', name], env);
      assert.equal(created.code, 0, created.stdout);
      const body = JSON.parse(created.stdout);
      assert.equal(body.data.changed, true);
      assert.equal(body.data.overwritten, false);
      assert.ok(existsSync(join(home, '.tt-stand', 'profiles', name, 'profile.json')));
      assert.equal(readFileSync(root, 'utf8'), rootContent);
    }
    const repeat = await tt(['config', 'init', '--profile', 'second'], env);
    assert.equal(JSON.parse(repeat.stdout).data.changed, false);
    const forced = await tt(['config', 'init', '--profile', 'second', '--force'], env);
    assert.equal(forced.code, 0, forced.stdout);
    assert.equal(JSON.parse(forced.stdout).data.overwritten, true);
    assert.deepEqual(JSON.parse(forced.stdout).echo.ignoredFlags, []);
    assert.equal(readFileSync(root, 'utf8'), rootContent);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('удалённый config use возвращает bad_request и сохраняет общий config', async () => {
  const home = workspace();
  const directory = join(home, '.tt-stand');
  const root = join(directory, 'config.json');
  for (const name of ['first', 'second']) {
    const profileDirectory = join(directory, 'profiles', name);
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, 'profile.json'),
      JSON.stringify({ journal: { directory: join(profileDirectory, 'journal') } }),
    );
  }
  const content = '{\n  "defaultProfile": "first",\n  "extra": "synthetic-value"\n}\n';
  writeFileSync(root, content);
  try {
    for (const args of [[], ['--config', root], [`--config=${root}`]]) {
      const result = await tt(['config', 'use', 'second', ...args], homeEnv(home));
      assert.equal(result.code, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).errorClass, 'bad_request');
      assert.equal(readFileSync(root, 'utf8'), content);
      assert.equal(resolveActiveProfile(root, null).name, 'first');
    }
    const missingRoot = join(directory, 'missing.json');
    const missing = await tt(['config', 'use', 'second', '--config', missingRoot], homeEnv(home));
    assert.equal(JSON.parse(missing.stdout).errorClass, 'bad_request');
    assert.ok(!existsSync(missingRoot));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
