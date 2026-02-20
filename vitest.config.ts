import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'tests',
        'dist',
        '**/*.d.ts',
        '**/*.test.ts',
      ],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 40,
        branches: 75,
        functions: 34,
        lines: 40,
      },
    },
    testTimeout: 10000,
    mockReset: true,
    restoreMocks: true,
    // Isolate test files to prevent mock leakage between suites.
    isolate: true,
  },
});
