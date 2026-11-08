import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'vitest';
import { homeEnv, root, tt as run } from './ttRunner.ts';

const packageSkill = join(root, 'skills', 'tt-stand', 'SKILL.md');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const { name: packageName, version } = manifest;

const tt = (args: string[], home: string) => run(args, homeEnv(home));

function seedInstalledSkill(home: string, project: string): string {
  const destination = join(project, '.claude', 'skills', 'tt-stand');
  mkdirSync(destination, { recursive: true });
  const copy = join(destination, 'SKILL.md');
  const stale = readFileSync(packageSkill, 'utf8').replace(
    /tt-stand-skill-version: [^\n]+/,
    'tt-stand-skill-version: 0.0.0',
  );
  writeFileSync(copy, stale, 'utf8');
  const installed = [{ path: destination.replace(/\\/g, '/'), files: ['SKILL.md'] }];
  const registry = { version: '0.0.0', skills: { 'tt-stand': installed } };
  mkdirSync(join(home, '.tt-stand'), { recursive: true });
  writeFileSync(join(home, '.tt-stand', 'skills-registry.json'), JSON.stringify({ [packageName]: registry }));
  return copy;
}

const hashFile = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function verifySkillCopy(destination: string): void {
  const template = join(root, 'skills', 'tt-stand');
  const files = [
    'SKILL.md',
    ...readdirSync(join(template, 'references'), { recursive: true })
      .filter((name) => statSync(join(template, 'references', String(name))).isFile())
      .map((name) => `references/${String(name).replaceAll('\\', '/')}`),
  ];
  for (const relative of files) {
    const file = join(destination, relative);
    assert.equal(hashFile(file), hashFile(join(template, relative)), relative);
    for (const match of readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1] as string;
      if (/^(?:https?:|#)/u.test(target)) continue;
      assert.equal(existsSync(resolve(dirname(file), target)), true, `${relative}: ${target}`);
    }
  }
}

function treeSnapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), relative);
      else lines.push(`${relative} ${hashFile(join(current, entry.name))}`);
    }
  };
  walk(dir, '');
  return lines.join('\n');
}

let sandbox: string;
let home: string;
let project: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tt-stand-init-'));
  home = join(sandbox, 'home');
  project = join(sandbox, 'project');
  mkdirSync(home);
  mkdirSync(project);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('init --for claude кладёт скилл только в каталог claude и пишет реестр', async () => {
  const result = await tt(['init', project, '--for', 'claude'], home);
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout) as {
    ok: boolean;
    command: string;
    data: { installed: string[]; skipped: unknown[] };
  };
  assert.equal(response.ok, true);
  assert.equal(response.command, 'init');
  assert.deepEqual(response.data.installed, [join(project, '.claude', 'skills', 'tt-stand').replace(/\\/g, '/')]);
  assert.equal(existsSync(join(project, '.claude', 'skills', 'tt-stand', 'SKILL.md')), true);
  assert.equal(existsSync(join(project, '.agents', 'skills', 'tt-stand', 'SKILL.md')), false);
  verifySkillCopy(join(project, '.claude', 'skills', 'tt-stand'));
  const registry = JSON.parse(readFileSync(join(home, '.tt-stand', 'skills-registry.json'), 'utf8'));
  assert.equal(registry[packageName].version, version);
});

test('init без флага и без терминала отвечает bad_request и не меняет ни одного файла', async () => {
  const copy = seedInstalledSkill(home, project);
  const registryBefore = readFileSync(join(home, '.tt-stand', 'skills-registry.json'), 'utf8');
  const projectBefore = treeSnapshot(project);
  const result = await tt(['init', project], home);
  assert.equal(result.code, 1);
  const response = JSON.parse(result.stdout) as { errorClass: string; error: string };
  assert.equal(response.errorClass, 'bad_request');
  assert.match(response.error, /--for/);
  assert.equal(treeSnapshot(project), projectBefore);
  assert.equal(readFileSync(join(home, '.tt-stand', 'skills-registry.json'), 'utf8'), registryBefore);
  assert.notEqual(readFileSync(copy, 'utf8'), readFileSync(packageSkill, 'utf8'));
});

