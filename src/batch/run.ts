import { join } from 'node:path';
import { required, type ParsedValues } from '../cli/args.ts';
import { buildLogsContext, executeLogs } from '../cli/dispatch.ts';
import { buildMetricsContext, executeMetrics } from '../cli/dispatchMetrics.ts';
import { failureResponse } from '../cli/failure.ts';
import { computeIgnoredFlags, IGNORED_FLAGS_NOTE } from '../cli/ignoredFlags.ts';
import { ToolError } from '../errors.ts';
import { resolveActiveProfile } from '../profiles.ts';
import { localEcho, type ToolResponse } from '../response.ts';
import { BatchFiles, type StoredResponse } from './files.ts';
import { loadBatch, type PreparedRequest } from './plan.ts';
import { prepareReport, renderBatchReport, type ReportResult } from './report.ts';
import { BatchTrace } from './trace.ts';
import { publicGrafanaUrl } from './grafanaOrigin.ts';

function onceSuccessful<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  return async () => {
    if (value !== undefined) return value;
    value = await factory();
    return value;
  };
}

interface Getters {
  metrics: () => ReturnType<typeof buildMetricsContext>;
  logs: () => ReturnType<typeof buildLogsContext>;
}

function measured<T>(factory: () => Promise<T>, elapsed: { ms: number }): () => Promise<T> {
  return async () => {
    const start = performance.now();
    try {
      return await factory();
    } finally {
      elapsed.ms += performance.now() - start;
    }
  };
}

async function execute(
  request: PreparedRequest,
  getters: Getters,
): Promise<{
  response: ToolResponse;
  contextWaitMs: number;
}> {
  const elapsed = { ms: 0 };
  let response: ToolResponse;
  try {
    response =
      request.kind === 'metrics'
        ? await executeMetrics(request.operation, measured(getters.metrics, elapsed))
        : await executeLogs(request.operation, measured(getters.logs, elapsed));
  } catch (cause) {
    if (cause instanceof ToolError && cause.errorClass === 'output_write_failed') throw cause;
    response = failureResponse(cause, request.invocation.slice(0, 2).join(' '));
  }
  const ignored = computeIgnoredFlags(request.invocation);
  Object.assign(response.echo, {
    ignoredFlags: ignored,
    ignoredFlagsNote: ignored.length ? IGNORED_FLAGS_NOTE : null,
  });
  return { response, contextWaitMs: elapsed.ms };
}

async function executeItems(
  requests: PreparedRequest[],
  getters: Getters,
  files: BatchFiles,
  trace: BatchTrace,
  results: StoredResponse[],
): Promise<void> {
  for (const [index, request] of requests.entries()) {
    trace.select(request.id);
    const start = performance.now();
    const { response, contextWaitMs } = await execute(request, getters);
    const operationMs = performance.now() - start;
    const writeStart = performance.now();
    const stored = files.writeResponse(index, response);
    results.push({
      id: request.id,
      why: request.why,
      originalArgv: request.originalArgv,
      invocation: request.invocation,
      responseFile: stored.relative,
      ok: response.ok,
      incomplete: response.incomplete,
      incompleteReasons: response.incompleteReasons,
      errorClass: response.errorClass,
      error: response.error,
      operationMs,
      contextWaitMs,
      writeMs: performance.now() - writeStart,
      responseBytes: stored.bytes,
    });
  }
}

interface Outcome {
  manifest: string | null;
  report: ReportResult | null;
  storageError: ToolError | null;
  reportError: ToolError | null;
  storageErrors: string[];
}

function captureStorage(outcome: Outcome, cause: unknown): void {
  const error = cause instanceof ToolError ? cause : new ToolError('output_write_failed', (cause as Error).message);
  outcome.storageError ??= error;
  outcome.storageErrors.push(error.message);
}

