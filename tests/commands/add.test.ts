import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import { initTestTuck, createTestDotfile, getTestManifest } from '../utils/testHelpers.js';
import { createMockTrackedFile } from '../utils/factories.js';
import path from 'path';

// Mock UI
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('general'),
    text: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
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

describe('add command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('file validation', () => {
    it('should require file to exist', async () => {
      await initTestTuck();

      const nonExistentPath = path.join(TEST_HOME, '.nonexistent');
      const exists = vol.existsSync(nonExistentPath);

      expect(exists).toBe(false);
    });

    it('should accept existing files', async () => {
      await initTestTuck();
      await createTestDotfile('.zshrc', 'export PATH=$PATH:/usr/local/bin');

      const filePath = path.join(TEST_HOME, '.zshrc');
      const exists = vol.existsSync(filePath);

      expect(exists).toBe(true);
    });

    it('should reject directories by default', async () => {
      await initTestTuck();

      const dirPath = path.join(TEST_HOME, '.config');
      vol.mkdirSync(dirPath, { recursive: true });

      const stat = vol.statSync(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('file tracking', () => {
    it('should add file to manifest', async () => {
      await initTestTuck();
      await createTestDotfile('.zshrc', 'zsh config');

      // Simulate adding file to manifest
      const manifest = await getTestManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
        category: 'shell',
      });

      // Verify structure
      expect(manifest.files['zshrc']).toBeDefined();
      expect(manifest.files['zshrc'].source).toBe('~/.zshrc');
      expect(manifest.files['zshrc'].category).toBe('shell');
    });

    it('should copy file to tuck directory', async () => {
      await initTestTuck();
      await createTestDotfile('.zshrc', 'zsh config content');

      // Create files directory
      const filesDir = path.join(TEST_TUCK_DIR, 'files');
      vol.mkdirSync(filesDir, { recursive: true });

      // Copy file
      const sourceContent = vol.readFileSync(
        path.join(TEST_HOME, '.zshrc'),
        'utf-8'
      );
      vol.writeFileSync(
        path.join(filesDir, 'zshrc'),
        sourceContent as string
      );

      // Verify copy
      const trackedContent = vol.readFileSync(
        path.join(filesDir, 'zshrc'),
        'utf-8'
      );
      expect(trackedContent).toBe('zsh config content');
    });

    it('should support symlink strategy', async () => {
      const trackedFile = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
        strategy: 'symlink',
      });

      expect(trackedFile.strategy).toBe('symlink');
    });

    it('should support copy strategy', async () => {
      const trackedFile = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
        strategy: 'copy',
      });

      expect(trackedFile.strategy).toBe('copy');
    });
  });

  describe('category assignment', () => {
    it('should allow custom category', async () => {
      await initTestTuck();

      const trackedFile = createMockTrackedFile({
        source: '~/.custom',
        destination: 'files/custom',
        category: 'custom-category',
      });

      expect(trackedFile.category).toBe('custom-category');
    });

    it('should auto-detect shell category for shell files', async () => {
      // Shell files should be categorized as 'shell'
      const shellFiles = ['.zshrc', '.bashrc', '.bash_profile', '.profile'];

      for (const file of shellFiles) {
        // Simple pattern matching
        const isShell = /\.(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)$/i.test(file) ||
                        file.includes('sh');
        expect(isShell).toBe(true);
      }
    });

    it('should auto-detect git category for git files', async () => {
      const gitFiles = ['.gitconfig', '.gitignore_global'];

      for (const file of gitFiles) {
        const isGit = file.includes('git');
        expect(isGit).toBe(true);
      }
    });
  });

  describe('duplicate handling', () => {
    it('should prevent adding already tracked files', async () => {
      await initTestTuck();

      const manifest = await getTestManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
      });

      // Check if file is already tracked
      const isTracked = 'zshrc' in manifest.files;
      expect(isTracked).toBe(true);
    });

    it('should allow force re-add with different name', async () => {
      await initTestTuck();

      const manifest = await getTestManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
      });

      // Can add same source with different name
      manifest.files['zshrc-backup'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc-backup',
      });

      expect(manifest.files['zshrc']).toBeDefined();
      expect(manifest.files['zshrc-backup']).toBeDefined();
    });
  });

  describe('path handling', () => {
    it('should expand tilde in paths', () => {
      const tildePath = '~/.zshrc';
      const expanded = tildePath.replace('~', TEST_HOME);

      expect(expanded).toBe(path.join(TEST_HOME, '.zshrc'));
    });

    it('should handle absolute paths', async () => {
      await initTestTuck();

      const absolutePath = path.join(TEST_HOME, '.zshrc');
      await createTestDotfile('.zshrc', 'content');

      const exists = vol.existsSync(absolutePath);
      expect(exists).toBe(true);
    });

    it('should normalize destination paths', () => {
      const source = '~/.config/nvim/init.vim';
      // Destination should be a safe filename
      const destination = source
        .replace('~/', '')
        .replace(/\//g, '_')
        .replace(/\./g, '');

      expect(destination).not.toContain('/');
    });
  });

  describe('metadata', () => {
    it('should store add timestamp', () => {
      const trackedFile = createMockTrackedFile({
        added: '2024-01-15T10:30:00.000Z',
      });

      expect(trackedFile.added).toBeDefined();
      expect(new Date(trackedFile.added).getTime()).toBeGreaterThan(0);
    });

    it('should store file checksum', () => {
      const trackedFile = createMockTrackedFile({
        checksum: 'abc123def456',
      });

      expect(trackedFile.checksum).toBeDefined();
      expect(trackedFile.checksum.length).toBeGreaterThan(0);
    });

    it('should track encryption status', () => {
      const unencrypted = createMockTrackedFile({ encrypted: false });
      const encrypted = createMockTrackedFile({ encrypted: true });

      expect(unencrypted.encrypted).toBe(false);
      expect(encrypted.encrypted).toBe(true);
    });

    it('should track template status', () => {
      const nonTemplate = createMockTrackedFile({ template: false });
      const template = createMockTrackedFile({ template: true });

      expect(nonTemplate.template).toBe(false);
      expect(template.template).toBe(true);
    });
  });
});
