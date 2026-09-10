import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INCOMPLETENESS_REASONS, ToolError } from '../errors.ts';
import { normalizePath } from '../paths.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';

class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`git завершился с кодом ${exitCode}: ${stderr}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface ParsedImage {
  reference: string;
  registry: string | null;
  path: string;
  name: string;
  tag: string;
  version: string | null;
  commit: string | null;
}

function splitRegistry(reference: string): { registry: string | null; rest: string } {
  const slash = reference.indexOf('/');
  if (slash === -1) return { registry: null, rest: reference };
  const first = reference.slice(0, slash);
  if (first.includes('.') || first.includes(':') || first === 'localhost') {
    return { registry: first, rest: reference.slice(slash + 1) };
  }
  return { registry: null, rest: reference };
}

export function parseImageReference(reference: string): ParsedImage {
  const { registry, rest } = splitRegistry(reference);
  const separator = rest.lastIndexOf(':');
  const path = separator === -1 ? rest : rest.slice(0, separator);
  const tag = separator === -1 ? '' : rest.slice(separator + 1);
  const match = /^(?<version>.*?)-?(?<commit>[0-9a-fA-F]{40})$/u.exec(tag);
  return {
    reference,
    registry,
    path,
    name: path.split('/').pop() ?? path,
    tag,
    version: match?.groups?.version || null,
    commit: match?.groups?.commit ?? null,
  };
}

async function git(repository: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') {
        reject(new ToolError('git_unavailable', 'Исполняемый файл git не найден в PATH.'));
        return;
      }
      reject(new ToolError('git_unavailable', `Запуск git не удался: ${cause.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new GitCommandError(code ?? -1, stderr.trim()));
    });
  });
}

function findRepositories(parsed: ParsedImage, roots: string[]): string[] {
  const relatives = parsed.path === parsed.name ? [parsed.name] : [parsed.path, parsed.name];
  const found: string[] = [];
  for (const root of roots) {
    for (const relative of relatives) {
      const candidate = join(normalizePath(root), relative);
      if (existsSync(join(candidate, '.git')) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

function refsUpdatedAt(repository: string): string | null {
  const fetchHead = join(repository, '.git', 'FETCH_HEAD');
  if (existsSync(fetchHead)) return statSync(fetchHead).mtime.toISOString();
  const packedRefs = join(repository, '.git', 'packed-refs');
  if (existsSync(packedRefs)) return statSync(packedRefs).mtime.toISOString();
  return null;
}

export interface BranchCandidate {
  ref: string;
  lastCommitDate: string;
}

export async function runImage(
  profileName: string,
  roots: string[],
  reference: string,
): Promise<ToolResponse> {
  const parsed = parseImageReference(reference);

  const echo = {
    command: 'image',
    query: parsed.reference,
    request: null,
    start: null,
    end: null,
    limit: null,
    limitNote: 'запрос к хранилищу не выполнялся',
    datasource: null,
    datasourceNote: null,
    recordsReturned: 0,
    hitLimit: false,
    unparsableLines: 0,
    order: 'ветки перечислены в порядке git',
    unavailableSources: [] as string[],
    valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
    identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
    repositoryRoots: roots,
    repository: null as string | null,
    refsUpdatedAt: null as string | null,
    fetchPerformed: 'git fetch не выполнялся: локальные ссылки могли устареть',
    refsUpdatedAtNote:
      'время последнего обновления удалённых ссылок; null означает, что оно неизвестно',
    profile: profileName,
  };

  if (parsed.commit === null) {
    return {
      ok: true,
      command: 'image',
      data: { ...parsed, repository: null, commitInfo: null, branchCandidates: [] },
      summary: { resolved: false, reason: 'в теге образа нет полного SHA коммита' },
      echo,
      incomplete: true,
      incompleteReasons: [INCOMPLETENESS_REASONS.imageTagWithoutSha],
      errorClass: null,
      error: null,
    };
  }

  const repositories = findRepositories(parsed, roots);
  if (repositories.length === 0) {
    return {
      ok: true,
      command: 'image',
      data: { ...parsed, repository: null, commitInfo: null, branchCandidates: [] },
      summary: {
        resolved: false,
        reason: `локальный репозиторий «${parsed.path}» не найден в каталогах: ${roots.join(', ') || '(не заданы)'}`,
      },
      echo,
      incomplete: true,
      incompleteReasons: [INCOMPLETENESS_REASONS.repositoryNotFound],
      errorClass: null,
      error: null,
    };
  }
  if (repositories.length > 1) {
    throw new ToolError(
      'bad_request',
      `Репозиторий «${parsed.path}» найден в нескольких каталогах: ${repositories.join(', ')}. Оставьте в repositories.roots один каталог с этим именем.`,
    );
  }

  const repository = repositories[0] as string;
  echo.repository = repository;
  echo.refsUpdatedAt = refsUpdatedAt(repository);

  let objectType: string | null;
  try {
    objectType = await git(repository, ['cat-file', '-t', parsed.commit]);
  } catch (cause) {
    if (cause instanceof ToolError) throw cause;
    if (
      cause instanceof GitCommandError &&
      /could not get object info|Not a valid object name|unknown revision/iu.test(cause.stderr)
    ) {
      objectType = null;
    } else {
      throw new ToolError(
        'upstream_error',
        `Обращение к репозиторию ${repository} не удалось: ${(cause as Error).message}`,
      );
    }
  }
  if (objectType !== 'commit') {
    return {
      ok: true,
      command: 'image',
      data: { ...parsed, repository, commitInfo: null, branchCandidates: [] },
      summary: {
        resolved: false,
        reason: 'коммита нет в локальной копии репозитория',
      },
      echo,
      incomplete: true,
      incompleteReasons: [INCOMPLETENESS_REASONS.commitNotLocal],
      errorClass: null,
      error: null,
    };
  }

  const [rawCommit, rawBranches] = await Promise.all([
    git(repository, ['log', '-1', '--format=%H%n%an%n%aI%n%B', parsed.commit]),
    git(repository, [
      'for-each-ref',
      '--contains',
      parsed.commit,
      '--format=%(refname:short)%09%(committerdate:iso8601)',
      'refs/heads',
      'refs/remotes',
    ]),
  ]);

  const [sha, author, authoredAt, ...messageLines] = rawCommit.split('\n');
  const message = messageLines.join('\n').replace(/\n+$/u, '');
  const branchCandidates: BranchCandidate[] = rawBranches
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [ref, lastCommitDate] = line.split('\t');
      return { ref: ref ?? '', lastCommitDate: lastCommitDate ?? '' };
    });

  echo.recordsReturned = branchCandidates.length;

  return {
    ok: true,
    command: 'image',
    data: {
      ...parsed,
      repository,
      commitInfo: { sha, author, authoredAt, message },
      branchCandidates,
    },
    summary: {
      resolved: true,
      branchCandidateCount: branchCandidates.length,
      branchNote:
        'ветки перечислены как кандидаты: один коммит может входить в несколько веток, инструмент не утверждает текущую',
    },
    echo,
    incomplete: branchCandidates.length === 0,
    incompleteReasons:
      branchCandidates.length === 0
        ? ['ни одна локальная ссылка не содержит этот коммит: ссылки могли устареть']
        : [],
    errorClass: null,
    error: null,
  };
}
