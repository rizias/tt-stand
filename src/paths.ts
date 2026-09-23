import { homedir } from 'node:os';
import path, { type PlatformPath } from 'node:path';

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.resolve(homedir(), input.slice(2));
  }
  return input;
}

const UNC_PREFIX = /^[\\/]{2,}([^\\/].*)$/;

export function normalizePathFor(platform: PlatformPath, input: string): string {
  const expanded = expandHome(input);
  const { sep } = platform;
  const uncMatch = UNC_PREFIX.exec(expanded);
  if (uncMatch !== null) {
    const rest = (uncMatch[1] as string).replace(/[\\/]+/g, sep);
    return platform.resolve(`${sep}${sep}${rest}`);
  }
  const collapsed = expanded.replace(/[\\/]+/g, sep);
  return platform.isAbsolute(collapsed)
    ? platform.resolve(collapsed)
    : platform.resolve(process.cwd(), collapsed);
}

export function normalizePath(input: string): string {
  return normalizePathFor(path, input);
}
