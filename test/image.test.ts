import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseImageReference, runImage } from '../src/commands/image.ts';

test('тег разбирается на версию и полный SHA', () => {
  const sha = 'a'.repeat(40);
  const parsed = parseImageReference(`example-api:1.2.3-${sha}`);
  assert.equal(parsed.name, 'example-api');
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.commit, sha);
});

test('версия с pre-release не ломает выделение SHA', () => {
  const sha = 'b'.repeat(40);
  const parsed = parseImageReference(`example-ui:8.0.0-rc.12-${sha}`);
  assert.equal(parsed.version, '8.0.0-rc.12');
  assert.equal(parsed.commit, sha);
});

test('адрес реестра отделяется от имени образа', () => {
  const sha = 'c'.repeat(40);
  const parsed = parseImageReference(`registry.example.invalid:5000/example-api:2.0.0-${sha}`);
  assert.equal(parsed.registry, 'registry.example.invalid:5000');
  assert.equal(parsed.name, 'example-api');
  assert.equal(parsed.commit, sha);
});

test('SHA в верхнем регистре распознаётся', () => {
  const sha = 'A'.repeat(40);
  assert.equal(parseImageReference(`example-api:1.0.0-${sha}`).commit, sha);
});

test('сторонний образ без SHA не даёт коммита', () => {
  const parsed = parseImageReference('third-party-tool:curl');
  assert.equal(parsed.commit, null);
  assert.equal(parsed.tag, 'curl');
});

test('короткий шестнадцатеричный хвост не принимается за коммит', () => {
  const parsed = parseImageReference('example-api:1.0.0-abc123');
  assert.equal(parsed.commit, null, 'SHA должен быть ровно 40 символов');
});

test('тег из одного только SHA разбирается, версии нет', () => {
  const sha = 'd'.repeat(40);
  const parsed = parseImageReference(`example-api:${sha}`);
  assert.equal(parsed.commit, sha);
  assert.equal(parsed.version, null);
});

test('организация в имени образа не теряется', () => {
  const sha = 'b'.repeat(40);
  const parsed = parseImageReference(
    `registry.fictional-registry.invalid:5000/acme/example-api:1.2.3-${sha}`,
  );
  assert.equal(parsed.registry, 'registry.fictional-registry.invalid:5000');
  assert.equal(parsed.path, 'acme/example-api');
  assert.equal(parsed.name, 'example-api');
  assert.equal(parsed.commit, sha);
});

test('образ без реестра не теряет организацию', () => {
  const parsed = parseImageReference('acme/example-api:1.0.0');
  assert.equal(parsed.registry, null);
  assert.equal(parsed.path, 'acme/example-api');
  assert.equal(parsed.name, 'example-api');
});

test('первый сегмент без точки и порта реестром не считается', () => {
  const parsed = parseImageReference('example-api:1.0.0');
  assert.equal(parsed.registry, null);
  assert.equal(parsed.path, 'example-api');
});

test('отсутствие каталогов репозиториев — честный неполный ответ', async () => {
  const response = await runImage('default', [], `example-api:1.0.0-${'a'.repeat(40)}`);
  assert.equal(response.ok, true);
  assert.equal(response.incomplete, true);
  assert.match((response.summary as { reason: string }).reason, /не найден/);
});

test('каталог без репозитория не считается репозиторием', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-repo-'));
  mkdirSync(join(dir, 'example-api'));
  try {
    const response = await runImage('default', [dir], `example-api:1.0.0-${'a'.repeat(40)}`);
    assert.equal(response.ok, true);
    assert.equal((response.summary as { resolved: boolean }).resolved, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
