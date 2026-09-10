import { execFileSync } from 'node:child_process';

function tryRun(args) {
  try {
    execFileSync('gitleaks', args, { stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    process.exit(e.status ?? 1);
  }
}

let ran = tryRun(['protect', '--staged', '--redact']);
if (ran === null) {
  console.log('gitleaks-if-present: gitleaks binary not installed - secret scan SKIPPED (not verified).');
  process.exit(0);
}
