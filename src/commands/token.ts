import { ToolError } from '../errors.ts';
import { ECHO_CONSTANTS, type ToolResponse } from '../response.ts';
import { decodeToken } from '../token.ts';

export async function readTokenFromStdin(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (value.length === 0) {
    throw new ToolError('token_invalid', 'Токен не передан через --value и стандартный ввод пуст.');
  }
  return value;
}

export function tokenResponse(value: string): ToolResponse {
  const decoded = decodeToken(value);
  return {
    ok: true,
    command: 'token',
    data: decoded,
    summary: {
      signatureVerified: false,
      verificationNote: decoded.verificationNote,
    },
    echo: {
      command: 'token',
      query: null,
      request: null,
      start: null,
      end: null,
      limit: null,
      limitNote: 'запрос к внешней системе не выполнялся',
      datasource: null,
      datasourceNote: null,
      recordsReturned: 1,
      hitLimit: false,
      unparsableLines: 0,
      order: 'не применимо',
      unavailableSources: [],
      valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
      identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
    },
    incomplete: false,
    incompleteReasons: [],
    errorClass: null,
    error: null,
  };
}
