import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint, type Linter } from 'eslint';

const configModule = (await import('../eslint.config.js')) as unknown as {
  buildConfig: (ownerPaths: string[]) => Linter.Config[];
};
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: configModule.buildConfig([]),
});

async function lintText(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

function commentMessages(result: ESLint.LintResult | undefined) {
  return (result?.messages ?? []).filter(({ ruleId }) => ruleId === 'local/no-comments');
}

test('обычный комментарий — ошибка правила local/no-comments', async () => {
  const result = await lintText('// note\nexport const value = 1;\n', 'a.ts');
  assert.equal(commentMessages(result).length, 1);
});

test('директива отключения правила не действует и сама считается комментарием', async () => {
  const result = await lintText(
    '// eslint-disable-next-line local/no-comments\n// prose\nexport const value = 1;\n',
    'a.ts',
  );
  assert.deepEqual(
    commentMessages(result).map(({ line }) => line),
    [1, 2],
  );
  assert.equal((result?.suppressedMessages ?? []).length, 0);
});

test('шебанг, директива TypeScript и маркер владельца разрешены', async () => {
  const result = await lintText(
    '#!/usr/bin/env node\n// @ts-expect-error: reason\n// owner: reason\nexport const value = 1;\n',
    'a.js',
  );
  assert.equal(commentMessages(result).length, 0);
});
