import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homedir(), input.slice(2));
  }
  return input;
}

export function normalizePath(input: string): string {
  const expanded = expandHome(input).replace(/[\\/]+/g, sep);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}
