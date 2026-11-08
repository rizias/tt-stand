import { createHmac, timingSafeEqual } from 'node:crypto';

function equalBytes(first: Buffer, second: Buffer): boolean {
  return first.length === second.length && timingSafeEqual(first, second);
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, version, salt, digest] = pattern.split('|');
    if (version !== '1' || !salt || !digest) return false;
    const computed = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest();
    return equalBytes(computed, Buffer.from(digest, 'base64'));
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.');
  return new RegExp(`^${escaped}$`, 'iu').test(host);
}

function hostListMatches(patterns: string, host: string): boolean {
  const names = patterns.split(',');
  if (names.some((name) => name.startsWith('!') && hostMatches(name.slice(1), host))) return false;
  return names.some((name) => !name.startsWith('!') && hostMatches(name, host));
}

interface KnownKey {
  key: Buffer;
  revoked: boolean;
}

export function knownHostVerifier(contents: string, hostname: string, port: number): (key: Buffer) => boolean {
  const host = port === 22 ? hostname : `[${hostname}]:${port}`;
  const keys: KnownKey[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined;
    const [names, algorithm, encoded] = fields;
    if (!names || names.startsWith('#') || !algorithm || !encoded) continue;
    if (marker && marker !== '@revoked') continue;
    if (!hostListMatches(names, host)) continue;
    keys.push({ key: Buffer.from(encoded, 'base64'), revoked: marker === '@revoked' });
  }
  return (key) => {
    const matching = keys.filter((known) => equalBytes(known.key, key));
    return matching.some((known) => !known.revoked) && !matching.some((known) => known.revoked);
  };
}
