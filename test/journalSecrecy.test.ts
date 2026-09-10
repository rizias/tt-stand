import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { homeEnv, tt } from './ttRunner.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-journal-secrecy-'));
}

async function startFakeGrafana(login: string, password: string): Promise<{ url: string; server: Server }> {
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
    writeFileSync(
      join(profileDirectory, 'credentials.json'),
      JSON.stringify({ kind: 'basic', login, password }),
    );

    const result = await tt(
      ['logs', 'query', '--query', '*', '--start', '-1h', '--end', 'now'],
      homeEnv(home),
    );
    assert.equal(result.code, 0, result.stdout);
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
