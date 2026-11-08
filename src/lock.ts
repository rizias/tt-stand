import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

interface LockHolder {
  pid: number;
  token: string;
}

const RETRIABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !RETRIABLE.has(errorCode(error) ?? '')) throw error;
      pause(Math.min(remaining, 20 + Math.floor(Math.random() * 31)));
    }
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function temporaryPath(path: string): string {
  return join(dirname(path), `.tt-${process.pid}-${randomUUID()}.tmp`);
}

export function createFileExclusive(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
  } finally {
    removeIfPresent(temporary);
  }
}

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameWithRetry(temporary, path);
  } finally {
    removeIfPresent(temporary);
  }
}

function createLock(path: string): string | null {
  const token = randomUUID();
  return createFileExclusive(path, JSON.stringify({ pid: process.pid, token })) ? token : null;
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const holder = parsed as Record<string, unknown>;
    if (
      !Number.isInteger(holder.pid) ||
      typeof holder.pid !== 'number' ||
      holder.pid < 1 ||
      typeof holder.token !== 'string'
    )
      return null;
    return { pid: holder.pid, token: holder.token };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function releaseLock(path: string, token: string): void {
  if (readHolder(path)?.token === token) removeIfPresent(path);
}

function reclaimStaleLock(path: string): boolean {
  const holder = readHolder(path);
  if (holder === null || isAlive(holder.pid)) return false;
  const guardPath = `${path}.takeover`;
  const guard = createLock(guardPath);
  if (guard === null) {
    reclaimStaleLock(guardPath);
    return false;
  }
  try {
    const current = readHolder(path);
    if (current === null || isAlive(current.pid)) return false;
    removeIfPresent(path);
    return true;
  } finally {
    releaseLock(guardPath, guard);
  }
}

function timedOut(path: string, deadline: number): void {
  if (Date.now() >= deadline)
    throw new Error(`Истёк таймаут ожидания блокировки ${path}. Повторите команду после завершения другого процесса.`);
}

export function withFileLock<T>(path: string, action: () => T, timeoutMs = 10_000): T {
  const deadline = Date.now() + timeoutMs;
  let token = createLock(path);
  while (token === null) {
    reclaimStaleLock(path);
    timedOut(path, deadline);
    pause(20);
    token = createLock(path);
  }
  try {
    return action();
  } finally {
    releaseLock(path, token);
  }
}

export async function withFileLockAsync<T>(path: string, action: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let token = createLock(path);
  while (token === null) {
    reclaimStaleLock(path);
    timedOut(path, deadline);
    await setTimeout(20);
    token = createLock(path);
  }
  try {
    return await action();
  } finally {
    releaseLock(path, token);
  }
}
