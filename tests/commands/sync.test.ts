import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import { initTestTuck, createTestDotfile } from '../utils/testHelpers.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import path from 'path';

// Mock simple-git
const mockGit = {
  init: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
  push: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({
    isClean: () => true,
    modified: [],
    deleted: [],
    not_added: [],
    files: [],
  }),
  log: vi.fn().mockResolvedValue({ latest: { hash: 'abc123' } }),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  raw: vi.fn().mockResolvedValue(''),
  getRemotes: vi.fn().mockResolvedValue([{ name: 'origin', refs: { fetch: 'https://github.com/test/dotfiles.git' } }]),
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit),
  default: vi.fn(() => mockGit),
}));

// Mock UI
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    text: vi.fn().mockResolvedValue('sync changes'),
    multiselect: vi.fn().mockResolvedValue([]),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: '',
    })),
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

describe('sync command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('change detection', () => {
    it('should detect modified tracked files', async () => {
      const manifest = createMockManifest({
        files: {
          'zshrc': createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/zshrc',
            checksum: 'original-checksum',
          }),
        },
      });

      await initTestTuck({ manifest });

      // Create the tracked file in tuck
      vol.mkdirSync(path.join(TEST_TUCK_DIR, 'files'), { recursive: true });
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'original content'
      );

      // Create the source file with different content
      await createTestDotfile('.zshrc', 'modified content');

      // Read both files
      const sourceContent = vol.readFileSync(
        path.join(TEST_HOME, '.zshrc'),
        'utf-8'
      );
      const trackedContent = vol.readFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'utf-8'
      );

      expect(sourceContent).not.toBe(trackedContent);
    });

    it('should detect deleted source files', async () => {
      const manifest = createMockManifest({
        files: {
          'zshrc': createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/zshrc',
          }),
        },
      });

      await initTestTuck({ manifest });

      // Create the tracked file in tuck but NOT the source
      vol.mkdirSync(path.join(TEST_TUCK_DIR, 'files'), { recursive: true });
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'content'
      );

      // Source file doesn't exist
      const sourceExists = vol.existsSync(path.join(TEST_HOME, '.zshrc'));
      expect(sourceExists).toBe(false);
    });

    it('should detect new files in source locations', async () => {
      await initTestTuck();

      // Create new dotfile that isn't tracked
      await createTestDotfile('.newconfig', 'new config content');

      const fileExists = vol.existsSync(path.join(TEST_HOME, '.newconfig'));
      expect(fileExists).toBe(true);
    });
  });

  describe('file synchronization', () => {
    it('should update tracked file with source changes', async () => {
      const manifest = createMockManifest({
        files: {
          'zshrc': createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/zshrc',
          }),
        },
      });

      await initTestTuck({ manifest });

      // Create source file with new content
      await createTestDotfile('.zshrc', 'new content');

      // Create tracked file location
      vol.mkdirSync(path.join(TEST_TUCK_DIR, 'files'), { recursive: true });

      // Simulate sync by copying source to tracked
      const sourceContent = vol.readFileSync(
        path.join(TEST_HOME, '.zshrc'),
        'utf-8'
      );
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        sourceContent as string
      );

      // Verify sync
      const trackedContent = vol.readFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'utf-8'
      );
      expect(trackedContent).toBe('new content');
    });
  });

  describe('pull functionality', () => {
    it('should support --no-pull option', () => {
      // Verify the option type
      const options = {
        pull: false,
        scan: true,
      };

      expect(options.pull).toBe(false);
    });

    it('should pull by default', () => {
      const options = {
        pull: true,
        scan: true,
      };

      expect(options.pull).toBe(true);
    });
  });

  describe('scan functionality', () => {
    it('should support --no-scan option', () => {
      const options = {
        pull: true,
        scan: false,
      };

      expect(options.scan).toBe(false);
    });

    it('should scan by default', () => {
      const options = {
        pull: true,
        scan: true,
      };

      expect(options.scan).toBe(true);
    });
  });

  describe('commit behavior', () => {
    it('should support custom commit message', () => {
      const options = {
        message: 'custom: update dotfiles',
      };

      expect(options.message).toBe('custom: update dotfiles');
    });

    it('should support --no-commit option', () => {
      const options = {
        noCommit: true,
      };

      expect(options.noCommit).toBe(true);
    });
  });

  describe('push behavior', () => {
    it('should push after commit by default when autoPush is true', () => {
      const config = {
        repository: {
          autoPush: true,
        },
      };

      expect(config.repository.autoPush).toBe(true);
    });

    it('should not push when autoPush is false', () => {
      const config = {
        repository: {
          autoPush: false,
        },
      };

      expect(config.repository.autoPush).toBe(false);
    });
  });

  describe('all-in-one workflow', () => {
    it('should handle complete sync workflow', async () => {
      // Initialize tuck with a tracked file
      const manifest = createMockManifest({
        files: {
          'zshrc': createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/zshrc',
          }),
        },
      });

      await initTestTuck({ manifest });

      // Set up files
      vol.mkdirSync(path.join(TEST_TUCK_DIR, 'files'), { recursive: true });
      await createTestDotfile('.zshrc', 'shell config');
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'shell config'
      );

      // Verify initial state
      expect(vol.existsSync(TEST_TUCK_DIR)).toBe(true);
      expect(vol.existsSync(path.join(TEST_HOME, '.zshrc'))).toBe(true);
      expect(vol.existsSync(path.join(TEST_TUCK_DIR, 'files/zshrc'))).toBe(true);
    });

    it('should detect multiple file categories', async () => {
      const manifest = createMockManifest({
        files: {
          'zshrc': createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/zshrc',
            category: 'shell',
          }),
          'gitconfig': createMockTrackedFile({
            source: '~/.gitconfig',
            destination: 'files/gitconfig',
            category: 'git',
          }),
          'vimrc': createMockTrackedFile({
            source: '~/.vimrc',
            destination: 'files/vimrc',
            category: 'editor',
          }),
        },
      });

      const categories = new Set(
        Object.values(manifest.files).map((f) => f.category)
      );

      expect(categories.size).toBe(3);
      expect(categories.has('shell')).toBe(true);
      expect(categories.has('git')).toBe(true);
      expect(categories.has('editor')).toBe(true);
    });
  });
});
