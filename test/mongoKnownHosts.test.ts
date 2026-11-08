import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { knownHostVerifier } from '../src/mongo/knownHosts.ts';

const key = Buffer.from('synthetic-host-key');
const other = Buffer.from('different-host-key');
const encoded = key.toString('base64');

test('known_hosts принимает только совпавший обычный ключ хоста', () => {
  const verify = knownHostVerifier(`db.example.invalid ssh-ed25519 ${encoded}\n`, 'db.example.invalid', 22);
  expect(verify(key)).toBe(true);
  expect(verify(other)).toBe(false);
  expect(knownHostVerifier(`other.example.invalid ssh-ed25519 ${encoded}`, 'db.example.invalid', 22)(key)).toBe(false);
});

test('порт входит в имя known_hosts', () => {
  const verify = knownHostVerifier(`[db.example.invalid]:2200 ssh-ed25519 ${encoded}`, 'db.example.invalid', 2200);
  expect(verify(key)).toBe(true);
  expect(knownHostVerifier(`db.example.invalid ssh-ed25519 ${encoded}`, 'db.example.invalid', 2200)(key)).toBe(false);
});

test('known_hosts поддерживает хешированные имена и порт', () => {
  const salt = Buffer.from('synthetic-salt');
  const hostname = '[db.example.invalid]:2200';
  const digest = createHmac('sha1', salt).update(hostname).digest('base64');
  const line = `|1|${salt.toString('base64')}|${digest} ssh-ed25519 ${encoded}`;
  expect(knownHostVerifier(line, 'db.example.invalid', 2200)(key)).toBe(true);
  expect(knownHostVerifier(line, 'db.example.invalid', 22)(key)).toBe(false);
});

test('known_hosts учитывает alias wildcard и отрицательное имя', () => {
  const line = `*.example.invalid,!blocked.example.invalid ssh-ed25519 ${encoded}`;
  expect(knownHostVerifier(line, 'db.example.invalid', 22)(key)).toBe(true);
  expect(knownHostVerifier(line, 'blocked.example.invalid', 22)(key)).toBe(false);
  expect(knownHostVerifier(`alias,db.example.invalid ssh-ed25519 ${encoded}`, 'db.example.invalid', 22)(key)).toBe(
    true,
  );
});

test('отозванный ключ и сертификат без проверки CA отклоняются', () => {
  const revoked = `db.example.invalid ssh-ed25519 ${encoded}\n@revoked db.example.invalid ssh-ed25519 ${encoded}`;
  expect(knownHostVerifier(revoked, 'db.example.invalid', 22)(key)).toBe(false);
  expect(
    knownHostVerifier(`@cert-authority db.example.invalid ssh-ed25519 ${encoded}`, 'db.example.invalid', 22)(key),
  ).toBe(false);
  expect(knownHostVerifier('# empty\nmalformed\n', 'db.example.invalid', 22)(key)).toBe(false);
});
