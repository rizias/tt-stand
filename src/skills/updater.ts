import fs from 'node:fs';
import path from 'node:path';
import {
  collisions,
  type Job,
  listFiles,
  placeSkill,
  planJobs,
  resolveTemplate,
  scanSkills,
  stampOf,
} from './updaterFiles.ts';
import {
  basesFor,
  conflictMessage,
  DAY_MS,
  findPathKey,
  type InstalledCopy,
  type InstallOptions,
  type InstallReport,
  isSafeRelative,
  kindOfBase,
  note,
  type RefreshOptions,
  type RefreshReport,
  type Registry,
  type RegistryEntry,
  readRegistry,
  recordedFiles,
  recordInstall,
  type SkippedPath,
  targetOptions,
  writeRegistry,
} from './updaterState.ts';

const installJob = async (
  options: InstallOptions,
  job: Job,
  registry: Registry,
  report: InstallReport,
): Promise<void> => {
  const template = resolveTemplate(options.templates, job.kind, job.skill);
  if (template === undefined) {
    report.skipped.push({ path: job.dest, reason: 'failed' });
    note(false, `${options.pkgName}: no template for ${job.skill} — skipped ${job.dest}`);
    return;
  }
  try {
    const recorded = recordedFiles(registry, options.pkgName, job.skill, job.dest).filter(
      isSafeRelative,
    );
    const clash = collisions(job.dest, template, recorded);
    if (clash.length > 0) {
      const approved = await options.ask.confirm({
        message: `${job.dest}: installing would overwrite files this package did not place (${clash.join(', ')}) — overwrite?`,
        paths: [job.dest],
      });
      if (!approved) {
        report.skipped.push({
          path: job.dest,
          reason: 'foreign-files',
          files: clash,
          message: conflictMessage(options.pkgName, job.dest, clash),
        });
        return;
      }
    }
    const shipped = listFiles(template);
    const claimed = [...new Set([...recorded, ...clash, ...shipped])];
    recordInstall(registry, options.pkgName, options.version, job.skill, job.dest, claimed);
    writeRegistry(options.stateDir, registry);
    placeSkill(template, job.dest, claimed);
    recordInstall(registry, options.pkgName, options.version, job.skill, job.dest, shipped);
    writeRegistry(options.stateDir, registry);
    report.installed.push(job.dest);
  } catch {
    report.skipped.push({ path: job.dest, reason: 'failed' });
    note(false, `${options.pkgName}: could not install ${job.dest}`);
  }
};

export const installSkills = async (options: InstallOptions): Promise<InstallReport> => {
  const { removed: pruned } = pruneRegistry({
    pkgName: options.pkgName,
    stateDir: options.stateDir,
  });
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const skills = scanSkills(options.templates);
  const report: InstallReport = { skills, installed: [], skipped: [], pruned };
  if (skills.length === 0) return report;

  const chosen = await options.ask.chooseTargets({ skills, options: targetOptions(projectDir) });
  const { jobs, duplicates } = planJobs(
    options.templates,
    chosen.flatMap((choice) => basesFor(choice, projectDir)),
    skills,
  );
  if (jobs.length === 0) return report;

  const message = `install ${new Set(jobs.map((job) => job.skill)).size} skill(s) into ${jobs.length} path(s)`;
  const approved = await options.ask.confirm({ message, paths: jobs.map((job) => job.dest) });
  if (!approved) return report;

  for (const job of duplicates) {
    report.skipped.push({
      path: job.dest,
      reason: 'failed',
      message: `${options.pkgName}: skill ${job.skill} was skipped — its destination collides with another skill on this filesystem. Report this to the user.`,
    });
    note(
      false,
      `${options.pkgName}: duplicate destination for skill ${job.skill} — skipped ${job.dest}`,
    );
  }
  const registry = readRegistry(options.stateDir);
  for (const job of jobs) {
    await installJob(options, job, registry, report);
  }
  return report;
};

