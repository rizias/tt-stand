import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile } from './lock.ts';
import type { ToolResponse } from './response.ts';

export const RUN_VARIABLE = 'TT_STAND_RUN';

export interface JournalOutcome {
  file: string | null;
  failure: string | null;
}

export interface JournalOrigin {
  pid: number;
  parentPid: number;
  run: string | null;
}

export function currentOrigin(environment: NodeJS.ProcessEnv = process.env): JournalOrigin {
  const run = environment[RUN_VARIABLE];
  return {
    pid: process.pid,
    parentPid: process.ppid,
    run: run !== undefined && run.length > 0 ? run : null,
  };
}

function journalEntryPath(directory: string, at: string, origin: JournalOrigin): string {
  return join(directory, `${at.replace(/[:.]/gu, '-')}-${origin.pid}-${randomUUID()}.json`);
}

export function writeJournalEntry(
  directory: string,
  invocation: string[],
  response: ToolResponse,
  at: string,
  origin: JournalOrigin = currentOrigin(),
  profile: string | null = null,
): JournalOutcome {
  const file = journalEntryPath(directory, at, origin);
  response.echo.journal = file;
  try {
    atomicWriteFile(file, `${JSON.stringify({ at, origin, profile, invocation, response }, null, 2)}\n`);
    return { file, failure: null };
  } catch (cause) {
    return { file, failure: `запись журнала ${file} не создана: ${(cause as Error).message}` };
  }
}
