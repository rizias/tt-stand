import tseslint from 'typescript-eslint';

const referenceDirective = /^\/\s*<reference(?:\s|>|$)/;
const lineDirective = [
  /^(?:@ts-|prettier-|biome-|vitest-|@vitest-)/,
  /^(?:ts-nocheck|ts-check|istanbul|c8|v8)(?:$|\s)/,
];
const blockDirective = /^(?:istanbul|c8|v8)(?:$|\s)|^(?:@ts-|prettier-)/;

export const noComments = {
  meta: {
    type: 'problem',
    messages: {
      forbidden: 'comment is not allowed: only a shebang, tool directives and owner: marks',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === 'Shebang') continue;
          const value = comment.value.trim();
          const allowed = value.startsWith('owner:') || (comment.type === 'Line'
            ? referenceDirective.test(comment.value) || lineDirective.some((directive) => directive.test(value))
            : comment.type === 'Block' && blockDirective.test(value));
          if (!allowed) {
            context.report({ loc: comment.loc, messageId: 'forbidden' });
          }
        }
      },
    };
  },
};

export const ownerPaths = [];

export function buildConfig(ownerPaths) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', '.claude/**'] },
    ...tseslint.configs.recommended,
    {
      linterOptions: { noInlineConfig: true },
      plugins: {
        local: {
          rules: {
            'no-comments': noComments,
          },
        },
      },
      rules: {
        'local/no-comments': 'error',
        complexity: ['error', 15],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    ...(ownerPaths.length > 0 ? [{
      files: ownerPaths,
      rules: { 'local/no-comments': 'off' },
    }] : []),
  );
}

export default buildConfig(ownerPaths);
