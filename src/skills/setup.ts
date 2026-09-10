import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import updateNotifier from 'update-notifier';
import { ToolError } from '../errors.ts';
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
  const project = options.find((option) => option.id === 'project');
  const roots = project?.roots.join(', ') ?? '';
  process.stderr.write(
    [
      `Проект: ${path.resolve(projectDir)}`,
      '',
      `Скиллы к установке: ${skills.join(', ')}`,
      'Куда ставить скилл?',
      `  1. этот проект -> ${roots}`,
      '  2. путь, который введёте',
      '',
    ].join('\n'),
  );
}

export function createAsk(terminal: Terminal, projectDir: string, tools?: readonly InitTool[]): Ask {
  return {
    async chooseTargets({ skills, options }) {
      if (tools !== undefined) {
        return tools.map((tool) => ({
          id: 'custom',
          root: path.join(path.resolve(projectDir), `.${tool}`, 'skills'),
        }));
      }
      const visible = options.filter((option) => option.id !== 'global');
      writeTargets(options, projectDir, skills);
      const picked = await terminal.question('Куда ставить (1 или 2, пусто — отмена): ');
      const chosen: ChosenTarget[] = [];
      for (const part of picked
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        const option = visible[Number(part) - 1];
        if (option === undefined) continue;
        if (option.id === 'custom') {
          const root = (await terminal.question('Путь: ')).trim();
          if (root !== '') chosen.push({ id: 'custom', root });
        } else {
          chosen.push({ id: option.id });
        }
      }
      return chosen;
    },

    async confirm({ message, paths }) {
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
      'Некого спросить: ввод не терминал. Назовите каталоги явно, например --for claude,agents. Ничего не создано.',
    );
  }
  keepInstalledSkillsFresh();
  const meta = packageMeta();
  const terminal = createTerminal();
  try {
    return await installSkills({
      pkgName: meta.name,
      version: meta.version,
      templates: templatesDir(),
      stateDir: stateDir(),
      ask: createAsk(terminal, projectDir, tools),
      projectDir,
    });
  } finally {
    terminal.close();
  }
}

export function keepInstalledSkillsFresh(): void {
  try {
    if (process.stdout.isTTY)
      updateNotifier({ pkg: packageMeta(), updateCheckInterval: 1000 * 60 * 60 * 24 }).notify();
    const meta = packageMeta();
    maybeRefreshSkills({
      pkgName: meta.name,
      version: meta.version,
      templates: templatesDir(),
      stateDir: stateDir(),
    });
  } catch {
    return;
  }
}
