import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Templates } from './updaterState.ts';
import { isSafeRelative, kindOfBase, pathKey, samePath, toSlash } from './updaterState.ts';

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?=\n|$)/;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stampKey = (skill: string): string => `${skill}-skill-version`;

const normalizeDoc = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const readStamp = (text: string, skill: string): string | undefined => {
  const block = FRONTMATTER.exec(normalizeDoc(text));
  if (block === null) return undefined;
  const line = new RegExp(
    `^\\s*${escapeRegExp(stampKey(skill))}:\\s*["']?([^"'\\n]+?)["']?\\s*$`,
    'm',
  ).exec(block[1] ?? '');
  return line?.[1]?.trim();
};

export const listFiles = (dir: string, prefix = ''): string[] => {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
};

const pruneEmptyDirs = (dest: string, relative: string): void => {
  let dir = path.dirname(path.join(dest, relative));
  const stop = path.resolve(dest);
  while (path.resolve(dir) !== stop) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
};

const assertNoLinkedParents = (dest: string, relative: string): void => {
  const parts = relative.split('/');
  let current = dest;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i] ?? '');
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`refusing to write through a link: ${current}`);
    }
  }
};

export const collisions = (
  dest: string,
  template: string,
  recorded: readonly string[],
): string[] => {
  if (!fs.existsSync(dest)) return [];
  const owned = new Set(recorded.map(pathKey));
  const shipped = new Set(listFiles(template).map(pathKey));
  return listFiles(dest).filter(
    (relative) => shipped.has(pathKey(relative)) && !owned.has(pathKey(relative)),
  );
};

const templateRoots = (templates: Templates): string[] => {
  if (typeof templates === 'string') return [templates];
  return [templates.common, templates.claude, templates.codex, templates.agents].filter(
    (root): root is string => root !== undefined,
  );
};

const hasSkillDoc = (dir: string): boolean =>
  fs.statSync(path.join(dir, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() === true;

export const resolveTemplate = (
  templates: Templates,
  kind: AgentKind,
  skill: string,
): string | undefined => {
  if (typeof templates === 'string') {
    const dir = path.join(templates, skill);
    return hasSkillDoc(dir) ? dir : undefined;
  }
  const roots = [templates[kind], templates.common].filter(
    (root): root is string => root !== undefined,
  );
  for (const root of roots) {
    const dir = path.join(root, skill);
    if (hasSkillDoc(dir)) return dir;
  }
  return undefined;
};

export const scanSkills = (templates: Templates): string[] => {
  const names = new Set<string>();
  for (const root of templateRoots(templates)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory() && hasSkillDoc(path.join(root, entry.name))) names.add(entry.name);
    }
  }
  return [...names].sort();
};

export const stampOf = (dir: string, skill: string): string | undefined => {
  try {
    return readStamp(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), skill);
  } catch {
    return undefined;
  }
};

export const placeSkill = (template: string, dest: string, recorded: readonly string[]): void => {
  if (samePath(toSlash(path.resolve(template)), toSlash(path.resolve(dest)))) {
    throw new Error(`template and destination are the same directory: ${dest}`);
  }
  if (!hasSkillDoc(template)) throw new Error(`template not found: ${template}`);
  fs.mkdirSync(dest, { recursive: true });
  const shipped = listFiles(template);
  const shippedKeys = new Set(shipped.map(pathKey));
  for (const relative of shipped) {
    if (relative === 'SKILL.md') continue;
    assertNoLinkedParents(dest, relative);
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(template, relative), target);
  }
  for (const relative of recorded) {
    if (!isSafeRelative(relative) || shippedKeys.has(pathKey(relative))) continue;
    try {
      assertNoLinkedParents(dest, relative);
      fs.rmSync(path.join(dest, relative), { force: true });
      pruneEmptyDirs(dest, relative);
    } catch {}
  }
  const staging = path.join(dest, `SKILL.md.${process.pid}.tmp`);
  fs.copyFileSync(path.join(template, 'SKILL.md'), staging);
  fs.renameSync(staging, path.join(dest, 'SKILL.md'));
};

export interface Job {
  skill: string;
  dest: string;
  kind: AgentKind;
}

export const planJobs = (
  templates: Templates,
  bases: string[],
  skills: string[],
): { jobs: Job[]; duplicates: Job[] } => {
  const jobs: Job[] = [];
  const duplicates: Job[] = [];
  for (const base of bases) {
    for (const skill of skills) {
      const kind = kindOfBase(base);
      if (resolveTemplate(templates, kind, skill) === undefined) continue;
      const dest = toSlash(path.join(base, skill));
      const job = { skill, dest, kind };
      const taken = jobs.find((other) => samePath(other.dest, dest));
      if (taken === undefined) jobs.push(job);
      else if (taken.skill !== skill) duplicates.push(job);
    }
  }
  return { jobs, duplicates };
};
