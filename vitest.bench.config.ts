import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for performance benchmarks.
 *
 * Key differences from regular tests:
 * - Uses real filesystem (not memfs) for accurate I/O measurements
 * - Longer timeouts for stress tests
 * - Benchmark-specific reporters
 * - Uses 'threads' pool for better async support
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/benchmarks/**/*.bench.ts'],
    // Benchmarks use real filesystem, not mocked
    setupFiles: ['./tests/benchmarks/setup.ts'],
    // Longer timeout for performance tests
    testTimeout: 60000,
    hookTimeout: 30000,
    // Benchmark-specific settings
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      reporters: ['default'],
      outputFile: './benchmark-results.json',
    },
    // Use threads pool for better async benchmark support
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // Run benchmarks in single thread for consistency
      },
    },
    // Ensure proper sequencing
    sequence: {
      shuffle: false,
    },
  },
});
