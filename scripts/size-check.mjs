import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const LIMITS = { '.ts': 300, '.tsx': 300, '.jsx': 300, '.mts': 300, '.cts': 300, '.js': 300, '.mjs': 300, '.cjs': 300, '.py': 300, '.go': 500, '.java': 500 };
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'release', 'build', 'out', 'target', 'vendor', '.git', '.npm-cache', 'openspec']);
const SKIP_NAME = [/\.generated\./, /[\\/]migrations[\\/]/, /[\\/]fixtures[\\/]/, /package-lock\.json$/, /\.d\.ts$/];
const BASELINE_PATH = join(process.cwd(), 'scripts', 'size-baseline.json');
const TEST_LIMIT = 500;
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
const TEST_NAME = [/\.(?:test|spec)\.[^.]+$/, /_test\.(?:go|py)$/, /^test_.*\.py$/, /Tests?\.java$/];

function ext(name) {
  const m = name.match(/\.[^.]+$/);
  return m ? m[0].toLowerCase() : '';
}

function countLines(text) {
  const breaks = text.match(/\r\n|[\n\r\u2028\u2029]/g)?.length ?? 0;
  return breaks + (text.match(/(?:^|\r\n|[\n\r\u2028\u2029])[^\r\n\u2028\u2029]+$/) ? 1 : 0);
}

function isTest(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  return parts.slice(0, -1).some((part) => TEST_DIRS.has(part)) || TEST_NAME.some((r) => r.test(name));
}

function limitFor(rel) {
  return isTest(rel) ? TEST_LIMIT : LIMITS[ext(rel)];
}

function limitSummary() {
  const groups = new Map();
  for (const [extension, limit] of Object.entries(LIMITS)) {
    const extensions = groups.get(limit) ?? [];
    extensions.push(extension);
    groups.set(limit, extensions);
  }
  return [...groups].map(([limit, extensions]) => `${limit} lines (${extensions.join(', ')})`).join(', ') + `, tests ${TEST_LIMIT} lines`;
}

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(p, acc);
    } else if (LIMITS[ext(name)] !== undefined && !SKIP_NAME.some((r) => r.test(p))) acc.push(p);
  }
}

const update = process.argv.includes('--update');
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
const files = [];
walk(process.cwd(), files);

const violations = [];
const nextBaseline = {};
let tightened = 0;
for (const f of files) {
  const rel = relative(process.cwd(), f).split(sep).join('/');
  const lines = countLines(readFileSync(f, 'utf8'));
  const limit = limitFor(rel);
  if (update) {
    if (lines > limit) nextBaseline[rel] = Math.min(lines, baseline[rel] ?? lines);
    continue;
  }
  const recorded = baseline[rel];
  if (recorded !== undefined && lines < recorded) {
    tightened += 1;
    if (lines > limit) baseline[rel] = lines;
    else delete baseline[rel];
  }
  const allowedLines = Math.max(limit, baseline[rel] ?? 0);
  if (lines > allowedLines) violations.push({ rel, lines, allowedLines });
}

if (update) {
  writeFileSync(BASELINE_PATH, JSON.stringify(nextBaseline, null, 2) + '\n');
  console.log(`size-check: baseline updated, ${Object.keys(nextBaseline).length} legacy file(s) frozen`);
  process.exit(0);
}

if (tightened > 0) {
  try {
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`size-check: ratchet tightened ${tightened} record(s)`);
  } catch {
    console.error(`size-check: cannot tighten baseline (read-only?), ${tightened} record(s) pending`);
  }
}

if (violations.length > 0) {
  for (const v of violations) console.log(`${v.rel}: ${v.lines} lines (allowed ${v.allowedLines})`);
  console.log(`size-check: split by responsibility; limits: ${limitSummary()}; legacy files in scripts/size-baseline.json may only shrink.`);
  process.exit(1);
}
console.log(`size-check: OK (${files.length} file(s), ${Object.keys(baseline).length} frozen legacy)`);
