import { spawnSync } from 'node:child_process';
import { packageMeta } from '../skills/setup.ts';

export function runUpdateCommand(): number {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['i', '-g', `${packageMeta().name}@latest`], {
    stdio: 'inherit',
    windowsHide: false,
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined) {
    process.stderr.write(`tt-stand: npm не запущен. ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
