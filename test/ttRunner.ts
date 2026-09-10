import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const root = join(import.meta.dirname, '..');
export const cli = join(root, 'src', 'cli.ts');

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

export async function tt(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

export function homeEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home };
}