test('init с флагом синхронизирует старую копию в другом проекте', async () => {
  const staleProject = join(sandbox, 'stale');
  mkdirSync(staleProject);
  const staleCopy = seedInstalledSkill(home, staleProject);
  const result = await tt(['init', project, '--for', 'agents'], home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(staleCopy, 'utf8'), readFileSync(packageSkill, 'utf8'));
});

test('обычная команда синхронизирует старую копию с файлом пакета', async () => {
  const copy = seedInstalledSkill(home, project);
  const note = join(dirname(copy), 'local.md');
  writeFileSync(note, 'Локальные правила пользователя', 'utf8');
  const result = await tt(['--help'], home);
  assert.equal(result.code, 0, result.stderr);
  verifySkillCopy(dirname(copy));
  assert.equal(readFileSync(note, 'utf8'), 'Локальные правила пользователя');
});

test('init с неизвестным инструментом отвечает bad_request', async () => {
  const result = await tt(['init', project, '--for', 'vim'], home);
  assert.equal(result.code, 1);
  const response = JSON.parse(result.stdout) as { errorClass: string; error: string };
  assert.equal(response.errorClass, 'bad_request');
  assert.match(response.error, /vim/);
  assert.equal(existsSync(join(project, '.vim')), false);
});

test('параллельные init сохраняют обе установки в одном реестре', async () => {
  const otherProject = join(sandbox, 'other-project');
  mkdirSync(otherProject);
  const projects = [project, otherProject];
  const results = await Promise.all(projects.map((dir) => tt(['init', dir, '--for', 'claude'], home)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const registry = JSON.parse(readFileSync(join(home, '.tt-stand', 'skills-registry.json'), 'utf8'));
  const copies = registry[packageName].skills['tt-stand'] as { path: string }[];
  assert.deepEqual(
    copies.map((copy) => copy.path).sort(),
    projects.map((dir) => join(dir, '.claude', 'skills', 'tt-stand').replaceAll('\\', '/')).sort(),
  );
  for (const dir of projects) verifySkillCopy(join(dir, '.claude', 'skills', 'tt-stand'));
  assert.equal(existsSync(join(home, '.tt-stand', 'skills-registry.json.lock')), false);
});

test.each([
  ['1', '.claude', 'home'],
  ['2', '.codex', 'home'],
  ['3', '.agents', 'home'],
  ['4', '.claude', 'project'],
  ['5', '.agents', 'project'],
])('интерактивный init по номеру %s устанавливает только %s в %s', async (choice, directory, scope) => {
  const runCli = promisify(execFile);
  const execution = runCli(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'Object.defineProperty(process.stdin, "isTTY", { value: true }); await import(process.argv[1]);',
      pathToFileURL(join(root, 'src', 'cli.ts')).href,
      'init',
      project,
    ],
    { env: { ...process.env, ...homeEnv(home) } },
  );
  execution.child.stdin?.end(`${choice}\ny\n`);
  const { stdout, stderr } = await execution;
  const response = JSON.parse(stdout);
  const destination = join(scope === 'home' ? home : project, directory, 'skills', 'tt-stand');
  assert.equal(response.ok, true, stderr);
  assert.deepEqual(response.data.installed, [destination.replaceAll('\\', '/')]);
  verifySkillCopy(destination);
  for (const base of [home, project]) {
    for (const other of ['.claude', '.codex', '.agents']) {
      const candidate = join(base, other, 'skills', 'tt-stand');
      if (candidate !== destination) assert.equal(existsSync(candidate), false);
    }
  }
});

test('init с флагом сохраняет пользовательский файл и сообщает о пропущенной копии', async () => {
  const destination = join(project, '.claude', 'skills', 'tt-stand');
  mkdirSync(destination, { recursive: true });
  const ownSkill = 'Правила пользователя\n';
  writeFileSync(join(destination, 'SKILL.md'), ownSkill);
  const result = await tt(['init', project, '--for', 'claude'], home);
  assert.equal(result.code, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.errorClass, 'skill_copy_skipped');
  assert.equal(response.data.skipped[0].reason, 'foreign-files');
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), ownSkill);
  assert.equal(existsSync(join(home, '.tt-stand', 'skills-registry.json.lock')), false);
});
