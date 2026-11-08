import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MongoClient } from 'mongodb';
import { afterEach, test, vi } from 'vitest';
import { runConfigShow } from '../src/commands/config.ts';
import { runConfigInit } from '../src/commands/configInit.ts';
import { readCredentials, readServerCredentials } from '../src/credentials.ts';
import { ToolError } from '../src/errors.ts';
import { normalizePath } from '../src/paths.ts';
import { requireGrafana, requireKubernetes, requireMongo } from '../src/profile.ts';
import { parseServers } from '../src/profileServers.ts';
import { resolveActiveProfile } from '../src/profiles.ts';

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tt-stand-mongo-config-'));
  directories.push(directory);
  const rootPath = join(directory, 'config.json');
  const profileDirectory = join(directory, 'profiles', 'selected');
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(rootPath, JSON.stringify({ defaultProfile: 'selected' }));
  const profilePath = join(profileDirectory, 'profile.json');
  const servers = {
    ssh: { kind: 'ssh', host: 'ssh.example.invalid', username: 'reader', privateKeyPath: './key' },
    mongodb: {
      kind: 'mongodb',
      uri: 'mongodb://db.example.invalid:27017',
      sshServer: 'ssh',
      defaultDatabase: 'example',
    },
  };
  writeFileSync(profilePath, JSON.stringify({ servers }));
  return { directory, rootPath, profileDirectory, profilePath, servers };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('MongoDB читается через прежний root --config и defaultProfile', () => {
  const setup = fixture();
  const target = requireMongo(resolveActiveProfile(setup.rootPath, null));
  assert.equal(target.profileName, 'selected');
  assert.equal(target.database, 'example');
  assert.equal(target.ssh.privateKeyPath, join(setup.profileDirectory, 'key'));
  assert.equal(target.ssh.port, 22);
  assert.equal(target.ssh.timeoutSeconds, 30);
  assert.equal(target.timeoutSeconds, 30);
});

test('TT_STAND_CONFIG сохраняет root semantics для MongoDB', () => {
  const setup = fixture();
  vi.stubEnv('TT_STAND_CONFIG', setup.rootPath);
  assert.equal(requireMongo(resolveActiveProfile(undefined, null)).database, 'example');
});

test('прежний плоский root сохраняет путь .grafana-ro в синтетическом HOME', () => {
  const setup = fixture();
  const root = join(setup.directory, 'legacy', 'config.json');
  mkdirSync(dirname(root));
  writeFileSync(root, JSON.stringify({ grafana: {} }));
  vi.stubEnv('HOME', setup.directory);
  vi.stubEnv('USERPROFILE', setup.directory);
  const profile = resolveActiveProfile(root, null);
  assert.equal(requireGrafana(profile).credentialsFile, join(setup.directory, '.tt-stand', '.grafana-ro'));
  assert.equal(requireKubernetes(profile).kubeconfig, null);
  assert.equal(profile.name, 'default');
});

test('MongoDB в плоском root сохраняет одинаковый выбор через --config и TT_STAND_CONFIG', () => {
  const setup = fixture();
  const root = join(setup.directory, 'legacy', 'profile.json');
  mkdirSync(dirname(root));
  writeFileSync(root, JSON.stringify({ grafana: {}, servers: setup.servers }));
  vi.stubEnv('HOME', setup.directory);
  vi.stubEnv('USERPROFILE', setup.directory);
  vi.stubEnv('TT_STAND_CONFIG', root);
  for (const argument of [root, undefined]) {
    const profile = resolveActiveProfile(argument, 'default');
    assert.equal(profile.name, 'default');
    assert.equal(requireGrafana(profile).credentialsFile, join(setup.directory, '.tt-stand', '.grafana-ro'));
    assert.equal(requireMongo(profile).profileName, 'default');
    assert.throws(() => resolveActiveProfile(argument, 'missing'), { errorClass: 'profile_missing' });
  }
});

test('--config сохраняет смысл общего файла для пути MongoDB profile.json', () => {
  const setup = fixture();
  assert.throws(() => resolveActiveProfile(setup.profilePath, null), { errorClass: 'profile_missing' });
  assert.throws(() => resolveActiveProfile(setup.profilePath, 'selected'), { errorClass: 'profile_missing' });
  vi.stubEnv('TT_STAND_CONFIG', setup.profilePath);
  assert.throws(() => resolveActiveProfile(undefined, null), { errorClass: 'profile_missing' });
});

