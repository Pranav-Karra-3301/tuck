/**
 * Extended paths module unit tests
 *
 * Tests for path safety validation and utility functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  expandPath,
  collapsePath,
  getTuckDir,
  getManifestPath,
  getConfigPath,
  getFilesDir,
  getCategoryDir,
  getDestinationPath,
  getDestinationPathFromSource,
  getHomeRelativeSourcePath,
  getRelativeDestination,
  getRelativeDestinationFromSource,
  sanitizeFilename,
  detectCategory,
  pathExists,
  isDirectory,
  isFile,
  isSymlink,
  isReadable,
  isWritable,
  getRelativePath,
  isPathWithinHome,
  validateSafeSourcePath,
  validateSafeDestinationPath,
  validatePathWithinRoot,
  validateSafeManifestDestination,
  generateFileId,
} from '../../src/lib/paths.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

describe('paths-extended', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // Path Existence and Type Tests
  // ============================================================================

  describe('pathExists', () => {
    it('should return true for existing file', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'content');

      const exists = await pathExists(filePath);

      expect(exists).toBe(true);
    });

    it('should return true for existing directory', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);

      const exists = await pathExists(dirPath);

      expect(exists).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      const exists = await pathExists(join(TEST_HOME, 'nonexistent'));

      expect(exists).toBe(false);
    });
  });

  describe('isDirectory', () => {
    it('should return true for directory', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);

      const result = await isDirectory(dirPath);

      expect(result).toBe(true);
    });

    it('should return false for file', async () => {
      const filePath = join(TEST_HOME, 'file.txt');
      vol.writeFileSync(filePath, 'content');

      const result = await isDirectory(filePath);

      expect(result).toBe(false);
    });

    it('should return false for non-existent path', async () => {
      const result = await isDirectory(join(TEST_HOME, 'nonexistent'));

      expect(result).toBe(false);
    });
  });

  describe('isFile', () => {
    it('should return true for file', async () => {
      const filePath = join(TEST_HOME, 'file.txt');
      vol.writeFileSync(filePath, 'content');

      const result = await isFile(filePath);

      expect(result).toBe(true);
    });

    it('should return false for directory', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);

      const result = await isFile(dirPath);

      expect(result).toBe(false);
    });

    it('should return false for non-existent path', async () => {
      const result = await isFile(join(TEST_HOME, 'nonexistent'));

      expect(result).toBe(false);
    });
  });

  describe('isReadable', () => {
    it('should return true for readable file', async () => {
      const filePath = join(TEST_HOME, 'readable.txt');
      vol.writeFileSync(filePath, 'content');

      const result = await isReadable(filePath);

      expect(result).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const result = await isReadable(join(TEST_HOME, 'nonexistent'));

      expect(result).toBe(false);
    });
  });

  describe('isWritable', () => {
    it('should return true for writable file', async () => {
      const filePath = join(TEST_HOME, 'writable.txt');
      vol.writeFileSync(filePath, 'content');

      const result = await isWritable(filePath);

      expect(result).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const result = await isWritable(join(TEST_HOME, 'nonexistent'));

      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // Path Helper Functions
  // ============================================================================

  describe('getTuckDir', () => {
    it('should return default tuck directory', () => {
      const tuckDir = getTuckDir();
      expect(tuckDir).toContain('.tuck');
    });

    it('should return custom directory when provided', () => {
      const customDir = join(TEST_HOME, 'custom-tuck');
      const tuckDir = getTuckDir(customDir);
      expect(tuckDir).toBe(customDir);
    });

    it('should reject custom directory paths outside home', () => {
      if (process.platform !== 'win32') {
        expect(() => getTuckDir('/etc/tuck')).toThrow('custom tuck directory must be within home');
      }
    });
  });

  describe('getManifestPath', () => {
    it('should return path to manifest file', () => {
      const manifestPath = getManifestPath(TEST_TUCK_DIR);
      expect(manifestPath).toBe(join(TEST_TUCK_DIR, '.tuckmanifest.json'));
    });
  });

  describe('getConfigPath', () => {
    it('should return path to config file', () => {
      const configPath = getConfigPath(TEST_TUCK_DIR);
      expect(configPath).toBe(join(TEST_TUCK_DIR, '.tuckrc.json'));
    });
  });

  describe('getFilesDir', () => {
    it('should return path to files directory', () => {
      const filesDir = getFilesDir(TEST_TUCK_DIR);
      expect(filesDir).toBe(join(TEST_TUCK_DIR, 'files'));
    });
  });

  describe('getCategoryDir', () => {
    it('should return path to category directory', () => {
      const categoryDir = getCategoryDir(TEST_TUCK_DIR, 'shell');
      expect(categoryDir).toBe(join(TEST_TUCK_DIR, 'files', 'shell'));
    });
  });

  describe('getDestinationPath', () => {
    it('should return full destination path', () => {
      const destPath = getDestinationPath(TEST_TUCK_DIR, 'shell', 'zshrc');
      expect(destPath).toBe(join(TEST_TUCK_DIR, 'files', 'shell', 'zshrc'));
    });
  });

  describe('getRelativeDestination', () => {
    it('should return relative path within files directory', () => {
      const relPath = getRelativeDestination('git', 'gitconfig');
      expect(relPath.replace(/\\/g, '/')).toBe('files/git/gitconfig');
    });

    it('should always use POSIX separators for manifest paths', () => {
      const relPath = getRelativeDestination('shell', 'nested\\zshrc');
      expect(relPath).toBe('files/shell/nested/zshrc');
      expect(relPath.includes('\\')).toBe(false);
    });
  });

  describe('getHomeRelativeSourcePath', () => {
    it('should return source path relative to home', () => {
      expect(getHomeRelativeSourcePath('~/.config/nvim/init.vim')).toBe('.config/nvim/init.vim');
    });

    it('should reject source paths outside home', () => {
      if (process.platform !== 'win32') {
        expect(() => getHomeRelativeSourcePath('/etc/passwd')).toThrow(
          'source path must be within home directory'
        );
      }
    });
  });

  describe('getRelativeDestinationFromSource', () => {
    it('should preserve source directory structure to avoid collisions', () => {
      const awsPath = getRelativeDestinationFromSource('misc', '~/.aws/config');
      const kubePath = getRelativeDestinationFromSource('misc', '~/.kube/config');

      expect(awsPath).toBe('files/misc/.aws/config');
      expect(kubePath).toBe('files/misc/.kube/config');
      expect(awsPath).not.toBe(kubePath);
    });
  });

  describe('getDestinationPathFromSource', () => {
    it('should return full destination path with nested source segments', () => {
      const destination = getDestinationPathFromSource(TEST_TUCK_DIR, 'shell', '~/.zshrc');
      expect(destination.replace(/\\/g, '/')).toBe(`${TEST_TUCK_DIR}/files/shell/.zshrc`);
    });
  });

  describe('getRelativePath', () => {
    it('should return relative path from one file to another', () => {
      const from = join(TEST_HOME, 'dir1', 'file1.txt');
      const to = join(TEST_HOME, 'dir2', 'file2.txt');

      const relPath = getRelativePath(from, to);

      expect(relPath).toContain('dir2');
      expect(relPath).toContain('file2.txt');
    });
  });

  // ============================================================================
  // Path Security Tests
  // ============================================================================

  describe('isPathWithinHome', () => {
    it('should return true for paths within home directory', () => {
      expect(isPathWithinHome('~/.zshrc')).toBe(true);
      expect(isPathWithinHome('~/.config/nvim')).toBe(true);
      expect(isPathWithinHome(join(TEST_HOME, '.bashrc'))).toBe(true);
    });

    it('should return false for absolute paths outside home', () => {
      // Unix paths
      if (process.platform !== 'win32') {
        expect(isPathWithinHome('/etc/passwd')).toBe(false);
        expect(isPathWithinHome('/usr/local/bin')).toBe(false);
      }
    });

    it('should return false for Windows-style absolute paths', () => {
      expect(isPathWithinHome('C:\\Windows\\System32')).toBe(false);
      expect(isPathWithinHome('D:\\Data')).toBe(false);
    });

    it('should return false for path traversal attempts', () => {
      expect(isPathWithinHome('~/../etc/passwd')).toBe(false);
      expect(isPathWithinHome('~/../../../etc/passwd')).toBe(false);
    });

    it('should return false for Windows-style path traversal', () => {
      expect(isPathWithinHome('~\\..\\..\\etc\\passwd')).toBe(false);
    });

    it('should return false for UNC paths', () => {
      expect(isPathWithinHome('\\\\server\\share')).toBe(false);
    });
  });

  describe('validateSafeSourcePath', () => {
    it('should accept valid home-relative paths', () => {
      expect(() => validateSafeSourcePath('~/.zshrc')).not.toThrow();
      expect(() => validateSafeSourcePath('~/.config/nvim')).not.toThrow();
    });

    it('should throw for path traversal attempts', () => {
      expect(() => validateSafeSourcePath('~/../etc/passwd')).toThrow(
        'path traversal is not allowed'
      );
      expect(() => validateSafeSourcePath('../../../etc/passwd')).toThrow(
        'path traversal is not allowed'
      );
    });

    it('should throw for Windows-style path traversal', () => {
      expect(() => validateSafeSourcePath('~\\..\\etc\\passwd')).toThrow(
        'path traversal is not allowed'
      );
    });

    it('should throw for absolute paths outside home', () => {
      if (process.platform !== 'win32') {
        expect(() => validateSafeSourcePath('/etc/passwd')).toThrow(
          'absolute paths outside home directory'
        );
      }
    });
  });

  describe('validateSafeDestinationPath', () => {
    it('should accept destination paths in home directory', () => {
      expect(() => validateSafeDestinationPath('~/.tuck/files/zshrc')).not.toThrow();
      expect(() => validateSafeDestinationPath(join(TEST_HOME, '.tuck', 'files', 'gitconfig'))).not.toThrow();
    });

    it('should throw for destination paths outside allowed roots', () => {
      if (process.platform !== 'win32') {
        expect(() => validateSafeDestinationPath('/etc/malicious')).toThrow(
          'destination must be within allowed roots'
        );
      }
    });
  });

  describe('validatePathWithinRoot', () => {
    it('should accept paths that resolve inside the given root', () => {
      expect(() =>
        validatePathWithinRoot(
          join(TEST_TUCK_DIR, 'files', 'shell', 'zshrc'),
          TEST_TUCK_DIR,
          'sync destination'
        )
      ).not.toThrow();
    });

    it('should reject paths that escape the root directory', () => {
      expect(() =>
        validatePathWithinRoot(
          join(TEST_TUCK_DIR, '..', 'outside-file'),
          TEST_TUCK_DIR,
          'sync destination'
        )
      ).toThrow('path must be within');
    });
  });

  describe('validateSafeManifestDestination', () => {
    it('should accept safe relative destinations under files/', () => {
      expect(() => validateSafeManifestDestination('files/shell/zshrc')).not.toThrow();
      expect(() => validateSafeManifestDestination('files\\git\\gitconfig')).not.toThrow();
    });

    it('should reject manifest destinations with path traversal', () => {
      expect(() => validateSafeManifestDestination('files/../secrets.txt')).toThrow(
        'path traversal is not allowed'
      );
    });

    it('should reject manifest destinations outside files/', () => {
      expect(() => validateSafeManifestDestination('tmp/evil-file')).toThrow(
        'destination must be inside'
      );
    });

    it('should reject absolute manifest destinations', () => {
      if (process.platform !== 'win32') {
        expect(() => validateSafeManifestDestination('/etc/passwd')).toThrow(
          'destination must be a relative path'
        );
      }
      expect(() => validateSafeManifestDestination('C:\\Windows\\System32\\drivers\\etc')).toThrow(
        'destination must be a relative path'
      );
    });
  });

  // ============================================================================
  // File ID Generation Tests
  // ============================================================================

  describe('generateFileId', () => {
    it('should generate ID from simple dotfile', () => {
      const id = generateFileId('~/.zshrc');
      expect(id).toBe('zshrc');
    });

    it('should generate ID from nested path', () => {
      const id = generateFileId('~/.config/nvim/init.vim');
      expect(id).toBe('config_nvim_init-vim');
    });

    it('should handle dots in filenames', () => {
      const id = generateFileId('~/.bash.aliases');
      expect(id).toBe('bash-aliases');
    });

    it('should handle multiple nested directories', () => {
      const id = generateFileId('~/.config/Code/User/settings.json');
      expect(id).toBe('config_Code_User_settings-json');
    });
  });

  // ============================================================================
  // Filename Sanitization Tests
  // ============================================================================

  describe('sanitizeFilename', () => {
    it('should remove leading dot from dotfiles', () => {
      expect(sanitizeFilename('.zshrc')).toBe('zshrc');
      expect(sanitizeFilename('.gitconfig')).toBe('gitconfig');
    });

    it('should keep non-dotfile names unchanged', () => {
      expect(sanitizeFilename('config')).toBe('config');
      expect(sanitizeFilename('file.txt')).toBe('file.txt');
    });

    it('should extract basename from path', () => {
      expect(sanitizeFilename('/home/user/.zshrc')).toBe('zshrc');
    });

    it('should handle edge case of just a dot', () => {
      expect(sanitizeFilename('.')).toBe('file');
    });
  });

  // ============================================================================
  // Category Detection Tests
  // ============================================================================

  describe('detectCategory', () => {
    it('should detect shell configuration files', () => {
      expect(detectCategory('~/.zshrc')).toBe('shell');
      expect(detectCategory('~/.bashrc')).toBe('shell');
      expect(detectCategory('~/.bash_profile')).toBe('shell');
      expect(detectCategory('~/.zprofile')).toBe('shell');
    });

    it('should detect git configuration files', () => {
      expect(detectCategory('~/.gitconfig')).toBe('git');
      expect(detectCategory('~/.gitignore_global')).toBe('git');
    });

    it('should detect editor configuration files', () => {
      expect(detectCategory('~/.vimrc')).toBe('editors');
      expect(detectCategory('~/.config/nvim')).toBe('editors');
    });

    it('should detect terminal configuration files', () => {
      expect(detectCategory('~/.tmux.conf')).toBe('terminal');
    });

    it('should detect SSH configuration files', () => {
      expect(detectCategory('~/.ssh/config')).toBe('ssh');
    });

    it('should default to misc for unknown files', () => {
      expect(detectCategory('~/.random-file')).toBe('misc');
      expect(detectCategory('~/.unknown')).toBe('misc');
    });
  });
});
