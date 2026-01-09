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
    },
    testTimeout: 10000,
    mockReset: true,
    restoreMocks: true,
    // Rely on mock and setup resets to prevent state leakage; avoid per-file worker isolation for performance
    isolate: false,
  },
});
