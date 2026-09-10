import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { homeEnv, tt } from './ttRunner.ts';

function installation(): string {
  const home = mkdtempSync(join(tmpdir(), 'tt-stand-flag-forms-'));
  const root = join(home, '.tt-stand');
  for (const name of ['первый', 'второй']) {
    mkdirSync(join(root, 'profiles', name), { recursive: true });
    writeFileSync(join(root, 'profiles', name, 'profile.json'), '{}');
  }
  writeFileSync(join(root, 'config.json'), JSON.stringify({ defaultProfile: 'первый' }));
  return home;
}

function journalEntries(home: string, profile: string): string[] {
  const directory = join(home, '.tt-stand', 'profiles', profile, 'journal');
  return existsSync(directory) ? readdirSync(directory) : [];
}

test('профиль через знак равенства кладёт журнал в каталог этого профиля', async () => {
  const home = installation();
  try {
    const outcome = await tt(['config', 'profiles', '--profile=второй'], homeEnv(home));
    assert.equal(outcome.code, 0);
    assert.equal(journalEntries(home, 'второй').length, 1);
    assert.equal(journalEntries(home, 'первый').length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('профиль через пробел кладёт журнал туда же, куда и через знак равенства', async () => {
  const home = installation();
  try {
    const outcome = await tt(['config', 'profiles', '--profile', 'второй'], homeEnv(home));
    assert.equal(outcome.code, 0);
    assert.equal(journalEntries(home, 'второй').length, 1);
    assert.equal(journalEntries(home, 'первый').length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('путь настроек через знак равенства определяет тот же профиль', async () => {
  const home = installation();
  const configPath = join(home, '.tt-stand', 'config.json');
  try {
    const outcome = await tt(
      ['config', 'profiles', `--config=${configPath}`, '--profile=второй'],
      homeEnv(mkdtempSync(join(tmpdir(), 'tt-stand-other-home-'))),
    );
    assert.equal(outcome.code, 0);
    assert.equal(journalEntries(home, 'второй').length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
