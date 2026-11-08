import { readFileSync } from 'node:fs';
import { ToolError } from './errors.ts';

export function expectTable(value: unknown, field: string, path: string): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolError('config_invalid', `Поле ${field} в ${path} должно быть объектом`);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string') {
    throw new ToolError('config_invalid', `Поле ${field} в ${path} должно быть строкой`);
  }
  return value;
}

export function expectNumber(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolError('config_invalid', `Поле ${field} в ${path} должно быть числом`);
  }
  return value;
}

export function expectStringList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolError('config_invalid', `Поле ${field} в ${path} должно быть списком строк`);
  }
  return value as string[];
}

export function assertKnownFields(
  raw: Record<string, unknown>,
  fields: readonly string[],
  field: string,
  path: string,
): void {
  if (Object.keys(raw).some((key) => !fields.includes(key))) {
    throw new ToolError(
      'config_invalid',
      `Неизвестное поле в ${field} файла ${path}. Допустимые поля ${fields.join(', ')}.`,
    );
  }
}

export function readConfigDocument(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    parsed = JSON.parse(content.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    throw new ToolError(
      'config_invalid',
      `Файл ${path} должен содержать корректный JSON в UTF-8. Исправьте формат файла.`,
    );
  }
  return expectTable(parsed, 'корень', path) ?? {};
}

export function validateProfileName(value: string, location: string): string {
  if (value.length === 0 || value === '.' || value === '..' || /[\\/:\u0000-\u001F]/u.test(value)) {
    throw new ToolError(
      'config_invalid',
      `Имя профиля в ${location} должно быть одним именем каталога без разделителей пути.`,
    );
  }
  return value;
}
