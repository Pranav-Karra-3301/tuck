import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../setup.js';
import { initTestTuck, getTestConfig } from '../utils/testHelpers.js';
import { createMockConfig } from '../utils/factories.js';

// Mock modules
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    note: vi.fn(),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  banner: vi.fn(),
}));

const captureStdout = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
  return { writes, restore: () => writeSpy.mockRestore() };
};

const parseEnvelope = (writes: string[]): { ok: boolean; command: string; data: Record<string, unknown> } => {
  const lines = writes.join('').trim().split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]);
};

describe('config command', () => {
  beforeEach(async () => {
    vol.reset();
    vi.clearAllMocks();
    const { clearConfigCache } = await import('../../src/lib/config.js');
    clearConfigCache();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('config get', () => {
    it('should get a nested config value', async () => {
      const config = createMockConfig({
        repository: {
          defaultBranch: 'main',
          autoCommit: true,
          autoPush: false,
        },
      });
      await initTestTuck({ config });

      // Import the function after mocks are set up
      const { loadConfig } = await import('../../src/lib/config.js');
      const loadedConfig = await loadConfig(TEST_TUCK_DIR);

      expect(loadedConfig.repository.autoCommit).toBe(true);
      expect(loadedConfig.repository.autoPush).toBe(false);
    });

    it('reports value:null for an unknown key via config get --json', async () => {
      await initTestTuck({ config: createMockConfig() });

      const { configCommand } = await import('../../src/commands/config.js');
      const { restore, writes } = captureStdout();
      try {
        await configCommand.parseAsync(['get', 'does.not.exist', '--json'], {
          from: 'user',
        });
      } finally {
        restore();
      }

      // The real `config get` path (runConfigGet) resolves the missing nested key
      // and must emit an ok envelope carrying value:null — not throw, not omit it.
      const env = parseEnvelope(writes);
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck config get');
      expect(env.data).toEqual({ key: 'does.not.exist', value: null });
    });
  });

  describe('config set', () => {
    it('should set a boolean config value', async () => {
      await initTestTuck();

      const { loadConfig, saveConfig } = await import('../../src/lib/config.js');
      const config = await loadConfig(TEST_TUCK_DIR);

      config.repository.autoCommit = false;
      await saveConfig(config, TEST_TUCK_DIR);

      const updatedConfig = await loadConfig(TEST_TUCK_DIR);
      expect(updatedConfig.repository.autoCommit).toBe(false);
    });

    it('should set a string config value', async () => {
      await initTestTuck();

      const { loadConfig, saveConfig } = await import('../../src/lib/config.js');
      const config = await loadConfig(TEST_TUCK_DIR);

      config.repository.defaultBranch = 'develop';
      await saveConfig(config, TEST_TUCK_DIR);

      const updatedConfig = await loadConfig(TEST_TUCK_DIR);
      expect(updatedConfig.repository.defaultBranch).toBe('develop');
    });

    it('should set an enum config value', async () => {
      await initTestTuck();

      const { loadConfig, saveConfig } = await import('../../src/lib/config.js');
      const config = await loadConfig(TEST_TUCK_DIR);

      config.files.strategy = 'symlink';
      await saveConfig(config, TEST_TUCK_DIR);

      const updatedConfig = await loadConfig(TEST_TUCK_DIR);
      expect(updatedConfig.files.strategy).toBe('symlink');
    });
  });

  describe('config list', () => {
    it('should load full config with all sections', async () => {
      const config = createMockConfig({
        repository: {
          defaultBranch: 'main',
          autoCommit: true,
          autoPush: false,
        },
        files: {
          strategy: 'copy',
          backupOnRestore: true,
          backupDir: '.backups',
        },
        ui: {
          colors: true,
          emoji: true,
          verbose: false,
        },
      });
      await initTestTuck({ config });

      const loadedConfig = await getTestConfig();

      expect(loadedConfig.repository).toBeDefined();
      expect(loadedConfig.files).toBeDefined();
      expect(loadedConfig.ui).toBeDefined();
      expect(loadedConfig.hooks).toBeDefined();
      expect(loadedConfig.templates).toBeDefined();
      expect(loadedConfig.encryption).toBeDefined();
    });
  });

  describe('config reset', () => {
    it('should reset config to defaults', async () => {
      const config = createMockConfig({
        repository: {
          defaultBranch: 'custom-branch',
          autoCommit: false,
          autoPush: true,
        },
      });
      await initTestTuck({ config });

      const { resetConfig, loadConfig } = await import('../../src/lib/config.js');
      await resetConfig(TEST_TUCK_DIR);

      const resetConfigAfter = await loadConfig(TEST_TUCK_DIR);
      expect(resetConfigAfter.repository.defaultBranch).toBe('main');
      expect(resetConfigAfter.repository.autoCommit).toBe(true);
    });
  });

  describe('CONFIG_KEYS metadata', () => {
    // CONFIG_KEYS is not exported by the command module, so we assert the metadata
    // stays coherent with the real config schema indirectly: every declared key
    // path must be resolvable via the production `config get` code path and return
    // a value of the declared type. A stale/renamed key, or a type that drifted
    // from the schema, makes the matching case fail here.
    const DECLARED_KEYS: { path: string; type: 'boolean' | 'string' | 'enum' }[] = [
      { path: 'repository.defaultBranch', type: 'string' },
      { path: 'repository.autoCommit', type: 'boolean' },
      { path: 'repository.autoPush', type: 'boolean' },
      { path: 'files.strategy', type: 'enum' },
      { path: 'files.backupOnRestore', type: 'boolean' },
      { path: 'files.backupDir', type: 'string' },
      { path: 'ui.colors', type: 'boolean' },
      { path: 'ui.emoji', type: 'boolean' },
      { path: 'ui.verbose', type: 'boolean' },
      { path: 'hooks.preSync', type: 'string' },
      { path: 'hooks.postSync', type: 'string' },
      { path: 'hooks.preRestore', type: 'string' },
      { path: 'hooks.postRestore', type: 'string' },
      { path: 'encryption.backupsEnabled', type: 'boolean' },
    ];

    it('loads the command and names it "config"', async () => {
      const configModule = await import('../../src/commands/config.js');
      expect(configModule.configCommand).toBeDefined();
      expect(configModule.configCommand.name()).toBe('config');
    });

    it('resolves every declared key to a value of its declared type via config get', async () => {
      // Fully populate every declared key so `config get` returns a concrete value
      // (hooks default to unset). Enum/string/boolean all map to JS primitives.
      const config = createMockConfig({
        hooks: {
          preSync: 'echo pre-sync',
          postSync: 'echo post-sync',
          preRestore: 'echo pre-restore',
          postRestore: 'echo post-restore',
        },
      });
      await initTestTuck({ config });

      const { configCommand } = await import('../../src/commands/config.js');
      const { clearConfigCache } = await import('../../src/lib/config.js');

      for (const { path, type } of DECLARED_KEYS) {
        clearConfigCache();
        const { restore, writes } = captureStdout();
        try {
          await configCommand.parseAsync(['get', path, '--json'], { from: 'user' });
        } finally {
          restore();
        }
        const env = parseEnvelope(writes);
        expect(env.ok, `config get ${path} should succeed`).toBe(true);
        expect(env.data.key).toBe(path);
        // A declared key must resolve — never null — against the real config.
        expect(env.data.value, `${path} should resolve to a value`).not.toBeNull();
        const jsType = type === 'enum' ? 'string' : type;
        expect(typeof env.data.value, `${path} should be ${jsType}`).toBe(jsType);
      }
    });
  });

  describe('--json envelope output', () => {
    // loadConfig caches by tuckDir at the module level, so a prior `set` test
    // can leave a stale config in cache. Clear it before each case so the
    // command reads the freshly written file from memfs.
    beforeEach(async () => {
      const { clearConfigCache } = await import('../../src/lib/config.js');
      clearConfigCache();
    });

    it('emits { key, value } for config get --json', async () => {
      const config = createMockConfig({
        repository: {
          defaultBranch: 'main',
          autoCommit: true,
          autoPush: false,
        },
      });
      await initTestTuck({ config });

      const { configCommand } = await import('../../src/commands/config.js');
      const { restore, writes } = captureStdout();
      try {
        await configCommand.parseAsync(['get', 'repository.autoCommit', '--json'], {
          from: 'user',
        });
      } finally {
        restore();
      }

      const env = parseEnvelope(writes);
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck config get');
      expect(env.data).toEqual({ key: 'repository.autoCommit', value: true });
    });

    it('emits { key, value, updated } for config set --json', async () => {
      await initTestTuck();

      const { configCommand } = await import('../../src/commands/config.js');
      const { restore, writes } = captureStdout();
      try {
        await configCommand.parseAsync(
          ['set', 'repository.autoCommit', 'false', '--json'],
          { from: 'user' }
        );
      } finally {
        restore();
      }

      const env = parseEnvelope(writes);
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck config set');
      expect(env.data).toEqual({
        key: 'repository.autoCommit',
        value: false,
        updated: true,
      });

      const { loadConfig } = await import('../../src/lib/config.js');
      const updated = await loadConfig(TEST_TUCK_DIR);
      expect(updated.repository.autoCommit).toBe(false);
    });

    it('emits { config } for config list --json', async () => {
      const config = createMockConfig({
        repository: {
          defaultBranch: 'main',
          autoCommit: true,
          autoPush: false,
        },
      });
      await initTestTuck({ config });

      const { configCommand } = await import('../../src/commands/config.js');
      const { restore, writes } = captureStdout();
      try {
        await configCommand.parseAsync(['list', '--json'], {
          from: 'user',
        });
      } finally {
        restore();
      }

      const env = parseEnvelope(writes);
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck config list');
      expect(env.data.config).toBeDefined();
      expect(env.data.config.repository.autoCommit).toBe(true);
      expect(env.data.config.repository.defaultBranch).toBe('main');
    });
  });

  describe('nested value helpers', () => {
    it('should correctly get nested values', async () => {
      const config = createMockConfig({
        hooks: {
          preSync: 'echo "pre-sync"',
          postSync: 'echo "post-sync"',
        },
      });
      await initTestTuck({ config });

      const loadedConfig = await getTestConfig();
      expect(loadedConfig.hooks.preSync).toBe('echo "pre-sync"');
      expect(loadedConfig.hooks.postSync).toBe('echo "post-sync"');
    });

    it('should handle undefined nested values', async () => {
      await initTestTuck();

      const loadedConfig = await getTestConfig();
      expect(loadedConfig.hooks.preSync).toBeUndefined();
      expect(loadedConfig.hooks.postSync).toBeUndefined();
    });
  });
});
