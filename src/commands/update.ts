import { spawnSync } from 'node:child_process';
import { INCOMPLETENESS_REASONS } from '../errors.ts';
import { localEcho, type ToolResponse } from '../response.ts';
import { packageMeta } from '../skills/setup.ts';

export interface UpdateOutcome {
  exitCode: number;
  npmOutput: string;
}

export function runUpdate(): UpdateOutcome {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['i', '-g', `${packageMeta().name}@latest`], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    windowsHide: false,
    shell: process.platform === 'win32',
  });
  return { exitCode: result.status ?? 1, npmOutput: result.stdout ?? '' };
}

export function runUpdateCommand(): ToolResponse {
  const outcome = runUpdate();
  const failed = outcome.exitCode !== 0;
  return {
    ok: !failed,
    command: 'update',
    data: outcome,
    summary: { hint: 'Копии скилла обновятся сами при следующем запуске любой команды.' },
    echo: localEcho('update'),
    incomplete: failed,
    incompleteReasons: failed ? [INCOMPLETENESS_REASONS.updateFailed] : [],
    errorClass: failed ? 'update_failed' : null,
    error: failed ? `npm завершился кодом ${outcome.exitCode}` : null,
  };
}
