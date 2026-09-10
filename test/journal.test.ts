import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProfile } from '../src/profile.ts';
import {
  currentOrigin,
  type JournalOrigin,
  RUN_VARIABLE,
  writeJournalEntry,
} from '../src/journal.ts';
import type { ToolResponse } from '../src/response.ts';

function response(ok: boolean): ToolResponse {
  return {
    ok,
    command: 'token',
    data: { value: 'как есть' },
    summary: null,
    echo: { command: 'token' } as unknown as ToolResponse['echo'],
    incomplete: false,
    incompleteReasons: [],
    errorClass: ok ? null : 'bad_request',
    error: ok ? null : 'отказ',
  };
}

function origin(pid: number, run: string | null): JournalOrigin {
  return { pid, parentPid: 1, run };
}

test('каждый вызов получает свой файл, имена идут по времени', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    const directory = join(dir, 'журнал');
    writeJournalEntry(
      directory,
      ['token'],
      response(true),
      '2026-08-31T00:00:01.000Z',
      origin(1, null),
    );
    writeJournalEntry(
      directory,
      ['k8s', 'pods'],
      response(false),
      '2026-08-31T00:00:00.000Z',
      origin(2, null),
    );

    const files = readdirSync(directory).sort();
    assert.equal(files.length, 2);
    const first = JSON.parse(readFileSync(join(directory, files[0] as string), 'utf8'));
    assert.deepEqual(first.invocation, ['k8s', 'pods']);
    assert.equal(first.response.errorClass, 'bad_request');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('одновременные вызовы не пишут в один файл', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    const at = '2026-08-31T00:00:00.000Z';
    for (const pid of [11, 12, 13, 14]) {
      const outcome = writeJournalEntry(dir, ['token'], response(true), at, origin(pid, null));
      assert.equal(outcome.failure, null);
    }
    const files = readdirSync(dir);
    assert.equal(files.length, 4);
    for (const file of files) JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('метки происхождения попадают в запись', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    writeJournalEntry(
      dir,
      ['token'],
      response(true),
      '2026-08-31T00:00:00.000Z',
      origin(7, 'разбор-1'),
    );
    const entry = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8'));
    assert.equal(entry.origin.run, 'разбор-1');
    assert.equal(entry.origin.pid, 7);
    assert.equal(entry.origin.parentPid, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('метка берётся из переменной окружения, а без неё отсутствует', () => {
  assert.equal(currentOrigin({ [RUN_VARIABLE]: 'разбор-2' }).run, 'разбор-2');
  assert.equal(currentOrigin({}).run, null);
  assert.equal(currentOrigin({ [RUN_VARIABLE]: '' }).run, null);
});

test('ответ в записи не сокращается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    writeJournalEntry(dir, ['token'], response(true), '2026-08-31T00:00:00.000Z', origin(3, null));
    const entry = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8'));
    assert.deepEqual(entry.response.data, { value: 'как есть' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('недоступный каталог называет причину и не бросает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    const occupied = join(dir, 'занято');
    writeFileSync(occupied, 'не каталог');
    const outcome = writeJournalEntry(
      occupied,
      ['token'],
      response(true),
      '2026-08-31T00:00:00.000Z',
      origin(4, null),
    );
    assert.ok(outcome.failure);
    assert.match(outcome.failure as string, /не создана/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('журналы разных профилей не попадают в один каталог', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    const first = parseProfile(
      {},
      'первый',
      join(dir, 'profiles', 'первый', 'profile.json'),
      join(dir, 'profiles', 'первый', 'credentials.json'),
    );
    const second = parseProfile(
      {},
      'второй',
      join(dir, 'profiles', 'второй', 'profile.json'),
      join(dir, 'profiles', 'второй', 'credentials.json'),
    );
    assert.notEqual(first.journalDirectory, second.journalDirectory);
    assert.equal(first.journalDirectory, join(dir, 'profiles', 'первый', 'journal'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('имя действующего профиля называется рядом с происхождением вызова', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    writeJournalEntry(
      dir,
      ['logs', 'query'],
      response(true),
      '2026-08-31T00:00:00.000Z',
      origin(5, null),
      'stand-a',
    );
    const entry = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8'));
    assert.equal(entry.profile, 'stand-a');
    assert.equal(entry.origin.pid, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('вызовы разных профилей лежат в одном общем каталоге журнала', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    writeJournalEntry(
      dir,
      ['logs', 'query'],
      response(true),
      '2026-08-31T00:00:00.000Z',
      origin(1, 'разбор'),
      'stand-a',
    );
    writeJournalEntry(
      dir,
      ['k8s', 'pods'],
      response(true),
      '2026-08-31T00:00:01.000Z',
      origin(2, 'разбор'),
      'stand-b',
    );
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2);
    const profiles = files.map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')).profile);
    assert.deepEqual(profiles, ['stand-a', 'stand-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('без указания профиля запись остаётся корректной', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-stand-journal-'));
  try {
    writeJournalEntry(dir, ['token'], response(true), '2026-08-31T00:00:00.000Z', origin(6, null));
    const entry = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8'));
    assert.equal(entry.profile, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
