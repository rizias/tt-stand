import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageMeta, stateDir } from '../skills/setup.ts';
import { readRegistry } from '../skills/updaterState.ts';

interface NpmOutcome {
  exitCode: number;
  stdout: string;
  launchError: string | null;
}

const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npm(args: string[]): NpmOutcome {
  const result = spawnSync(npmBinary, args, {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    windowsHide: false,
    shell: process.platform === 'win32',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    launchError: result.error?.message ?? null,
  };
}

function fail(step: string, outcome: NpmOutcome): number {
  if (outcome.stdout.trim() !== '') process.stderr.write(outcome.stdout);
  const reason =
    outcome.launchError === null
      ? `npm завершился кодом ${outcome.exitCode}`
      : `npm не запущен: ${outcome.launchError}`;
  process.stderr.write(`tt-stand: обновление не выполнено (${step}), ${reason}\n`);
  return outcome.launchError === null ? outcome.exitCode : 1;
}

function latestVersion(name: string): { version: string } | { failure: number } {
  const outcome = npm(['view', `${name}@latest`, 'version', '--json']);
  if (outcome.exitCode !== 0 || outcome.launchError !== null) {
    return { failure: fail('версия в реестре', outcome) };
  }
  try {
    const parsed = JSON.parse(outcome.stdout) as unknown;
    if (typeof parsed === 'string' && parsed !== '') return { version: parsed };
  } catch {
    return { failure: fail('версия в реестре', { ...outcome, exitCode: 1 }) };
  }
  return { failure: fail('версия в реестре', { ...outcome, exitCode: 1 }) };
}

function installedPackageDir(name: string): { dir: string } | { failure: number } {
  const root = npm(['root', '-g']);
  if (root.exitCode !== 0 || root.launchError !== null) {
    return { failure: fail('каталог глобальных пакетов', root) };
  }
  const dir = join(root.stdout.trim(), ...name.split('/'));
  if (existsSync(join(dir, 'package.json'))) return { dir };
  process.stderr.write(`tt-stand: обновление не выполнено (пакет не найден в ${dir})\n`);
  return { failure: 1 };
}

function installedVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

function skillCopiesState(dir: string, name: string, version: string): string {
  const launched = spawnSync(process.execPath, [join(dir, 'dist', 'cli.js'), '--help'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const entry = readRegistry(stateDir())[name];
  if (entry === undefined) return 'копий скилла в проектах нет';
  if (launched.status === 0 && entry.version === version) return 'копии скилла обновлены';
  return 'копии скилла не обновлены, обновятся при следующем запуске любой команды';
}

export function runUpdateCommand(): number {
  const meta = packageMeta();
  const latest = latestVersion(meta.name);
  if ('failure' in latest) return latest.failure;
  if (latest.version === meta.version) {
    process.stdout.write(`tt-stand: уже последняя версия ${meta.version}\n`);
    return 0;
  }
  const install = npm(['i', '-g', `${meta.name}@latest`]);
  if (install.exitCode !== 0 || install.launchError !== null) {
    return fail('установка', install);
  }
  const located = installedPackageDir(meta.name);
  if ('failure' in located) return located.failure;
  const installed = installedVersion(located.dir);
  if (installed === null) {
    process.stderr.write(`tt-stand: обновление не выполнено (манифест в ${located.dir} не прочитан)\n`);
    return 1;
  }
  const copies = skillCopiesState(located.dir, meta.name, installed);
  process.stdout.write(`tt-stand: ${meta.version} → ${installed}, ${copies}\n`);
  return 0;
}
