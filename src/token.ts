import { ToolError } from './errors.ts';

export interface DecodedToken {
  value: string;
  header: unknown;
  payload: unknown;
  issuedAt: TokenTime | null;
  expiresAt: TokenTime | null;
  signatureVerified: false;
  verificationNote: string;
}

export interface TokenTime {
  claim: unknown;
  readable: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function decodePart(value: string, partName: string): unknown {
  if (!BASE64URL.test(value)) {
    throw new ToolError(
      'token_invalid',
      `${partName} токена содержит символы, недопустимые для base64url.`,
    );
  }

  let text: string;
  try {
    text = Buffer.from(value, 'base64url').toString('utf8');
  } catch (cause) {
    throw new ToolError(
      'token_invalid',
      `${partName} токена не декодируется из base64url: ${(cause as Error).message}`,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ToolError(
      'token_invalid',
      `${partName} токена не содержит JSON: ${(cause as Error).message}`,
    );
  }
}

function claim(payload: unknown, name: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)[name];
}

function readableTime(value: unknown): TokenTime | null {
  if (value === undefined || value === null) return null;
  const milliseconds =
    typeof value === 'number'
      ? value * 1000
      : typeof value === 'string' && value.trim().length > 0
        ? Date.parse(value)
        : Number.NaN;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
    return { claim: value, readable: 'значение времени не распознано' };
  }
  return { claim: value, readable: date.toISOString() };
}

export function decodeToken(value: string): DecodedToken {
  const token = value.trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new ToolError(
      'token_invalid',
      'Ожидался токен в compact-формате из трёх частей: header.payload.signature.',
    );
  }

  const header = decodePart(parts[0] as string, 'Заголовок');
  const payload = decodePart(parts[1] as string, 'Полезная нагрузка');
  return {
    value: token,
    header,
    payload,
    issuedAt: readableTime(claim(payload, 'iat')),
    expiresAt: readableTime(claim(payload, 'exp')),
    signatureVerified: false,
    verificationNote:
      'Подпись не проверялась: содержимое — утверждение из токена, а не установленная личность.',
  };
}
