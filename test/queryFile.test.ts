import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readQueryFile, resolveQuery } from '../src/queryFile.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-query-file-'));
}

test('содержимое файла становится выражением дословно, включая переводы строк', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'query.logsql');
    writeFileSync(path, 'error\n| stats count()\n');
    assert.equal(readQueryFile(path), 'error\n| stats count()\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('специальные символы оболочки доходят без искажений', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'query.txt');
    const expression = 'upstream:"<a>|b&c^d%e" "кавычки \\"внутри\\""';
    writeFileSync(path, expression);
    assert.equal(readQueryFile(path), expression);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('метка порядка байтов UTF-8 отбрасывается, остальное не меняется', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'query-bom.txt');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(path, Buffer.concat([bom, Buffer.from('extract "<ip> ..."', 'utf8')]));
    assert.equal(readQueryFile(path), 'extract "<ip> ..."');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл не в кодировке UTF-8 — bad_request, символ замещения не подставляется', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'query-invalid-utf8.txt');
    writeFileSync(path, Buffer.from([0x65, 0x72, 0x72, 0x6f, 0x72, 0xff, 0xfe, 0x00]));
    assert.throws(
      () => readQueryFile(path),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'bad_request' &&
        error.message.includes(path) &&
        error.message.includes('не в кодировке UTF-8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файла нет — bad_request, текст называет путь', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'нет-такого.txt');
    assert.throws(
      () => readQueryFile(path),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'bad_request' && error.message.includes(path),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('заданы оба флага сразу — bad_request, текст называет путь файла', () => {
  assert.throws(
    () => resolveQuery('*', '/любой/путь'),
    (error: Error & { errorClass?: string; message: string }) =>
      error.errorClass === 'bad_request' && error.message.includes('путь'),
  );
});

test('ни один флаг не задан — query остаётся null', () => {
  const resolved = resolveQuery(undefined, undefined);
  assert.equal(resolved.query, null);
  assert.equal(resolved.queryFile, null);
});

test('только --query — запрос берётся из значения флага, queryFile null', () => {
  const resolved = resolveQuery('error', undefined);
  assert.equal(resolved.query, 'error');
  assert.equal(resolved.queryFile, null);
});

test('только --query-file — запрос берётся из файла, путь эха — как передан пользователем', () => {
  const dir = workspace();
  try {
    const path = join(dir, 'query.txt');
    writeFileSync(path, 'error | stats count()');
    const resolved = resolveQuery(undefined, path);
    assert.equal(resolved.query, 'error | stats count()');
    assert.equal(resolved.queryFile, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G6: --query-file с ~/ — путь эха не нормализуется, остаётся в исходном виде', () => {
  const dir = workspace();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    writeFileSync(join(dir, 'q.promql'), 'up');
    const resolved = resolveQuery(undefined, '~/q.promql');
    assert.equal(resolved.query, 'up');
    assert.equal(resolved.queryFile, '~/q.promql');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G6: --query-file с ~/ — при отказе чтения путь эха тоже в исходном виде', () => {
  const dir = workspace();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    assert.throws(
      () => resolveQuery(undefined, '~/нет-такого.promql'),
      (error: Error & { errorClass?: string }) => error.errorClass === 'bad_request',
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(dir, { recursive: true, force: true });
  }
});
