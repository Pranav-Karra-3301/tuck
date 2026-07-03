/**
 * Config write-path cache-invalidation regression — BATCH W4-D.
 *
 * `saveConfig` updates the in-memory config cache to the value it just wrote.
 * That is correct for the value tuck itself wrote, but it means a config write
 * via the `config set` command leaves a populated cache; if the on-disk config
 * is then changed out-of-band (or another code path expects a fresh read), the
 * stale cache masks the new state for the rest of the run.
 *
 * The fix wires clearConfigCache() into the config write paths so a fresh
 * loadConfig() re-reads disk. This test pins that property: after `config set`,
 * an out-of-band edit to the config file must be observed by loadConfig().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR } from '../setup.js';
import { initTestTuck } from '../utils/testHelpers.js';

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), warning: vi.fn() },
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
  },
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  banner: vi.fn(),
  colors: new Proxy({}, { get: () => (x: string) => x }),
}));

const CONFIG_PATH = join(TEST_TUCK_DIR, '.tuckrc.json');

describe('config set cache invalidation', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vol.reset();
    const { clearConfigCache } = await import('../../src/lib/config.js');
    clearConfigCache();
  });

  it('clears the config cache after `config set` so an out-of-band edit is observed', async () => {
    await initTestTuck();

    const { loadConfig, clearConfigCache } = await import('../../src/lib/config.js');
    // Start from a clean cache so we know the cache state is owned by this test.
    clearConfigCache();

    // Warm the cache to the pre-set value.
    const before = await loadConfig(TEST_TUCK_DIR);
    expect(before.repository.autoCommit).not.toBe(false);

    // Run `config set` — this used to leave a populated cache.
    const { runConfigSet } = await import('../../src/commands/config.js');
    await runConfigSet('repository.autoCommit', 'false', {});

    // Simulate an out-of-band rewrite of the config file (e.g. a clone/pull or a
    // concurrent editor) that flips the value to true again.
    const onDisk = JSON.parse(vol.readFileSync(CONFIG_PATH, 'utf-8') as string);
    onDisk.repository.autoCommit = true;
    vol.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2));

    // A fresh load MUST reflect the on-disk value, not the cached post-set value.
    const after = await loadConfig(TEST_TUCK_DIR);
    expect(after.repository.autoCommit).toBe(true);
  });
});