test('MongoDB сохраняет выбор --profile перед TT_STAND_PROFILE и defaultProfile', () => {
  const setup = fixture();
  const otherDirectory = join(setup.directory, 'profiles', 'other');
  mkdirSync(otherDirectory);
  writeFileSync(join(otherDirectory, 'profile.json'), JSON.stringify({ servers: setup.servers }));
  vi.stubEnv('TT_STAND_PROFILE', 'other');
  assert.equal(requireMongo(resolveActiveProfile(setup.rootPath, null)).profileName, 'other');
  assert.equal(requireMongo(resolveActiveProfile(setup.rootPath, 'selected')).profileName, 'selected');
  vi.stubEnv('TT_STAND_PROFILE', undefined);
  assert.equal(requireMongo(resolveActiveProfile(setup.rootPath, null)).profileName, 'selected');
});

test('servers допускает только SSH и MongoDB', () => {
  const setup = fixture();
  for (const kind of ['grafana', 'kubernetes']) {
    writeFileSync(setup.profilePath, JSON.stringify({ servers: { unsupported: { kind } } }));
    assert.throws(() => resolveActiveProfile(setup.rootPath, null), { errorClass: 'config_invalid' });
  }
});

test('имена серверов не пересекаются с полями доступа Grafana', () => {
  const setup = fixture();
  for (const name of ['kind', 'login', 'password', 'token']) {
    writeFileSync(setup.profilePath, JSON.stringify({ servers: { [name]: setup.servers.ssh } }));
    assert.throws(() => resolveActiveProfile(setup.rootPath, null), {
      errorClass: 'config_invalid',
      message: new RegExp(`зарезервированное имя сервера ${name}`, 'u'),
    });
  }
});

test('настройки MongoDB и журнала берутся из файла, description не участвует в профиле', () => {
  const setup = fixture();
  writeFileSync(
    setup.profilePath,
    JSON.stringify({
      servers: setup.servers,
      description: 'Синтетическое\nописание',
      journal: { directory: join(setup.directory, 'journal') },
    }),
  );
  const overrides = {
    TT_STAND_DESCRIPTION: 'Переменная окружения',
    TT_STAND_JOURNAL_DIRECTORY: join(setup.directory, 'other-journal'),
    TT_STAND_SERVER_SSH_HOST: 'other.example.invalid',
    TT_STAND_SERVER_SSH_PORT: '2200',
    TT_STAND_SERVER_SSH_PRIVATE_KEY_PATH: './other-key',
    TT_STAND_SERVER_MONGODB_KIND: 'grafana',
    TT_STAND_SERVER_MONGODB_URI: 'mongodb://other.example.invalid',
    TT_STAND_SERVER_MONGODB_DEFAULT_DATABASE: 'other',
  };
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  const profile = resolveActiveProfile(setup.rootPath, null);
  const target = requireMongo(profile);
  assert.equal(target.database, 'example');
  assert.equal(target.uri, setup.servers.mongodb.uri);
  assert.equal(target.ssh.host, setup.servers.ssh.host);
  assert.equal(target.ssh.port, 22);
  assert.equal(target.ssh.privateKeyPath, join(setup.profileDirectory, 'key'));
  assert.equal(profile.journalDirectory, join(setup.directory, 'journal'));
  assert.equal(Object.hasOwn(profile, 'description'), false);
  assert.equal(Object.hasOwn(profile.fieldSources, 'description'), false);
  assert.deepEqual(profile.serverSources.ssh?.port, { value: 22, source: 'default' });
  assert.deepEqual(profile.serverSources.mongodb?.uri, { value: setup.servers.mongodb.uri, source: 'file' });
});

