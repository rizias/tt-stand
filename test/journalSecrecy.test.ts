import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { atomicWriteFile } from '../src/lock.ts';
import { homeEnv, tt } from './ttRunner.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-journal-secrecy-'));
}

async function startFakeGrafana(
  login: string,
  password: string,
  onQuery?: (response: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const expected = `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;
  const server = createServer((request, response) => {
    if (request.url === '/api/datasources') {
      assert.equal(request.headers.authorization, expected);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([{ uid: 'fictional-ds', name: 'фиктивный', type: 'victoriametrics-logs-datasource' }]),
      );
      return;
    }
    if (request.url?.startsWith('/api/datasources/proxy/uid/fictional-ds/select/logsql/query')) {
      assert.equal(request.headers.authorization, expected);
      if (onQuery) {
        onQuery(response);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('{"_msg":"фиктивная запись"}\n');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

test('журнал успешного обращения к Grafana не содержит логина, пароля и заголовка доступа', async () => {
  const sandbox = workspace();
  const home = join(sandbox, 'home');
  mkdirSync(home, { recursive: true });
  const login = 'fictional-reader';
  const password = 'вымышленный-пароль-для-проверки';
  const { url, server } = await startFakeGrafana(login, password);

  try {
    const profileDirectory = join(home, '.tt-stand', 'profiles', 'default');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(home, '.tt-stand', 'config.json'), JSON.stringify({ defaultProfile: 'default' }));
    writeFileSync(join(profileDirectory, 'profile.json'), JSON.stringify({ grafana: { baseUrl: url } }));
    writeFileSync(join(profileDirectory, 'credentials.json'), JSON.stringify({ kind: 'basic', login, password }));

    const result = await tt(['logs', 'query', '--query', '*', '--start', '-1h', '--end', 'now'], homeEnv(home));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; echo: { profile?: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.echo.profile, 'default');

    const journalDirectory = join(home, '.tt-stand', 'profiles', 'default', 'journal');
    const files = readdirSync(journalDirectory);
    assert.equal(files.length, 1);
    const content = readFileSync(join(journalDirectory, files[0] as string), 'utf8');
    assert.ok(!content.includes(login), 'логин не должен попасть в журнал');
    assert.ok(!content.includes(password), 'пароль не должен попасть в журнал');
    assert.ok(!content.includes('Basic '), 'заголовок доступа не должен попасть в журнал');
    assert.match(content, /"profile": ?"default"/);
  } finally {
    server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('смена текущего профиля во время запроса сохраняет исходный профиль ответа и журнала', async () => {
  const home = workspace();
  const stateDirectory = join(home, '.tt-stand');
  const firstDirectory = join(stateDirectory, 'profiles', 'first');
  const secondDirectory = join(stateDirectory, 'profiles', 'second');
  let receiveQuery!: (response: ServerResponse) => void;
  const queryReceived = new Promise<ServerResponse>((resolve) => {
    receiveQuery = resolve;
  });
  const { server, url } = await startFakeGrafana('synthetic-reader', 'synthetic-password', receiveQuery);
  let query: ReturnType<typeof tt> | undefined;
  try {
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(secondDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'config.json'), JSON.stringify({ defaultProfile: 'first' }));
    writeFileSync(join(firstDirectory, 'profile.json'), JSON.stringify({ grafana: { baseUrl: url } }));
    writeFileSync(
      join(firstDirectory, 'credentials.json'),
      JSON.stringify({ kind: 'basic', login: 'synthetic-reader', password: 'synthetic-password' }),
    );
    writeFileSync(join(secondDirectory, 'profile.json'), JSON.stringify({ servers: {} }));
    query = tt(['logs', 'query', '--query', '*', '--start', '-1h', '--end', 'now'], homeEnv(home));
    const pendingResponse = await Promise.race([
      queryReceived,
      query.then((outcome) => {
        throw new Error(`CLI завершился до получения HTTP-запроса. ${outcome.stdout}${outcome.stderr}`);
      }),
    ]);
    atomicWriteFile(join(stateDirectory, 'config.json'), JSON.stringify({ defaultProfile: 'second' }));
    pendingResponse.writeHead(200, { 'content-type': 'application/x-ndjson' });
    pendingResponse.end('{"_msg":"synthetic delayed response"}\n');
    const outcome = await query;
    assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
    const response = JSON.parse(outcome.stdout) as { echo: { profile: string; journal: string } };
    assert.equal(response.echo.profile, 'first');
    assert.equal(dirname(response.echo.journal), join(firstDirectory, 'journal'));
    const entry = JSON.parse(readFileSync(response.echo.journal, 'utf8')) as {
      profile: string;
      invocation: string[];
      response: { echo: { profile: string; journal: string } };
    };
    assert.equal(entry.profile, 'first');
    assert.equal(entry.response.echo.profile, 'first');
    assert.equal(entry.response.echo.journal, response.echo.journal);
    assert.ok(!entry.invocation.includes('--profile'));
    const current = await tt(['config', '--json'], homeEnv(home));
    assert.equal(current.code, 0, current.stdout + current.stderr);
    assert.equal(JSON.parse(current.stdout).data.profile, 'second');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await query;
    assert.ok(home.startsWith(join(tmpdir(), 'tt-stand-journal-secrecy-')));
    rmSync(home, { recursive: true, force: true });
  }
});

test('параллельные процессы публикуют отдельные полные записи журнала', async () => {
  const home = workspace();
  try {
    const stateDirectory = join(home, '.tt-stand');
    const profileDirectory = join(stateDirectory, 'profiles', 'default');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'config.json'), JSON.stringify({ defaultProfile: 'default' }));
    writeFileSync(join(profileDirectory, 'profile.json'), '{}');
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        tt(['config', '--json'], {
          ...homeEnv(home),
          TT_STAND_RUN: 'fictional-concurrent-investigation',
        }),
      ),
    );
    const files = new Set<string>();
    for (const outcome of outcomes) {
      assert.equal(outcome.code, 0, outcome.stderr + outcome.stdout);
      const response = JSON.parse(outcome.stdout);
      files.add(response.echo.journal);
      const entry = JSON.parse(readFileSync(response.echo.journal, 'utf8'));
      assert.equal(entry.response.echo.journal, response.echo.journal);
      assert.equal(entry.origin.run, 'fictional-concurrent-investigation');
      assert.equal(entry.profile, 'default');
    }
    assert.equal(files.size, 4);
    assert.equal(readdirSync(join(home, '.tt-stand', 'profiles', 'default', 'journal')).length, 4);
  } finally {
    assert.ok(home.startsWith(join(tmpdir(), 'tt-stand-journal-secrecy-')));
    rmSync(home, { recursive: true, force: true });
  }
});
