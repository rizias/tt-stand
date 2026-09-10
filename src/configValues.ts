import { ToolError } from './errors.ts';

export function expectTable(
  value: unknown,
  field: string,
  path: string,
): Record<string, unknown> | null {
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