test('прежние Grafana и Kubernetes сосуществуют с MongoDB без изменения путей', () => {
  const setup = fixture();
  const credentialPath = join(setup.directory, 'grafana-access.json');
  writeFileSync(
    credentialPath,
    JSON.stringify({ kind: 'basic', login: 'synthetic-user', password: 'synthetic-password' }),
  );
  writeFileSync(
    setup.profilePath,
    JSON.stringify({
      grafana: { credentialsFile: credentialPath, baseUrl: 'https://grafana.example.invalid/' },
      kubernetes: { kubeconfig: './legacy-kubeconfig', context: 'legacy-context' },
      repositoryRoots: ['./legacy-repository'],
      journal: { directory: './legacy-journal' },
      servers: setup.servers,
    }),
  );
  const profile = resolveActiveProfile(setup.rootPath, null);
  const grafana = requireGrafana(profile);
  assert.equal(grafana.credentialsFile, credentialPath);
  assert.equal(grafana.timeoutSeconds, null);
  assert.equal(
    readCredentials(grafana.credentialsFile, grafana.baseUrl, profile.name).baseUrl,
    'https://grafana.example.invalid',
  );
  assert.equal(requireKubernetes(profile).kubeconfig, normalizePath('./legacy-kubeconfig'));
  assert.deepEqual(profile.repositoryRoots, [normalizePath('./legacy-repository')]);
  assert.equal(profile.journalDirectory, normalizePath('./legacy-journal'));
  assert.equal(requireMongo(profile).ssh.privateKeyPath, join(setup.profileDirectory, 'key'));
});

test('старые Grafana credentials и именованные MongoDB секреты читаются из одного JSON', () => {
  const setup = fixture();
  const path = join(setup.profileDirectory, 'credentials.json');
  writeFileSync(
    path,
    JSON.stringify({
      kind: 'basic',
      login: 'synthetic-grafana-user',
      password: 'synthetic-grafana-password',
      mongodb: { username: 'synthetic-mongo-user', password: 'synthetic-mongo-password' },
      ssh: { passphrase: 'synthetic-passphrase' },
    }),
  );
  const grafana = readCredentials(path, 'https://grafana.example.invalid', 'selected');
  assert.equal(grafana.kind === 'basic' && grafana.login, 'synthetic-grafana-user');
  assert.deepEqual(readServerCredentials(path, 'mongodb', 'selected', 'mongodb'), {
    username: 'synthetic-mongo-user',
    password: 'synthetic-mongo-password',
  });
  assert.deepEqual(readServerCredentials(path, 'ssh', 'selected', 'ssh'), { passphrase: 'synthetic-passphrase' });
});

test('опциональные MongoDB секреты допускают пустой файл и JSON-доступ Grafana', () => {
  const setup = fixture();
  const path = join(setup.profileDirectory, 'credentials.json');
  for (const content of ['', '{"kind":"token","token":"synthetic-token"}']) {
    writeFileSync(path, content);
    assert.deepEqual(readServerCredentials(path, 'ssh', 'selected', 'ssh'), {});
    assert.deepEqual(readServerCredentials(path, 'mongodb', 'selected', 'mongodb'), {});
  }
});

test('ошибка отдельного поля MongoDB credentials называет поле без значения', () => {
  const setup = fixture();
  const path = join(setup.profileDirectory, 'credentials.json');
  writeFileSync(path, JSON.stringify({ mongodb: { password: { value: 'synthetic-secret' } } }));
  assert.throws(
    () => readServerCredentials(path, 'mongodb', 'selected', 'mongodb'),
    (error: ToolError) =>
      error.message.includes(path) && error.message.includes('password') && !error.message.includes('synthetic-secret'),
  );
});

test('bindings и поле profile не меняют прежний выбор defaultProfile', () => {
  const setup = fixture();
  writeFileSync(
    setup.rootPath,
    JSON.stringify({
      defaultProfile: 'selected',
      profile: 'missing',
      bindings: { [process.cwd()]: 'missing' },
    }),
  );
  assert.equal(resolveActiveProfile(setup.rootPath, null).name, 'selected');
  writeFileSync(setup.rootPath, JSON.stringify({ profile: 'missing', bindings: { [process.cwd()]: 'missing' } }));
  assert.equal(resolveActiveProfile(setup.rootPath, null).name, 'selected');
});

