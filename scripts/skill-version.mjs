import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function resolveVersion() {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version;
  } catch {
    return undefined;
  }
}

function fail(reason) {
  console.error(`skill-version: ${reason} — версия скилла не обновлена`);
  process.exit(1);
}

function hasSkillDoc(dir) {
  try {
    return statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function discoverSkillFile() {
  let entries;
  try {
    entries = readdirSync('skills', { withFileTypes: true });
  } catch {
    fail('каталог skills не найден');
  }
  const names = entries.filter((entry) => entry.isDirectory() && hasSkillDoc(path.join('skills', entry.name))).map((entry) => entry.name);
  if (names.length !== 1) {
    fail(`в каталоге skills ожидается один скилл, найдено ${names.length}${names.length > 0 ? ` (${names.join(', ')})` : ''}`);
  }
  return path.join('skills', names[0], 'SKILL.md');
}

const version = resolveVersion();
if (!version) {
  fail('версия не определена');
}

const file = process.env.SKILL_FILE ?? discoverSkillFile();
const skill = path.basename(path.dirname(path.resolve(file)));
let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  fail(`файл ${file} не найден`);
}

const line = new RegExp(`^${skill.replace(/[.*+?^${}()|[\]\\]/g, '\$&')}-skill-version: .*$`, 'm');
if (!line.test(text)) {
  fail(`строка ${skill}-skill-version не найдена в ${file}`);
}

writeFileSync(file, text.replace(line, `${skill}-skill-version: ${version}`), 'utf8');
console.error(`skill-version: записана версия ${version} в ${file}`);

if (!process.env.SKILL_FILE) {
  try {
    execFileSync('git', ['add', file], { stdio: 'pipe' });
  } catch (error) {
    console.error(`skill-version: git add ${file} не выполнен (${error.message})`);
  }
}
