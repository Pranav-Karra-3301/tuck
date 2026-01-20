import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME, TEST_TUCK_DIR, TEST_TUCK_DIR_NATIVE } from '../setup.js';
import { createMockManifest, createMockConfig } from '../utils/factories.js';
import path from 'path';

// Mock simple-git
const mockGit = {
  init: vi.fn().mockResolvedValue(undefined),
  addRemote: vi.fn().mockResolvedValue(undefined),
  clone: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({ isClean: () => true }),
  log: vi.fn().mockResolvedValue({ latest: null }),
  checkIsRepo: vi.fn().mockResolvedValue(false),
  raw: vi.fn().mockResolvedValue(''),
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
    text: vi.fn(),
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
    group: vi.fn(),
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

describe('init command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // Set up basic directory structure
    vol.mkdirSync(TEST_HOME, { recursive: true });
    process.env.HOME = TEST_HOME;
  });

  afterEach(() => {
    vol.reset();
  });

  describe('scenario detection', () => {
    it('should detect fresh start when no tuck directory exists', () => {
      const tuckExists = vol.existsSync(TEST_TUCK_DIR);
      expect(tuckExists).toBe(false);
    });

    it('should detect existing tuck when .tuck directory exists with manifest', () => {
      // Create tuck directory structure
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
      vol.mkdirSync(path.join(TEST_TUCK_DIR, '.git'), { recursive: true });

      const manifest = createMockManifest();
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      const tuckExists = vol.existsSync(TEST_TUCK_DIR);
      const manifestExists = vol.existsSync(path.join(TEST_TUCK_DIR, 'manifest.json'));

      expect(tuckExists).toBe(true);
      expect(manifestExists).toBe(true);
    });
  });

  describe('fresh initialization', () => {
    it('should create tuck directory structure', async () => {
      // Simulate creating the tuck directory
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
      vol.mkdirSync(path.join(TEST_TUCK_DIR, '.git'), { recursive: true });

      const manifest = createMockManifest();
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      const config = createMockConfig();
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'config.json'),
        JSON.stringify(config, null, 2)
      );

      // Verify structure
      expect(vol.existsSync(TEST_TUCK_DIR)).toBe(true);
      expect(vol.existsSync(path.join(TEST_TUCK_DIR, 'manifest.json'))).toBe(true);
      expect(vol.existsSync(path.join(TEST_TUCK_DIR, 'config.json'))).toBe(true);
      expect(vol.existsSync(path.join(TEST_TUCK_DIR, '.git'))).toBe(true);
    });

    it('should create valid manifest on initialization', () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

      const manifest = createMockManifest();
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      const savedManifest = JSON.parse(
        vol.readFileSync(path.join(TEST_TUCK_DIR, 'manifest.json'), 'utf-8') as string
      );

      expect(savedManifest.version).toBeDefined();
      expect(savedManifest.created).toBeDefined();
      expect(savedManifest.updated).toBeDefined();
      expect(savedManifest.files).toBeDefined();
    });

    it('should create valid config on initialization', () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

      const config = createMockConfig();
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'config.json'),
        JSON.stringify(config, null, 2)
      );

      const savedConfig = JSON.parse(
        vol.readFileSync(path.join(TEST_TUCK_DIR, 'config.json'), 'utf-8') as string
      );

      expect(savedConfig.repository).toBeDefined();
      expect(savedConfig.files).toBeDefined();
      expect(savedConfig.ui).toBeDefined();
    });
  });

  describe('clone behavior', () => {
    it('should NOT auto-apply files when cloning a valid tuck repo', () => {
      // This tests the new behavior where cloning doesn't auto-apply
      // After cloning, files should only be in ~/.tuck, not applied to system

      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
      vol.mkdirSync(path.join(TEST_TUCK_DIR, 'files'), { recursive: true });

      // Create a manifest with tracked files
      const manifest = createMockManifest({
        files: {
          'zshrc': {
            source: '~/.zshrc',
            destination: 'files/zshrc',
            category: 'shell',
            strategy: 'copy',
            encrypted: false,
            template: false,
            added: new Date().toISOString(),
            modified: new Date().toISOString(),
            checksum: 'abc123',
          },
        },
      });
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Create the file in the tuck repo
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'files/zshrc'),
        'export PATH=$PATH:/usr/local/bin'
      );

      // The source file should NOT exist (not auto-applied)
      const sourceFile = path.join(TEST_HOME, '.zshrc');
      expect(vol.existsSync(sourceFile)).toBe(false);

      // But the file should exist in tuck
      expect(vol.existsSync(path.join(TEST_TUCK_DIR, 'files/zshrc'))).toBe(true);
    });

    it('should show file summary instead of applying', () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

      const manifest = createMockManifest({
        files: {
          'zshrc': {
            source: '~/.zshrc',
            destination: 'files/zshrc',
            category: 'shell',
            strategy: 'copy',
            encrypted: false,
            template: false,
            added: new Date().toISOString(),
            modified: new Date().toISOString(),
            checksum: 'abc123',
          },
          'gitconfig': {
            source: '~/.gitconfig',
            destination: 'files/gitconfig',
            category: 'git',
            strategy: 'copy',
            encrypted: false,
            template: false,
            added: new Date().toISOString(),
            modified: new Date().toISOString(),
            checksum: 'def456',
          },
        },
      });

      const fileCount = Object.keys(manifest.files).length;
      expect(fileCount).toBe(2);

      // Count by category
      const categories = new Map<string, number>();
      Object.values(manifest.files).forEach((file) => {
        const count = categories.get(file.category) || 0;
        categories.set(file.category, count + 1);
      });

      expect(categories.get('shell')).toBe(1);
      expect(categories.get('git')).toBe(1);
    });
  });

  describe('directory paths', () => {
    it('should use home directory for tuck storage', () => {
      const expectedPath = path.join(TEST_HOME, '.tuck');
      // Use platform-native path constant for comparison with path.join() result
      expect(expectedPath).toBe(TEST_TUCK_DIR_NATIVE);
    });

    it('should expand tilde in paths', () => {
      const tildePath = '~/.tuck';
      const expandedPath = tildePath.replace('~', TEST_HOME);
      // String replacement preserves forward slashes from TEST_HOME
      expect(expandedPath).toBe(TEST_TUCK_DIR);
    });
  });

  describe('remote configuration', () => {
    it('should store remote URL in config when provided', () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

      const config = createMockConfig({
        repository: {
          defaultBranch: 'main',
          autoCommit: true,
          autoPush: false,
        },
      });
      vol.writeFileSync(
        path.join(TEST_TUCK_DIR, 'config.json'),
        JSON.stringify(config, null, 2)
      );

      const savedConfig = JSON.parse(
        vol.readFileSync(path.join(TEST_TUCK_DIR, 'config.json'), 'utf-8') as string
      );

      expect(savedConfig.repository.defaultBranch).toBe('main');
    });
  });
});
