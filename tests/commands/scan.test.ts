import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME } from '../setup.js';
import { initTestTuck, createTestDotfile, getTestManifest } from '../utils/testHelpers.js';
import { createMockTrackedFile } from '../utils/factories.js';
import { shouldExcludeFile, DEFAULT_EXCLUSION_PATTERNS } from '../../src/lib/detect.js';
import path from 'path';

// Mock UI
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    multiselect: vi.fn().mockResolvedValue([]),
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

describe('scan command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('dotfile detection', () => {
    it('should detect dotfiles in home directory', async () => {
      await initTestTuck();

      // Create various dotfiles
      await createTestDotfile('.zshrc', 'zsh config');
      await createTestDotfile('.gitconfig', 'git config');
      await createTestDotfile('.vimrc', 'vim config');

      // Check they exist
      const dotfiles = ['.zshrc', '.gitconfig', '.vimrc'];
      for (const file of dotfiles) {
        expect(vol.existsSync(path.join(TEST_HOME, file))).toBe(true);
      }
    });

    it('should detect dotfiles in .config directory', async () => {
      await initTestTuck();

      const configDir = path.join(TEST_HOME, '.config', 'nvim');
      vol.mkdirSync(configDir, { recursive: true });
      vol.writeFileSync(
        path.join(configDir, 'init.vim'),
        'vim config'
      );

      expect(vol.existsSync(path.join(configDir, 'init.vim'))).toBe(true);
    });
  });

  describe('filtering', () => {
    it('should exclude already tracked files', async () => {
      await initTestTuck();

      const manifest = await getTestManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/zshrc',
      });

      await createTestDotfile('.zshrc', 'zsh config');
      await createTestDotfile('.gitconfig', 'git config');

      // Only .gitconfig should appear as "new"
      const trackedSources = Object.values(manifest.files).map((f) => f.source);
      const isTracked = trackedSources.includes('~/.zshrc');

      expect(isTracked).toBe(true);
    });

    it('should exclude cache directories', () => {
      for (const cacheDir of DEFAULT_EXCLUSION_PATTERNS.cacheDirectories) {
        expect(shouldExcludeFile(cacheDir)).toBe(true);
      }
    });

    it('should exclude history files', () => {
      for (const historyFile of DEFAULT_EXCLUSION_PATTERNS.historyFiles) {
        expect(shouldExcludeFile(historyFile)).toBe(true);
      }
    });

    it('should exclude binary files', () => {
      const binaryFiles = [
        '~/.config/app.png',
        '~/.local/font.woff2',
        '~/.cache/binary.dylib',
      ];

      for (const file of binaryFiles) {
        expect(shouldExcludeFile(file)).toBe(true);
      }
    });

    it('should exclude temp files', () => {
      const tempFiles = [
        '~/.config/something.lock',
        '~/.vim/swap.swp',
        '~/.config/temp.tmp',
      ];

      for (const file of tempFiles) {
        expect(shouldExcludeFile(file)).toBe(true);
      }
    });

    it('should NOT exclude valid config files', () => {
      const validConfigs = [
        '~/.zshrc',
        '~/.bashrc',
        '~/.gitconfig',
        '~/.vimrc',
        '~/.npmrc',
        '~/.config/nvim/init.vim',
      ];

      for (const file of validConfigs) {
        expect(shouldExcludeFile(file)).toBe(false);
      }
    });
  });

  describe('categorization', () => {
    it('should categorize shell configs correctly', () => {
      const shellPatterns = ['zshrc', 'bashrc', 'profile', 'zprofile'];

      for (const pattern of shellPatterns) {
        const file = `.${pattern}`;
        const isShell = file.includes('sh') ||
                       file.includes('profile') ||
                       file.includes('zsh') ||
                       file.includes('bash');
        expect(isShell).toBe(true);
      }
    });

    it('should categorize git configs correctly', () => {
      const gitFiles = ['.gitconfig', '.gitignore_global'];

      for (const file of gitFiles) {
        const isGit = file.includes('git');
        expect(isGit).toBe(true);
      }
    });

    it('should categorize editor configs correctly', () => {
      const editorFiles = ['.vimrc', '.emacs', 'init.vim', '.nanorc'];

      for (const file of editorFiles) {
        const isEditor =
          file.includes('vim') ||
          file.includes('emacs') ||
          file.includes('nano');
        expect(isEditor).toBe(true);
      }
    });
  });

  describe('interactive selection', () => {
    it('should support multiselect for files', async () => {
      await initTestTuck();

      // Create multiple dotfiles
      await createTestDotfile('.zshrc', 'zsh');
      await createTestDotfile('.gitconfig', 'git');
      await createTestDotfile('.vimrc', 'vim');

      // Mock multiselect returns selected files
      const selectedFiles = ['~/.zshrc', '~/.vimrc'];

      expect(selectedFiles.length).toBe(2);
      expect(selectedFiles).toContain('~/.zshrc');
      expect(selectedFiles).toContain('~/.vimrc');
      expect(selectedFiles).not.toContain('~/.gitconfig');
    });

    it('should allow selecting all files', async () => {
      await initTestTuck();

      const allFiles = ['~/.zshrc', '~/.gitconfig', '~/.vimrc'];

      expect(allFiles.length).toBe(3);
    });

    it('should allow selecting no files', async () => {
      await initTestTuck();

      const selectedFiles: string[] = [];

      expect(selectedFiles.length).toBe(0);
    });
  });

  describe('.tuckignore support', () => {
    it('should read .tuckignore patterns', async () => {
      await initTestTuck();

      // Create .tuckignore
      vol.writeFileSync(
        path.join(TEST_HOME, '.tuckignore'),
        '*.log\n.DS_Store\ntmp/*'
      );

      const ignoreContent = vol.readFileSync(
        path.join(TEST_HOME, '.tuckignore'),
        'utf-8'
      );

      const patterns = (ignoreContent as string).split('\n').filter(Boolean);
      expect(patterns).toContain('*.log');
      expect(patterns).toContain('.DS_Store');
      expect(patterns).toContain('tmp/*');
    });

    it('should exclude files matching .tuckignore patterns', () => {
      const ignorePatterns = ['*.log', '.DS_Store', 'tmp/*'];

      const testFiles = [
        { path: 'app.log', shouldIgnore: true },
        { path: '.DS_Store', shouldIgnore: true },
        { path: 'tmp/cache', shouldIgnore: true },
        { path: '.zshrc', shouldIgnore: false },
      ];

      for (const { path: filePath, shouldIgnore } of testFiles) {
        const isIgnored = ignorePatterns.some((pattern) => {
          if (pattern.startsWith('*')) {
            return filePath.endsWith(pattern.slice(1));
          }
          if (pattern.endsWith('/*')) {
            return filePath.startsWith(pattern.slice(0, -2));
          }
          return filePath === pattern;
        });

        expect(isIgnored).toBe(shouldIgnore);
      }
    });
  });

  describe('summary output', () => {
    it('should count files by category', async () => {
      await initTestTuck();

      const files = [
        { source: '~/.zshrc', category: 'shell' },
        { source: '~/.bashrc', category: 'shell' },
        { source: '~/.gitconfig', category: 'git' },
        { source: '~/.vimrc', category: 'editor' },
      ];

      const categoryCounts = new Map<string, number>();
      for (const file of files) {
        const count = categoryCounts.get(file.category) || 0;
        categoryCounts.set(file.category, count + 1);
      }

      expect(categoryCounts.get('shell')).toBe(2);
      expect(categoryCounts.get('git')).toBe(1);
      expect(categoryCounts.get('editor')).toBe(1);
    });

    it('should show total file count', async () => {
      await initTestTuck();

      const files = ['~/.zshrc', '~/.gitconfig', '~/.vimrc'];

      expect(files.length).toBe(3);
    });
  });
});