const refreshOne = (
  options: RefreshOptions,
  registry: Registry,
  skill: string,
  copy: InstalledCopy,
): {
  outcome: 'foreign-files' | 'unavailable' | 'failed' | 'refreshed' | 'current';
  clash?: string[];
} => {
  const template = resolveTemplate(options.templates, kindOfBase(path.dirname(copy.path)), skill);
  if (template === undefined) return { outcome: 'failed' };
  if (!fs.existsSync(path.dirname(copy.path))) return { outcome: 'unavailable' };
  if (stampOf(copy.path, skill) === stampOf(template, skill)) return { outcome: 'current' };
  const recorded = copy.files.filter(isSafeRelative);
  const clash = collisions(copy.path, template, recorded);
  if (clash.length > 0) {
    note(
      options.quiet,
      `${options.pkgName}: ${copy.path} update would overwrite files this package did not place (${clash.join(', ')}) — skipped`,
    );
    return { outcome: 'foreign-files', clash };
  }
  try {
    const shipped = listFiles(template);
    copy.files = [...new Set([...recorded, ...shipped])].sort();
    writeRegistry(options.stateDir, registry);
    placeSkill(template, copy.path, copy.files);
    copy.files = shipped;
    writeRegistry(options.stateDir, registry);
    return { outcome: 'refreshed' };
  } catch {
    return { outcome: 'failed' };
  }
};

const announceUnavailable = (
  options: RefreshOptions,
  dest: string,
  seen: Record<string, number>,
): boolean => {
  if (options.quiet === true) return false;
  const key = findPathKey(seen, dest);
  if (Date.now() - (key === undefined ? 0 : (seen[key] ?? 0)) <= DAY_MS) return false;
  note(false, `${options.pkgName}: path unavailable, skipped: ${dest}`);
  seen[key ?? dest] = Date.now();
  return true;
};

const refreshEntry = (
  options: RefreshOptions,
  registry: Registry,
  entry: RegistryEntry,
  report: RefreshReport,
): { announced: boolean; seen: Record<string, number> } => {
  const seen = { ...entry.unavailable };
  let announced = false;
  for (const [skill, copies] of Object.entries(entry.skills)) {
    for (const copy of copies) {
      const { outcome, clash } = refreshOne(options, registry, skill, copy);
      if (outcome === 'current') continue;
      if (outcome === 'refreshed') {
        report.refreshed.push(copy.path);
        continue;
      }
      const skipped: SkippedPath = { path: copy.path, reason: outcome };
      if (clash !== undefined) {
        skipped.files = clash;
        skipped.message = conflictMessage(options.pkgName, copy.path, clash);
      }
      report.skipped.push(skipped);
      if (outcome === 'failed')
        note(options.quiet, `${options.pkgName}: could not refresh ${copy.path}`);
      if (outcome === 'unavailable')
        announced = announceUnavailable(options, copy.path, seen) || announced;
    }
  }
  return { announced, seen };
};

export const maybeRefreshSkills = (options: RefreshOptions): RefreshReport => {
  const report: RefreshReport = { refreshed: [], skipped: [] };
  try {
    const registry = readRegistry(options.stateDir);
    const entry = registry[options.pkgName];
    if (entry === undefined) return report;

    const versionChanged = entry.version !== options.version;
    entry.version = options.version;
    const { announced, seen } = refreshEntry(options, registry, entry, report);
    if (announced) {
      entry.unavailable = seen;
      writeRegistry(options.stateDir, registry);
    }
    if (versionChanged && report.refreshed.length === 0) writeRegistry(options.stateDir, registry);
    if (report.refreshed.length > 0) {
      note(
        options.quiet,
        `${options.pkgName}: refreshed ${report.refreshed.length} skill(s) (${options.version})`,
      );
    }
  } catch {
    return report;
  }
  return report;
};

export const pruneRegistry = (options: {
  pkgName: string;
  stateDir: string;
}): { removed: string[] } => {
  const registry = readRegistry(options.stateDir);
  const entry = registry[options.pkgName];
  const removed: string[] = [];
  if (entry === undefined) return { removed };
  for (const [skill, copies] of Object.entries(entry.skills)) {
    const kept = copies.filter((copy) => {
      if (fs.existsSync(path.dirname(copy.path))) return true;
      removed.push(copy.path);
      return false;
    });
    if (kept.length > 0) entry.skills[skill] = kept;
    else delete entry.skills[skill];
  }
  if (entry.unavailable !== undefined) {
    for (const dest of removed) {
      const key = findPathKey(entry.unavailable, dest);
      if (key !== undefined) delete entry.unavailable[key];
    }
    if (Object.keys(entry.unavailable).length === 0) delete entry.unavailable;
  }
  if (removed.length > 0) writeRegistry(options.stateDir, registry);
  return { removed };
};
