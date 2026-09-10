import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { INCOMPLETENESS_REASONS, ToolError } from '../errors.ts';
import { localEcho, type ToolResponse } from '../response.ts';
import { INIT_TOOLS, type InitTool, runInit } from '../skills/setup.ts';

function toolsFrom(names: string): InitTool[] {
  const tools = names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = tools.filter((tool) => !(INIT_TOOLS as readonly string[]).includes(tool));
  if (unknown.length > 0) {
    throw new ToolError(
      'bad_request',
      `Неизвестный инструмент: ${unknown.join(', ')}. Доступны: ${INIT_TOOLS.join(', ')}.`,
    );
  }
  return tools as InitTool[];
}

export async function runInitCommand(
  projectDir: string,
  forFlag: string | undefined,
): Promise<ToolResponse> {
  const tools = forFlag === undefined ? undefined : toolsFrom(forFlag);
  const root = resolve(projectDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ToolError('bad_request', `Проекта нет по пути: ${root}. Ничего не создано.`);
  }
  const report = await runInit(root, tools);
  const skipped = report.skipped.length > 0;
  return {
    ok: !skipped,
    command: 'init',
    data: report,
    summary: { hint: 'Копии скилла обновляются сами при следующем запуске любой команды.' },
    echo: localEcho('init'),
    incomplete: skipped,
    incompleteReasons: skipped ? [INCOMPLETENESS_REASONS.skillCopySkipped] : [],
    errorClass: skipped ? 'skill_copy_skipped' : null,
    error: skipped
      ? report.skipped.map((copy) => `${copy.path}: ${copy.message ?? copy.reason}`).join('; ')
      : null,
  };
}
