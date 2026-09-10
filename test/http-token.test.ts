import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { type LogsContext, runHttpLogs } from '../src/commands/logs.ts';
import { readTokenFromStdin } from '../src/commands/token.ts';
import { parseHttpMessage } from '../src/http.ts';
import { decodeToken } from '../src/token.ts';

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function jwt(header: unknown, payload: unknown): string {
  return `${part(header)}.${part(payload)}.test-signature`;
}

test('строка веб-трафика разбирается вместе с токеном, исходные значения не меняются', () => {
  const token = jwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      sub: 'user-fictional-17',
      roles: ['reader', 'editor'],
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    },
  );
  const message =
    `198.51.100.27 - - [01/Jan/2026:00:00:00 +0000] ` +
    `"PUT /api/entities/item-7?access_token=${token} HTTP/1.1" 204 321 ` +
    `"https://app.example.invalid/" "FictionalAgent/1.0" ` +
    `request_time=0.245 upstream=demo-api-8080`;

  const parsed = parseHttpMessage(message);
  assert.ok(parsed);
  assert.equal(parsed.method, 'PUT');
  assert.equal(parsed.path, `/api/entities/item-7?access_token=${token}`);
  assert.equal(parsed.protocol, 'HTTP/1.1');
  assert.equal(parsed.responseStatus, 204);
  assert.equal(parsed.responseSize, 321);
  assert.equal(parsed.duration, '0.245');
  assert.equal(parsed.clientAddress, '198.51.100.27');
  assert.equal(parsed.userAgent, 'FictionalAgent/1.0');
  assert.equal(parsed.upstream, 'demo-api-8080');
  assert.equal(parsed.tokens.length, 1);
  assert.equal(parsed.tokens[0]?.value, token, 'токен нельзя скрывать или обрезать');
  assert.deepEqual(parsed.tokens[0]?.payload, {
    sub: 'user-fictional-17',
    roles: ['reader', 'editor'],
    iat: 1_700_000_000,
    exp: 1_700_000_600,
  });
  assert.equal(parsed.tokens[0]?.signatureVerified, false);
  assert.equal(parsed.tokens[0]?.source, 'address');
});

test('неразбираемая строка остаётся в выдаче с http null и считается в сводке', async () => {
  const records = [
    { _msg: 'служебное сообщение без HTTP-запроса', marker: 'сохранить целиком' },
    { _msg: 'GET /health HTTP/2 200 2', marker: 'вторая запись' },
  ];
  const context = {
    client: {
      queryLogs: async () => ({
        records,
        unparsableLines: 0,
        hitLimit: false,
        aborted: false,
        abortReason: null,
        bodyMissing: false,
      }),
    },
    datasource: { uid: 'fictional', name: 'вымышленный источник', candidates: [] },
    profile: 'default',
    namespaceScope: null,
  } as unknown as LogsContext;

  const response = await runHttpLogs(context, {
    query: '*',
    start: '-1h',
    end: 'now',
    limit: null,
  });
  const data = response.data as Array<{ record: unknown; http: unknown }>;
  assert.equal(data.length, 2);
  assert.strictEqual(data[0]?.record, records[0], 'исходную запись нельзя заменять');
  assert.equal(data[0]?.http, null);
  const parsed = data[1]?.http as { method: string } | undefined;
  assert.equal(parsed?.method, 'GET');
  assert.equal((response.summary as { httpUnparsed: number }).httpUnparsed, 1);
});

test('токен раскрывается целиком, включая нестандартные поля payload', () => {
  const value = jwt(
    { alg: 'none', kid: 'fictional-key', extraHeader: { trace: true } },
    {
      sub: 'fictional-subject',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      nested: { permissions: ['one', 'two'], custom: 42 },
      featureFlag: false,
    },
  );
  const decoded = decodeToken(value);

  assert.equal(decoded.value, value);
  assert.deepEqual(decoded.header, {
    alg: 'none',
    kid: 'fictional-key',
    extraHeader: { trace: true },
  });
  assert.deepEqual(decoded.payload, {
    sub: 'fictional-subject',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
    nested: { permissions: ['one', 'two'], custom: 42 },
    featureFlag: false,
  });
  assert.equal(decoded.issuedAt?.readable, '2023-11-14T22:13:20.000Z');
  assert.equal(decoded.expiresAt?.readable, '2023-11-14T23:13:20.000Z');
  assert.equal(decoded.signatureVerified, false);
});

test('при отсутствии --value токен читается со стандартного ввода до конца', async () => {
  const value = jwt({ alg: 'none' }, { sub: 'fictional-stdin-subject', custom: [1, 2, 3] });
  const input = Readable.from([value.slice(0, 8), value.slice(8), '\n']);
  assert.equal(await readTokenFromStdin(input), value);
});

test('имя upstream извлекается из строки доступа, а не адрес узла', () => {
  const line =
    '192.0.2.11 - - [01/Jan/2026:00:00:00 +0000] "GET /items/ HTTP/1.1" 200 2922 "-" ' +
    '"Mozilla/5.0" 833 0.108 [fictional-team-api-8000] [] 192.0.2.20:8000 7185 0.103 200 abc';
  const parsed = parseHttpMessage(line);
  assert.ok(parsed, 'строка доступа должна разбираться');
  assert.equal(parsed?.upstream, 'fictional-team-api-8000');
  assert.equal(parsed?.method, 'GET');
  assert.equal(parsed?.responseStatus, 200);
});

test('при отсутствии имени upstream берётся адрес из строки ошибки', () => {
  const line =
    'connect() failed while connecting to upstream, client: 192.0.2.11, ' +
    'upstream: "http://192.0.2.20:8000/items/", request: "GET /items/ HTTP/1.1"';
  const parsed = parseHttpMessage(line);
  assert.equal(parsed?.upstream, 'http://192.0.2.20:8000/items/');
});

test('испорченный percent-escape в адресе не мешает раскрыть токен', () => {
  const token = `${part({ alg: 'HS256' })}%2E${part({ sub: '7' })}%2Ec2ln`;
  const parsed = parseHttpMessage(`1.2.3.4 - - "GET /?bad=%ZZ&auth=${token} HTTP/1.1" 200 5`);
  assert.ok(parsed);
  assert.equal(parsed.tokens.length, 1);
  assert.deepEqual(parsed.tokens[0]?.payload, { sub: '7' });
  assert.equal(parsed.tokens[0]?.source, 'address');
});

test('кириллица в адресе декодируется целиком', () => {
  const token = `${part({ alg: 'HS256' })}.${part({ sub: '8' })}.c2ln`;
  const parsed = parseHttpMessage(
    `1.2.3.4 - - "GET /%D0%BF%D0%BE%D0%B8%D1%81%D0%BA?t=${token} HTTP/1.1" 200 5`,
  );
  assert.ok(parsed);
  assert.equal(parsed.tokens.length, 1);
});

test('символ вне base64url делает токен неразобранным', () => {
  assert.throws(
    () => decodeToken(`${part({ alg: 'none' })}!.${part({ sub: '1' })}.c2ln`),
    (error: Error & { errorClass?: string }) => error.errorClass === 'token_invalid',
  );
});
