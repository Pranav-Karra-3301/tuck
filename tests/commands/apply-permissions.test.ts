/**
 * Manifest-permissions round-trip test for `tuck apply`.
 *
 * apply writes a file's resolved content via writeFile, which uses the process
 * umask default mode — it does NOT honor the manifest's recorded `permissions`.
 * So a 0755 script applied from a repo would land non-executable, and a 0600
 * file would land world-readable. apply must reapply the recorded permissions.
 *
 * Uses the same memfs + local-directory-source pattern as apply.test.ts; memfs
 * preserves chmod mode bits, and writes go to the mocked TEST_HOME (virtual),
 * never the real home.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const findPlaceholdersMock = vi.fn();
const restoreContentMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('replace'),
    multiselect: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    cyan: (x: string) => x,
  },
}));

vi.mock('../../src/lib/git.js', () => ({ cloneRepo: vi.fn() }));
vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn().mockResolvedValue(false),
  findDotfilesRepo: vi.fn().mockResolvedValue(null),
  ghCloneRepo: vi.fn(),
  repoExists: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: vi.fn().mockResolvedValue({ id: 'snapshot-test' }),
}));
vi.mock('../../src/lib/merge.js', () => ({
  smartMerge: vi.fn(async (_destination: string, content: string) => ({
    content,
    preservedBlocks: 0,
  })),
  isShellFile: vi.fn().mockReturnValue(false),
  generateMergePreview: vi.fn().mockResolvedValue(''),
}));
vi.mock('../../src/lib/secrets/index.js', () => ({
  findPlaceholders: findPlaceholdersMock,
  restoreContent: restoreContentMock,
  restoreFiles: vi.fn().mockResolvedValue({ totalRestored: 0, allUnresolved: [] }),
  getAllSecrets: vi.fn().mockResolvedValue({}),
  getSecretCount: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../src/lib/secretBackends/index.js', () => ({ createResolver: vi.fn() }));
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ security: { secretBackend: 'local' } }),
}));
vi.mock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));

describe('apply honors manifest permissions for non-ssh/gpg files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

    // Re-establish mock implementations cleared by clearAllMocks().
    findPlaceholdersMock.mockReturnValue([]);
    restoreContentMock.mockImplementation((content: string) => ({
      restoredContent: content,
      unresolved: [],
    }));
  });
  afterEach(() => vol.reset());

  it.skipIf(process.platform === 'win32')(
    'applies a 0755 script as executable',
    async () => {
      const localSrc = join(TEST_HOME, 'dotfiles-src');
      const manifest = createMockManifest({
        files: {
          script: createMockTrackedFile({
            source: '~/deploy.sh',
            destination: 'files/misc/deploy.sh',
            category: 'misc',
            permissions: '755',
          }),
        },
      });
      vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
      vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(localSrc, 'files', 'misc', 'deploy.sh'), '#!/bin/sh\n');

      const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
      setJsonMode(false);

      const { runApply } = await import('../../src/commands/apply.js');
      await runApply(localSrc, { replace: true });

      const target = join(TEST_HOME, 'deploy.sh');
      expect(vol.existsSync(target)).toBe(true);
      const mode = vol.statSync(target).mode & 0o777;
      expect(mode.toString(8)).toBe('755');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'applies a 0600 file without making it world-readable',
    async () => {
      const localSrc = join(TEST_HOME, 'dotfiles-src');
      const manifest = createMockManifest({
        files: {
          secret: createMockTrackedFile({
            source: '~/token.env',
            destination: 'files/misc/token.env',
            category: 'misc',
            permissions: '600',
          }),
        },
      });
      vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
      vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(localSrc, 'files', 'misc', 'token.env'), 'TOKEN=x\n');

      const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
      setJsonMode(false);

      const { runApply } = await import('../../src/commands/apply.js');
      await runApply(localSrc, { replace: true });

      const target = join(TEST_HOME, 'token.env');
      expect(vol.existsSync(target)).toBe(true);
      const mode = vol.statSync(target).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    }
  );
});
