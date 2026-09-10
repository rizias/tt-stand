import type { LogRecord } from './grafana.ts';
import { type DecodedToken, decodeToken } from './token.ts';

export interface HttpToken extends DecodedToken {
  source: 'address' | 'outside_address';
}

export interface ParsedHttpTraffic {
  method: string;
  path: string;
  protocol: string;
  responseStatus: number | null;
  responseSize: number | null;
  duration: string | null;
  clientAddress: string | null;
  userAgent: string | null;
  upstream: string | null;
  tokens: HttpToken[];
}

const TOKEN_PATTERN =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g;

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.groups?.value;
    if (value !== undefined && value.length > 0 && value !== '-') return value;
  }
  return null;
}

function decodeEscapes(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {}
  return text.replace(/(?:%[0-9a-fA-F]{2})+/gu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function tokenCandidates(text: string): string[] {
  const sources = [text];
  const decoded = decodeEscapes(text);
  if (decoded !== text) sources.push(decoded);

  const values: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      const value = match[1];
      if (value !== undefined && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
  }
  return values;
}

function decodeCandidates(address: string, headers: string): HttpToken[] {
  const result: HttpToken[] = [];
  const seen = new Set<string>();
  for (const [source, text] of [
    ['address', address],
    ['outside_address', headers],
  ] as const) {
    for (const value of tokenCandidates(text)) {
      if (seen.has(value)) continue;
      try {
        result.push({ ...decodeToken(value), source });
        seen.add(value);
      } catch {}
    }
  }
  return result;
}

export function parseHttpMessage(message: string): ParsedHttpTraffic | null {
  const request =
    /(?<method>[A-Z]+)\s+(?<path>\S+)\s+(?<protocol>HTTP\/(?:\d+(?:\.\d+)?|2|3))/u.exec(message);
  if (!request?.groups) return null;

  const method = request.groups.method as string;
  const path = request.groups.path as string;
  const protocol = request.groups.protocol as string;
  const tail = message.slice((request.index ?? 0) + request[0].length).replace(/^"/, '');
  const statusAndSize = /^\s+(?<status>\d{3})\s+(?<size>\d+|-)(?:\s|$)/u.exec(tail);
  const responseStatus = statusAndSize?.groups?.status ? Number(statusAndSize.groups.status) : null;
  const responseSize =
    statusAndSize?.groups?.size && statusAndSize.groups.size !== '-'
      ? Number(statusAndSize.groups.size)
      : null;

  const combined = /\s\d{3}\s+(?:\d+|-)\s+"[^"]*"\s+"(?<value>[^"]*)"/u.exec(tail);
  const userAgent =
    firstMatch(message, [
      /(?:http_user_agent|user_agent|user-agent)\s*[=:]\s*"(?<value>[^"]*)"/iu,
      /User-Agent:\s*(?<value>.*?)(?=\s+(?:[A-Za-z-]+:|\w+[=:])|$)/iu,
    ]) ??
    combined?.groups?.value ??
    null;

  const duration =
    firstMatch(message, [
      /(?:request_time|duration|request_duration)\s*[=:]\s*"?(?<value>\d+(?:\.\d+)?(?:ms|s)?)"?/iu,
    ]) ??
    firstMatch(tail, [/\s\d{3}\s+(?:\d+|-)\s+"[^"]*"\s+"[^"]*"\s+\d+\s+(?<value>\d+\.\d+)\s/u]);
  const clientAddress = firstMatch(message, [
    /(?:remote_addr|client_addr|client_address)\s*[=:]\s*"?(?<value>[^\s",]+)"?/iu,
    /^(?<value>[^\s]+)\s+-\s+/u,
  ]);
  const upstream =
    firstMatch(message, [/\[(?<value>[a-z0-9]([a-z0-9-]*[a-z0-9])?-\d+)\]/u]) ??
    firstMatch(message, [
      /(?:upstream_addr|upstream_address|upstream)\s*[=:]\s*"?(?<value>[^\s",]+)"?/iu,
    ]);

  const requestEnd = (request.index ?? 0) + request[0].length;
  const headers = `${message.slice(0, request.index ?? 0)} ${message.slice(requestEnd)}`;
  return {
    method,
    path,
    protocol,
    responseStatus,
    responseSize,
    duration,
    clientAddress,
    userAgent,
    upstream,
    tokens: decodeCandidates(path, headers),
  };
}

export function parseHttpRecord(record: LogRecord): ParsedHttpTraffic | null {
  const message = record._msg;
  return typeof message === 'string' ? parseHttpMessage(message) : null;
}
