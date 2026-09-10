import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MARKERS = ['## [Не выпущено]', '## [Unreleased]'];

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
  console.error(`changelog-release: ${reason} — раздел не переносится`);
  process.exit(1);
}

const version = resolveVersion();
if (!version) {
  fail('версия не определена');
}

const file = process.env.CHANGELOG_FILE ?? 'CHANGELOG.md';
const date = new Date().toISOString().slice(0, 10);

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  fail(`файл ${file} не найден`);
}

const marker = MARKERS.find((candidate) => text.includes(candidate));
if (!marker) {
  fail(`заголовок ${MARKERS.map((candidate) => `"${candidate}"`).join(' или ')} не найден в ${file}`);
}

writeFileSync(file, text.replace(marker, `${marker}\n\n## [${version}] — ${date}`));
console.error(`changelog-release: раздел перенесён в [${version}] — ${date}`);

if (!process.env.CHANGELOG_FILE) {
  try {
    execFileSync('git', ['add', file], { stdio: 'pipe' });
  } catch (error) {
    console.error(`changelog-release: git add ${file} не выполнен (${error.message})`);
  }
}