test('config show описывает старые настройки и скрывает все значения доступа', () => {
  const setup = fixture();
  writeFileSync(
    setup.profilePath,
    JSON.stringify({
      grafana: { baseUrl: 'https://grafana.example.invalid' },
      servers: setup.servers,
    }),
  );
  writeFileSync(
    join(setup.profileDirectory, 'credentials.json'),
    JSON.stringify({
      kind: 'token',
      token: 'synthetic-token',
      mongodb: { password: 'synthetic-password' },
    }),
  );
  const result = runConfigShow(setup.rootPath);
  const data = result.data as {
    defaultProfile: string;
    grafana: { credentialsFile: string };
    servers: Record<string, { secrets: Record<string, { set: boolean; source: string }> }>;
  };
  assert.equal(data.defaultProfile, 'selected');
  assert.equal(dirname(data.grafana.credentialsFile), setup.profileDirectory);
  assert.ok(!JSON.stringify(result).includes('synthetic-token'));
  assert.ok(!JSON.stringify(result).includes('synthetic-password'));
  assert.deepEqual(data.servers.mongodb?.secrets.password, { set: true, source: 'file' });
  assert.deepEqual(data.servers.mongodb?.secrets.username, { set: false, source: 'default' });
});

test('config show сохраняет URL без userinfo без нормализации', () => {
  const setup = fixture();
  const baseUrl = 'HTTPS://Grafana.Example.Invalid:443/path/?param=value#fragment';
  writeFileSync(setup.profilePath, JSON.stringify({ grafana: { baseUrl } }));
  const result = runConfigShow(setup.rootPath);
  assert.equal((result.data as { grafana: { baseUrl: string } }).grafana.baseUrl, baseUrl);
});

test('config show скрывает userinfo даже в некорректном адресе Grafana', () => {
  const setup = fixture();
  const secret = 'synthetic-password';
  writeFileSync(setup.profilePath, JSON.stringify({ grafana: { baseUrl: `http:/synthetic-user:${secret}@host` } }));
  const result = runConfigShow(setup.rootPath);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('synthetic-user'));
});

test('некорректный MongoDB URI с userinfo отклоняется до вывода config show', () => {
  const setup = fixture();
  writeFileSync(
    setup.profilePath,
    JSON.stringify({
      servers: {
        ...setup.servers,
        mongodb: { ...setup.servers.mongodb, uri: 'mongodb:/synthetic-user:synthetic-password@host' },
      },
    }),
  );
  assert.throws(() => runConfigShow(setup.rootPath), { errorClass: 'config_invalid' });
});

test('MongoDB URI с несколькими адресами и портами остаётся допустимым', () => {
  const setup = fixture();
  const uri = 'mongodb://db-1.example.invalid:27017,db-2.example.invalid:27018/example';
  writeFileSync(
    setup.profilePath,
    JSON.stringify({ servers: { ...setup.servers, mongodb: { ...setup.servers.mongodb, uri } } }),
  );
  assert.equal(requireMongo(resolveActiveProfile(setup.rootPath, null)).uri, uri);
});

test.each(['', 'appName=test?x&', 'appName=test?x?y&', 'appName=test%3Fx%23y&'])(
  'config show отклоняет секретные параметры URI после %s',
  (prefix) => {
    const setup = fixture();
    for (const name of ['passphrase', 'key', 'pfx', 'PASSPHRASE', 'KEY', 'PFX', '%70assphrase', '%6bey', '%70fx']) {
      const servers = {
        ...setup.servers,
        mongodb: {
          ...setup.servers.mongodb,
          uri: `mongodb://db.example.invalid/?${prefix}${name}=synthetic-secret#tail`,
        },
      };
      writeFileSync(setup.profilePath, JSON.stringify({ servers }));
      assert.throws(
        () => runConfigShow(setup.rootPath),
        (error: unknown) => {
          assert.ok(error instanceof ToolError);
          assert.equal(error.errorClass, 'config_invalid');
          assert.match(error.message, /servers\.mongodb\.uri/);
          assert.ok(!error.message.includes('synthetic-secret'));
          return true;
        },
      );
    }
  },
);

test.each(['#fragment?passphrase=fragment-text', '?appName=test#fragment?passphrase=fragment-text'])(
  'URI не считает fragment параметрами подключения %s',
  (suffix) => {
    const setup = fixture();
    const uri = `mongodb://db.example.invalid/${suffix}`;
    const parsed = parseServers({ mongodb: { kind: 'mongodb', uri } }, setup.profilePath);
    const server = parsed.servers.mongodb;
    assert.ok(server?.kind === 'mongodb');
    assert.equal(server.uri, uri);
  },
);

