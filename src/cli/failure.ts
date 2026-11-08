import { INCOMPLETENESS_REASONS, ToolError } from '../errors.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';

function asToolError(cause: unknown): ToolError {
  if (cause instanceof ToolError) return cause;
  const native = cause as Error & { code?: string };
  const isArgvProblem = typeof native.code === 'string' && native.code.startsWith('ERR_PARSE_ARGS');
  if (isArgvProblem) {
    return new ToolError(
      'bad_request',
      'Некорректные аргументы команды. Проверьте имена и значения флагов по tt-stand --help.',
    );
  }
  return new ToolError('upstream_error', native.message);
}

export function failureResponse(cause: unknown, command: string): ToolResponse {
  const error = asToolError(cause);
  const partial = error.partialPayload as { records?: unknown[]; unparsableLines?: number } | undefined;
  const records = partial?.records ?? null;
  const interrupted =
    records !== null ||
    (command === 'mongo' && (error.errorClass === 'timeout_client' || error.errorClass === 'stream_aborted'));

  return {
    ok: false,
    command,
    data: records,
    summary: null,
    echo: {
      command,
      query: null,
      request: null,
      start: null,
      end: null,
      limit: null,
      limitNote: interrupted ? 'запрос прерван до конца' : 'команда не дошла до запроса',
      datasource: null,
      datasourceNote: null,
      recordsReturned: records?.length ?? 0,
      hitLimit: false,
      unparsableLines: partial?.unparsableLines ?? 0,
      order: records ? ECHO_CONSTANTS.order : 'не применимо',
      unavailableSources: [],
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
      ...error.echo,
    },
    incomplete: true,
    incompleteReasons: [interrupted ? INCOMPLETENESS_REASONS.commandInterrupted : INCOMPLETENESS_REASONS.commandFailed],
    errorClass: error.errorClass,
    error: error.message,
  };
}