function responseFor(
  goal: string,
  planned: number,
  results: StoredResponse[],
  files: BatchFiles,
  trace: BatchTrace,
  outcome: Outcome,
  profile: ReturnType<typeof resolveActiveProfile>,
  durationMs: number,
): ToolResponse {
  const failed = results.filter((item) => !item.ok);
  const first = failed[0];
  const error =
    outcome.storageError ??
    (first
      ? new ToolError(first.errorClass ?? 'upstream_error', `Пункт ${first.id}: ${first.error}`)
      : outcome.reportError);
  const reasons = allReasons(results, outcome);
  const echo = localEcho('batch');
  Object.assign(echo, {
    profile: profile.name,
    namespaceScope: profile.namespaceScope,
    limitNote: 'лимиты и серверные умолчания каждого запроса названы в файлах ответов',
    order: 'пункты выполнены в порядке списка; данные каждого ответа сохранены без перестановки',
    recordsReturned: results.length,
    batchFile: files.planFile,
  });
  return {
    ok: error === null,
    command: 'batch',
    data: {
      manifest: outcome.manifest,
      plan: files.planFile,
      requests: files.traceFile,
      responses: results.map((item) => ({ id: item.id, file: join(files.directory, item.responseFile) })),
      report: outcome.report,
    },
    summary: {
      goal,
      planned,
      executed: results.length,
      successful: results.length - failed.length,
      failed: failed.length,
      incomplete: results.filter((item) => item.incomplete).length,
      fetchAttempts: trace.fetchAttempts,
      fetchAttemptsNote: 'наблюдаемые попытки Grafana; скрытые redirects и чужие CLI не измеряются',
      durationMs,
      storageError: outcome.storageError?.message ?? null,
      storageErrors: outcome.storageErrors,
      reportError: outcome.reportError?.message ?? null,
    },
    echo,
    incomplete: reasons.length > 0,
    incompleteReasons: reasons,
    errorClass: error?.errorClass ?? null,
    error: error?.message ?? null,
  };
}

function allReasons(results: StoredResponse[], outcome: Outcome): string[] {
  const reasons = results.flatMap((item) => item.incompleteReasons.map((reason) => `${item.id}: ${reason}`));
  for (const reason of outcome.report?.incompleteReasons ?? []) {
    reasons.push(typeof reason === 'string' ? reason : JSON.stringify(reason));
  }
  if (outcome.storageError) reasons.push('пакет не сохранён целиком: дальнейшее чтение остановлено');
  if (outcome.reportError) reasons.push('представление не построено полностью');
  return [...new Set(reasons)];
}

async function addReport(
  options: ReturnType<typeof prepareReport>,
  outcome: Outcome,
  files: BatchFiles,
): Promise<void> {
  if (options === null || outcome.manifest === null || outcome.storageError) return;
  try {
    outcome.report = await renderBatchReport(options, outcome.manifest, join(files.directory, 'report'));
    if (outcome.report.panelErrors.length > 0) {
      outcome.reportError = new ToolError(
        'report_render_failed',
        outcome.report.panelErrors.map((item) => `${item.id}: ${item.text}`).join('; '),
      );
    }
  } catch (cause) {
    outcome.reportError =
      cause instanceof ToolError ? cause : new ToolError('report_render_failed', (cause as Error).message);
  }
}

export async function runBatchCommand(
  values: ParsedValues,
  loadProfile = () => resolveActiveProfile(values.config, values.profile ?? null),
): Promise<ToolResponse> {
  const batch = loadBatch(required(values.file, 'file'), values);
  const reportOptions = prepareReport(values, batch);
  const out = required(values.out, 'out');
  const profile = loadProfile();
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const files = new BatchFiles(out, batch, profile.name, startedAt);
  const trace = new BatchTrace(files.traceFile);
  const getters = {
    metrics: onceSuccessful(() => buildMetricsContext(values, trace.observer, profile)),
    logs: onceSuccessful(() => buildLogsContext(values, trace.observer, profile)),
  };
  const results: StoredResponse[] = [];
  const outcome: Outcome = { manifest: null, report: null, storageError: null, reportError: null, storageErrors: [] };
  try {
    await executeItems(batch.requests, getters, files, trace, results);
  } catch (cause) {
    captureStorage(outcome, cause);
  }
  try {
    trace.close();
  } catch (cause) {
    captureStorage(outcome, cause);
  }
  try {
    outcome.manifest = files.writeJson('manifest.json', {
      version: 1,
      goal: batch.goal,
      profile: profile.name,
      startedAt,
      grafana: { baseUrl: publicGrafanaUrl(profile.grafana?.baseUrl) },
      finishedAt: new Date().toISOString(),
      planned: batch.requests.length,
      fetchAttempts: trace.fetchAttempts,
      requests: results,
      storageError: outcome.storageError?.message ?? null,
      storageErrors: outcome.storageErrors,
    }).file;
  } catch (cause) {
    captureStorage(outcome, cause);
  }
  await addReport(reportOptions, outcome, files);
  return responseFor(
    batch.goal,
    batch.requests.length,
    results,
    files,
    trace,
    outcome,
    profile,
    performance.now() - start,
  );
}
