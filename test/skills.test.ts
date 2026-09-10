import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createAsk, type Terminal } from '../src/skills/setup.ts';
import { installSkills, maybeRefreshSkills } from '../src/skills/updater.ts';
import type { Ask, TargetOption } from '../src/skills/updaterState.ts';

let root: string;
let project: string;
let stateDir: string;
let templates: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tt-stand-skills-'));
  project = join(root, 'project');
  stateDir = join(root, 'state');
  templates = join(root, 'templates');
  mkdirSync(project);
  cpSync(join(import.meta.dirname, '..', 'skills'), templates, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const destination = () => join(project, '.claude', 'skills', 'tt-stand');
const slashDestination = () => destination().replace(/\\/g, '/');
const template = () => join(templates, 'tt-stand');
const registryFile = () => join(stateDir, 'skills-registry.json');
const readRegistry = () => JSON.parse(readFileSync(registryFile(), 'utf8'))['tt-stand'];

function ask(confirm = true): Ask {
  return {
    chooseTargets: async () => [{ id: 'custom', root: join(project, '.claude', 'skills') }],
    confirm: async () => confirm,
  };
}

function options(version: string, confirm = true) {
  return { pkgName: 'tt-stand', version, templates, stateDir, ask: ask(confirm), projectDir: project };
}

function refresh(version: string) {
  return maybeRefreshSkills({ pkgName: 'tt-stand', version, templates, stateDir });
}

function stubTerminal(answers: string[], prompts: string[]): Terminal {
  return {
    question: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? '';
    },
    close: () => undefined,
  };
}

function changeTemplateStamp(version: string): void {
  const file = join(template(), 'SKILL.md');
  const text = readFileSync(file, 'utf8').replace(
    /tt-stand-skill-version: [^\n]+/,
    `tt-stand-skill-version: ${version}`,
  );
  writeFileSync(file, text, 'utf8');
}

async function captureStderr<T>(action: () => Promise<T>): Promise<{ result: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await action(), text: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

test('мастерская пишет реестр и копию, равную шаблону, по указанному пути', async () => {
  const report = await installSkills(options('0.1.0'));
  assert.deepEqual(report.installed, [slashDestination()]);
  assert.equal(
    readFileSync(join(destination(), 'SKILL.md'), 'utf8'),
    readFileSync(join(template(), 'SKILL.md'), 'utf8'),
  );
  const registry = readRegistry();
  assert.equal(registry.version, '0.1.0');
  assert.deepEqual(registry.skills['tt-stand'][0], { path: slashDestination(), files: ['SKILL.md'] });
});

test('без подтверждения мастерская не создаёт копию и реестр', async () => {
  const report = await installSkills(options('0.1.0', false));
  assert.deepEqual(report.installed, []);
  assert.deepEqual(report.skipped, []);
  assert.equal(existsSync(destination()), false);
  assert.equal(existsSync(registryFile()), false);
});

test('обновление по новому штампу пропускает копию с чужим файлом, которого нет в шаблоне', async () => {
  await installSkills(options('0.1.0'));
  const foreign = join(destination(), 'new-file.txt');
  writeFileSync(foreign, 'чужой файл', 'utf8');
  writeFileSync(join(template(), 'new-file.txt'), 'файл пакета', 'utf8');
  changeTemplateStamp('0.2.0');

  const report = refresh('0.2.0');
  assert.deepEqual(report.refreshed, []);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0]?.path, slashDestination());
  assert.equal(report.skipped[0]?.reason, 'foreign-files');
  assert.equal(readFileSync(foreign, 'utf8'), 'чужой файл');
  assert.notEqual(
    readFileSync(join(destination(), 'SKILL.md'), 'utf8'),
    readFileSync(join(template(), 'SKILL.md'), 'utf8'),
  );
});

test('обновление по новому штампу переписывает копию, когда чужого файла нет', async () => {
  await installSkills(options('0.1.0'));
  changeTemplateStamp('0.2.0');
  const report = refresh('0.2.0');
  assert.deepEqual(report.refreshed, [slashDestination()]);
  assert.equal(
    readFileSync(join(destination(), 'SKILL.md'), 'utf8'),
    readFileSync(join(template(), 'SKILL.md'), 'utf8'),
  );
});

