export const TIME_ENCODINGS = new Set(['rfc3339', 'unixSeconds', 'unixMilliseconds']);

export function parseTime(value, encoding) {
  if (!TIME_ENCODINGS.has(encoding)) return { ok: false, error: `Неизвестная кодировка времени: ${encoding}` };
  if (encoding === 'rfc3339') return parseRfc3339(value);
  return parseUnix(value, encoding);
}

function parseRfc3339(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: 'Пустое время RFC3339.' };
  const parts = /^(\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) {
    return { ok: false, error: 'RFC3339 требует явного Z или смещения часового пояса.' };
  }
  const calendarTime = parts[1].toUpperCase();
  const calendarMs = Date.parse(`${calendarTime}Z`);
  if (!Number.isFinite(calendarMs) || new Date(calendarMs).toISOString().slice(0, 19) !== calendarTime) {
    return { ok: false, error: 'RFC3339 содержит невозможную календарную дату или время.' };
  }
  if (!Number.isFinite(Date.parse(value))) return { ok: false, error: 'Время RFC3339 не разбирается.' };
  const wholeMs = Date.parse(`${parts[1]}${parts[3]}`);
  const fraction = parts[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const ticks = BigInt(wholeMs) * scale + BigInt(fraction || '0') * 1000n;
  const ms = Number(`${ticks}e-${fraction.length}`);
  return { ok: true, ms };
}

function parseUnix(value, encoding) {
  if (typeof value === 'string' && value.trim() === '') return { ok: false, error: 'Пустое числовое время.' };
  if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, error: 'Неверный тип времени.' };
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return { ok: false, error: 'Числовое время не является конечным числом.' };
  const [coefficient, exponent = '0'] = String(n).split('e');
  const ms = encoding === 'unixSeconds' ? Number(`${coefficient}e${Number(exponent) + 3}`) : n;
  if (!Number.isFinite(ms)) return { ok: false, error: 'Числовое время не является конечным числом.' };
  return { ok: true, ms };
}

export function formatTime(ms) {
  const [coefficient, exponent = '0'] = String(ms).split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const decimalPlaces = Math.max(0, fraction.length - Number(exponent));
  const ticks = BigInt(`${whole}${fraction}`) * 10n ** BigInt(Math.max(0, Number(exponent) - fraction.length));
  const scale = 10n ** BigInt(decimalPlaces);
  const remainder = ((ticks % scale) + scale) % scale;
  const wholeMs = (ticks - remainder) / scale;
  const tail = remainder.toString().padStart(decimalPlaces, '0').replace(/0+$/, '');
  return new Date(Number(wholeMs)).toISOString().replace('Z', `${tail}Z`);
}

export function readFinite(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { n: raw, nonFinite: false } : { n: null, nonFinite: true };
  }
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'Значение пустое или не число.' };
  const text = raw.trim();
  if (nonFiniteToken(text)) return { n: null, nonFinite: true };
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: 'Значение не число.' };
  return { n, nonFinite: false };
}

function nonFiniteToken(text) {
  const token = text.toLowerCase();
  return (
    token === 'nan' ||
    token === '+inf' ||
    token === '-inf' ||
    token === 'inf' ||
    token === '+infinity' ||
    token === '-infinity' ||
    token === 'infinity'
  );
}
