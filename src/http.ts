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

const TOKEN_PATTERN = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g;

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

function addressSegments(text: string): string[] {
  const address = text.split('#', 1)[0] ?? '';
  const queryStart = address.indexOf('?');
  const path = queryStart === -1 ? address : address.slice(0, queryStart);
  if (queryStart === -1) return path.split('/');
  const query = address.slice(queryStart + 1);
  const values = query.split('&').map((parameter) => {
    const separator = parameter.indexOf('=');
    return separator === -1 ? parameter : parameter.slice(separator + 1);
  });
  return [...path.split('/'), ...values];
}

function tokenSources(text: string, location: HttpToken['source']): string[] {
  const segments = location === 'address' ? addressSegments(text) : [text];
  return segments.flatMap((segment) => {
    const decoded = decodeEscapes(segment);
    return decoded === segment ? [segment] : [segment, decoded];
  });
}

function tokenBoundary(source: string, match: RegExpMatchArray, location: HttpToken['source']): boolean {
  const following = source[(match.index ?? 0) + match[0].length];
  if (location === 'outside_address') return following === undefined || /[\s"'<>]/u.test(following);
  const preceding = source[(match.index ?? 0) - 1];
  return following === undefined && (match.index === 0 || preceding === '+' || /\s/u.test(preceding ?? ''));
}

function tokenCandidates(text: string, location: HttpToken['source']): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const source of tokenSources(text, location)) {
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      const value = match[1];
      if (value === undefined || seen.has(value) || !tokenBoundary(source, match, location)) continue;
      seen.add(value);
      values.push(value);
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
    for (const value of tokenCandidates(text, source)) {
      if (seen.has(value)) continue;
      try {
        result.push({ ...decodeToken(value), source });
        seen.add(value);
      } catch {}
    }
  }
  return result;
}

function statusAndSizeOf(tail: string): { responseStatus: number | null; responseSize: number | null } {
  const groups = /^\s+(?<status>\d{3})(?:\s+(?<size>\d+|-))?(?:\s|$)/u.exec(tail)?.groups;
  const size = groups?.size;
  return {
    responseStatus: groups?.status ? Number(groups.status) : null,
    responseSize: size && size !== '-' ? Number(size) : null,
  };
}

function userAgentOf(message: string, tail: string): string | null {
  const combined = /\s\d{3}\s+(?:\d+|-)\s+"[^"]*"\s+"(?<value>[^"]*)"/u.exec(tail);
  return (
    firstMatch(message, [
      /(?:http_user_agent|user_agent|user-agent)\s*[=:]\s*"(?<value>[^"]*)"/iu,
      /User-Agent:\s*(?<value>.*?)(?=\s+(?:[A-Za-z-]+:|\w+[=:])|$)/iu,
    ]) ??
    (combined?.groups?.value === '-' ? null : combined?.groups?.value) ??
    null
  );
}

function durationOf(message: string, tail: string): string | null {
  return (
    firstMatch(message, [
      /(?:request_time|duration|request_duration)\s*[=:]\s*"?(?<value>\d+(?:\.\d+)?(?:ms|s)?)"?/iu,
    ]) ?? firstMatch(tail, [/\s\d{3}\s+(?:\d+|-)\s+"[^"]*"\s+"[^"]*"\s+\d+\s+(?<value>\d+\.\d+)\s/u])
  );
}

function upstreamOf(message: string): string | null {
  return (
    firstMatch(message, [/\[(?<value>[a-z0-9]([a-z0-9-]*[a-z0-9])?-\d+)\]/u]) ??
    firstMatch(message, [/(?:upstream_addr|upstream_address|upstream)\s*[=:]\s*"?(?<value>[^\s",]+)"?/iu])
  );
}

export function parseHttpMessage(message: string): ParsedHttpTraffic | null {
  const request = /(?<method>[A-Z]+)\s+(?<path>\S+)\s+(?<protocol>HTTP\/(?:\d+(?:\.\d+)?|2|3))/u.exec(message);
  if (!request?.groups) return null;

  const path = request.groups.path as string;
  const requestStart = request.index ?? 0;
  const requestEnd = requestStart + request[0].length;
  const tail = message.slice(requestEnd).replace(/^"/, '');
  const clientAddress = firstMatch(message, [
    /(?:remote_addr|client_addr|client_address)\s*[=:]\s*"?(?<value>[^\s",]+)"?/iu,
    /^(?<value>[^\s]+)\s+-\s+/u,
  ]);
  const headers = `${message.slice(0, requestStart)} ${message.slice(requestEnd)}`;
  return {
    method: request.groups.method as string,
    path,
    protocol: request.groups.protocol as string,
    ...statusAndSizeOf(tail),
    duration: durationOf(message, tail),
    clientAddress,
    userAgent: userAgentOf(message, tail),
    upstream: upstreamOf(message),
    tokens: decodeCandidates(path, headers),
  };
}

export function parseHttpRecord(record: LogRecord): ParsedHttpTraffic | null {
  const message = record._msg;
  return typeof message === 'string' ? parseHttpMessage(message) : null;
}
