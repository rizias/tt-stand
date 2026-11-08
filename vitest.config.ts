import { defineConfig } from 'vitest/config';

const processTests = [
  'test/batch.test.ts',
  'test/batchReport.test.ts',
  'test/cli.test.ts',
  'test/configConcurrency.test.ts',
  'test/configProfiles.test.ts',
  'test/flagForms.test.ts',
  'test/ignoredFlagsCli.test.ts',
  'test/init.test.ts',
  'test/journalSecrecy.test.ts',
  'test/mongoIntegration.test.ts',
  'test/reportUx.test.ts',
  'test/update.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...processTests, '**/node_modules/**', '**/.git/**'],
        },
      },
      {
        test: {
          name: 'process',
          include: processTests,
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