test.each([
  ['TAB', '\t'],
  ['CR', '\r'],
  ['LF', '\n'],
])('config show отклоняет секретные параметры URI с сырым %s', (_name, control) => {
  const setup = fixture();
  for (const option of ['passphrase', 'key', 'pfx', '%70assphrase']) {
    for (const name of [`${control}${option}`, `${option[0]}${control}${option.slice(1)}`, `${option}${control}`]) {
      const uri = `mongodb://db.example.invalid/?appName=test?x&${name}=synthetic-secret#tail`;
      writeFileSync(setup.profilePath, JSON.stringify({ servers: { mongodb: { kind: 'mongodb', uri } } }));
      assert.throws(
        () => runConfigShow(setup.rootPath),
        (error: unknown) => {
          assert.ok(error instanceof ToolError);
          assert.equal(error.errorClass, 'config_invalid');
          assert.ok(!error.message.includes('synthetic-secret'));
          return true;
        },
      );
    }
  }
});

test('MongoClient нормализует сырой TAB в имени секретного параметра', () => {
  for (const name of ['pass\tphrase', '\tkey', 'pfx\t', '%70ass\tphrase']) {
    const client = new MongoClient(`mongodb://db.example.invalid/?appName=test?x&${name}=synthetic-secret`);
    const option = decodeURIComponent(name.replaceAll('\t', '')) as 'passphrase' | 'key' | 'pfx';
    assert.equal(client.options[option], 'synthetic-secret');
  }
});

test.each(['%09', '%0D', '%0A'])('URI сохраняет кодированный управляющий символ %s в имени параметра', (control) => {
  const setup = fixture();
  const uri = `mongodb://db.example.invalid/?pass${control}phrase=ordinary-value`;
  const parsed = parseServers({ mongodb: { kind: 'mongodb', uri } }, setup.profilePath);
  const server = parsed.servers.mongodb;
  assert.ok(server?.kind === 'mongodb');
  assert.equal(server.uri, uri);
  assert.throws(() => new MongoClient(uri), /not supported/u);
});

test.each([
  '?appName=fi\txture',
  '?appName=fi\rxture',
  '?appName=fi\nxture',
  '?appName=fi%09xture',
  '?appName=fi%0Dxture',
  '?appName=fi%0Axture',
  '?appName=test#fragment?pass\tphrase=fragment-text',
])('URI сохраняет исходное представление обычных параметров %j', (suffix) => {
  const setup = fixture();
  const uri = `mongodb://db.example.invalid/${suffix}`;
  const parsed = parseServers({ mongodb: { kind: 'mongodb', uri } }, setup.profilePath);
  const server = parsed.servers.mongodb;
  assert.ok(server?.kind === 'mongodb');
  assert.equal(server.uri, uri);
  const client = new MongoClient(uri);
  assert.equal(client.options.passphrase, undefined);
});

test.each(['ssh', 'mongodb'])('таймаут %s ограничен диапазоном таймера Node', (kind) => {
  const setup = fixture();
  for (const timeoutSeconds of [0.001, 30, 2147483.647]) {
    const parsed = parseServers({ fixture: { kind, timeoutSeconds } }, setup.profilePath);
    assert.equal(parsed.servers.fixture?.timeoutSeconds, timeoutSeconds);
  }
  for (const timeoutSeconds of [2147483.648, 2147484, Number.MAX_VALUE]) {
    assert.throws(() => parseServers({ fixture: { kind, timeoutSeconds } }, setup.profilePath), {
      errorClass: 'config_invalid',
    });
  }
});

test('создание профиля отклоняет выход из каталога профилей', async () => {
  const setup = fixture();
  for (const name of ['../outside', '..\\outside', '/outside', 'C:outside']) {
    await assert.rejects(runConfigInit(setup.rootPath, false, name), { errorClass: 'config_invalid' });
  }
});

test('явный config init --force восстанавливает профиль и сохраняет root и credentials', async () => {
  const setup = fixture();
  const credentialsPath = join(setup.profileDirectory, 'credentials.json');
  const secret = '{"kind":"token","token":"synthetic-secret"}';
  writeFileSync(credentialsPath, secret);
  const rootBefore = readFileSync(setup.rootPath, 'utf8');
  await runConfigInit(setup.rootPath, true, 'selected');
  const profile = JSON.parse(readFileSync(setup.profilePath, 'utf8')) as Record<string, unknown>;
  assert.equal(readFileSync(setup.rootPath, 'utf8'), rootBefore);
  assert.ok(profile.grafana);
  assert.ok(profile.kubernetes);
  assert.equal(readFileSync(credentialsPath, 'utf8'), secret);
});