test('обновление сохраняет чужой файл, которого нет в шаблоне, и переписывает копию', async () => {
  await installSkills(options('0.1.0'));
  const foreign = join(destination(), 'user-file.txt');
  writeFileSync(foreign, 'чужой файл', 'utf8');
  changeTemplateStamp('0.2.0');

  const report = refresh('0.2.0');
  assert.deepEqual(report.refreshed, [slashDestination()]);
  assert.equal(
    readFileSync(join(destination(), 'SKILL.md'), 'utf8'),
    readFileSync(join(template(), 'SKILL.md'), 'utf8'),
  );
  assert.equal(readFileSync(foreign, 'utf8'), 'чужой файл');
});

test('диалог предлагает проект и свой путь, цели «глобально» нет', async () => {
  const prompts: string[] = [];
  const targetOptions: TargetOption[] = [
    { id: 'global', label: 'global', roots: ['/global'] },
    {
      id: 'project',
      label: 'project',
      roots: [join(project, '.claude', 'skills'), join(project, '.agents', 'skills')],
    },
    { id: 'custom', label: 'custom', roots: [] },
  ];
  const choose = (answers: string[]) =>
    createAsk(stubTerminal(answers, prompts), project).chooseTargets({
      skills: ['tt-stand'],
      options: targetOptions,
    });
  const customRoot = join(root, 'custom-skills');

  const { result, text } = await captureStderr(async () => ({
    first: await choose(['1']),
    second: await choose(['2', customRoot]),
    third: await choose(['']),
  }));
  assert.deepEqual(result.first, [{ id: 'project' }]);
  assert.deepEqual(result.second, [{ id: 'custom', root: customRoot }]);
  assert.deepEqual(result.third, []);
  const shown = `${prompts.join('\n')}\n${text}`;
  assert.doesNotMatch(shown, /global/i);
  assert.doesNotMatch(shown, /глобально/i);
  assert.ok(shown.includes(project));
  assert.ok(shown.includes(join(project, '.claude', 'skills')));
  assert.ok(shown.includes(join(project, '.agents', 'skills')));
});

test('подтверждение печатает каждый путь и принимает только y или Y', async () => {
  const dialog = createAsk(stubTerminal(['y', 'Y', 'n', 'yes'], []), project);
  const paths = [join(project, 'one'), join(project, 'two')];
  const { result, text } = await captureStderr(async () => [
    await dialog.confirm({ message: 'install?', paths }),
    await dialog.confirm({ message: 'install?', paths }),
    await dialog.confirm({ message: 'install?', paths }),
    await dialog.confirm({ message: 'install?', paths }),
  ]);
  assert.deepEqual(result, [true, true, false, false]);
  for (const target of paths) assert.ok(text.includes(target));
});

test('актуальная копия не переписывается', async () => {
  await installSkills(options('0.1.0'));
  const skillFile = join(destination(), 'SKILL.md');
  const oldTime = new Date('2020-01-02T03:04:05.000Z');
  utimesSync(skillFile, oldTime, oldTime);
  const before = statSync(skillFile).mtimeMs;
  const report = refresh('0.1.0');
  assert.deepEqual(report, { refreshed: [], skipped: [] });
  assert.equal(statSync(skillFile).mtimeMs, before);
});

test('init удаляет из реестра запись с исчезнувшим родительским каталогом и отдаёт её в pruned', async () => {
  await installSkills(options('0.1.0'));
  rmSync(join(project, '.claude', 'skills'), { recursive: true, force: true });
  const report = await installSkills({ ...options('0.1.0'), ask: ask(false) });
  assert.deepEqual(report.pruned, [slashDestination()]);
  assert.deepEqual(readRegistry().skills, {});
});

test('недоступный путь помечается в реестре и не печатается повторно в те же сутки', async () => {
  await installSkills(options('0.1.0'));
  rmSync(join(project, '.claude', 'skills'), { recursive: true, force: true });
  const { result, text } = await captureStderr(async () => [refresh('0.1.0'), refresh('0.1.0')]);
  const [first, second] = result;
  assert.equal(first?.skipped.length, 1);
  assert.equal(first?.skipped[0]?.path, slashDestination());
  assert.equal(first?.skipped[0]?.reason, 'unavailable');
  assert.deepEqual(second?.skipped, first?.skipped);
  assert.equal(text.split('path unavailable').length - 1, 1);
  assert.ok(Object.hasOwn(readRegistry().unavailable, slashDestination()));
});
