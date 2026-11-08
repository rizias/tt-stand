import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../errors.ts';
import { withFileLock, withFileLockAsync } from '../lock.ts';
import { installSkills, maybeRefreshSkills } from './updater.ts';
import type { Ask, ChosenTarget, InstallReport, TargetOption } from './updaterState.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const INIT_TOOLS = ['claude', 'agents'] as const;
export type InitTool = (typeof INIT_TOOLS)[number];

export function packageMeta(): { name: string; version: string } {
  return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
}

export function stateDir(): string {
  return path.join(os.homedir(), '.tt-stand');
}

export function templatesDir(): string {
  return path.join(packageRoot, 'skills');
}

export interface Terminal {
  question(prompt: string): Promise<string>;
  close(): void;
}

function createTerminal(): Terminal {
  const reader = readline.createInterface({ input: process.stdin, output: process.stderr });
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  reader.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  reader.on('close', () => {
    while (waiters.length > 0) waiters.shift()?.('');
  });
  return {
    question(prompt: string): Promise<string> {
      process.stderr.write(prompt);
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      reader.close();
    },
  };
}

function writeTargets(options: TargetOption[], projectDir: string, skills: string[]): void {
  const labels = {
    global: 'глобально',
    project: 'этот проект',
    custom: 'путь, который введёте',
  };
  const targets = options.map((option, index) => {
    const roots = option.roots.length > 0 ? ` -> ${option.roots.join(', ')}` : '';
    return `  ${index + 1}. ${labels[option.id]}${roots}`;
  });
  process.stderr.write(
    [
      `Проект: ${path.resolve(projectDir)}`,
      '',
      `Скиллы к установке: ${skills.join(', ')}`,
      'Куда ставить скилл?',
      ...targets,
      '',
    ].join('\n'),
  );
}

export function createAsk(terminal: Terminal, projectDir: string, tools?: readonly InitTool[]): Ask {
  let confirmationPending = true;
  return {
    async chooseTargets({ skills, options }) {
      if (tools !== undefined) {
        return tools.map((tool) => ({
          id: 'custom',
          root: path.join(path.resolve(projectDir), `.${tool}`, 'skills'),
        }));
      }
      const choices = options.flatMap((option) => {
        if (option.id === 'custom') return [option];
        return option.roots.map((root) => ({ ...option, roots: [root] }));
      });
      writeTargets(choices, projectDir, skills);
      const picked = await terminal.question('Номер каталога (несколько через запятую, пусто для отмены): ');
      const chosen: ChosenTarget[] = [];
      for (const part of picked
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        const option = choices[Number(part) - 1];
        if (option === undefined) continue;
        if (option.id === 'custom') {
          const root = (await terminal.question('Путь: ')).trim();
          if (root !== '') chosen.push({ id: 'custom', root });
        } else {
          chosen.push({ id: 'custom', root: option.roots[0]! });
        }
      }
      return chosen;
    },

    async confirm({ message, paths }) {
      if (!confirmationPending) return false;
      confirmationPending = false;
      if (tools !== undefined) return true;
      for (const target of paths) process.stderr.write(`  ${target}\n`);
      const answer = await terminal.question(`${message} [y/N]: `);
      return answer.trim().toLowerCase() === 'y';
    },
  };
}

export async function runInit(projectDir: string, tools?: readonly InitTool[]): Promise<InstallReport> {
  if (tools === undefined && !process.stdin.isTTY) {
    throw new ToolError(
      'bad_request',
      'Ввод не терминал. Выберите назначение флагом --for agents для Codex или --for claude для Claude Code.',
    );
  }
  await keepInstalledSkillsFresh();
  const meta = packageMeta();
  const terminal = createTerminal();
  try {
    return await withFileLockAsync(path.join(stateDir(), 'skills-registry.json.lock'), () =>
      installSkills({
        pkgName: meta.name,
        version: meta.version,
        templates: templatesDir(),
        stateDir: stateDir(),
        ask: createAsk(terminal, projectDir, tools),
        projectDir,
      }),
    );
  } finally {
    terminal.close();
  }
}

export async function keepInstalledSkillsFresh(): Promise<void> {
  try {
    if (process.stdout.isTTY && !process.env.CI && process.env.NO_UPDATE_NOTIFIER === undefined) {
      const { default: updateNotifier } = await import('update-notifier');
      updateNotifier({ pkg: packageMeta(), updateCheckInterval: 1000 * 60 * 60 * 24 }).notify();
    }
    const registryFile = path.join(stateDir(), 'skills-registry.json');
    if (!existsSync(registryFile)) return;
    const meta = packageMeta();
    withFileLock(`${registryFile}.lock`, () =>
      maybeRefreshSkills({
        pkgName: meta.name,
        version: meta.version,
        templates: templatesDir(),
        stateDir: stateDir(),
      }),
    );
  } catch {
    return;
  }
}
