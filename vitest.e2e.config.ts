import { defineConfig } from 'vitest/config';

/**
 * End-to-end config: spawns the REAL built binary (dist/index.js) against a
 * REAL temp HOME. Deliberately has NO setupFiles — it must NOT load
 * tests/setup.ts, whose global vi.mock(fs|fs/promises|fs-extra|os) would confine
 * the PARENT test to memfs while the spawned child writes to the real disk (two
 * different filesystems → unobservable). Real fs/os is required here.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    setupFiles: [], // the whole point: no memfs / os mock
    testTimeout: 60_000, // child spawn + (optional) real git is slow vs unit tests
    hookTimeout: 180_000, // beforeAll may build the binary
    // Each spawn is an isolated OS process; in-process pooling buys nothing and a
    // single fork avoids cross-test cwd/env interference.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { shuffle: false },
  },
});
