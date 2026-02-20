import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  expandPath,
  collapsePath,
  detectCategory,
  getDestinationPathFromSource,
  getHomeRelativeSourcePath,
  getRelativeDestinationFromSource,
  sanitizeFilename,
  generateFileId,
} from '../../src/lib/paths.js';
import { TEST_HOME } from '../setup.js';

describe('paths', () => {
  describe('expandPath', () => {
    it('should expand ~ to home directory', () => {
      // The mock returns TEST_HOME for homedir()
      const result = expandPath('~/.zshrc');
      // Result should be TEST_HOME/.zshrc (with platform-appropriate separators)
      expect(result.replace(/\\/g, '/')).toBe(`${TEST_HOME}/.zshrc`);
    });

    it('should expand $HOME to home directory', () => {
      const result = expandPath('$HOME/.zshrc');
      expect(result.replace(/\\/g, '/')).toBe(`${TEST_HOME}/.zshrc`);
    });

    it('should return absolute paths unchanged', () => {
      // This test is Unix-specific, skip on Windows
      if (process.platform !== 'win32') {
        expect(expandPath('/usr/local/bin')).toBe('/usr/local/bin');
      }
    });
  });

  describe('collapsePath', () => {
    it('should collapse home directory to ~', () => {
      // Use TEST_HOME since homedir() is mocked to return it
      // collapsePath internally calls homedir() which returns TEST_HOME
      const result = collapsePath(join(TEST_HOME, '.zshrc'));
      // On Windows the separator will be backslash, so normalize for comparison
      expect(result.replace(/\\/g, '/')).toBe('~/.zshrc');
    });

    it('should return non-home paths unchanged', () => {
      // This test is Unix-specific, skip on Windows
      if (process.platform !== 'win32') {
        expect(collapsePath('/usr/local/bin')).toBe('/usr/local/bin');
      }
    });
  });

  describe('detectCategory', () => {
    it('should detect shell files', () => {
      expect(detectCategory('~/.zshrc')).toBe('shell');
      expect(detectCategory('~/.bashrc')).toBe('shell');
      expect(detectCategory('~/.bash_profile')).toBe('shell');
    });

    it('should detect git files', () => {
      expect(detectCategory('~/.gitconfig')).toBe('git');
      expect(detectCategory('~/.gitignore_global')).toBe('git');
    });

    it('should detect editor files', () => {
      expect(detectCategory('~/.vimrc')).toBe('editors');
      expect(detectCategory('~/.config/nvim')).toBe('editors');
    });

    it('should detect terminal files', () => {
      expect(detectCategory('~/.tmux.conf')).toBe('terminal');
    });

    it('should detect ssh files', () => {
      expect(detectCategory('~/.ssh/config')).toBe('ssh');
    });

    it('should default to misc for unknown files', () => {
      expect(detectCategory('~/.random-file')).toBe('misc');
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove leading dot from dotfiles', () => {
      expect(sanitizeFilename('.zshrc')).toBe('zshrc');
      expect(sanitizeFilename('.gitconfig')).toBe('gitconfig');
    });

    it('should keep non-dotfile names unchanged', () => {
      expect(sanitizeFilename('config')).toBe('config');
    });

    it('should extract basename from path', () => {
      // Use path.join for cross-platform path
      expect(sanitizeFilename(join('home', 'user', '.zshrc'))).toBe('zshrc');
    });
  });

  describe('generateFileId', () => {
    it('should generate a valid ID from source path', () => {
      const id = generateFileId('~/.zshrc');
      expect(id).toBe('zshrc');
    });

    it('should handle nested paths', () => {
      const id = generateFileId('~/.config/nvim');
      expect(id).toBe('config_nvim');
    });
  });

  describe('home-relative destinations', () => {
    it('should derive home-relative source paths', () => {
      expect(getHomeRelativeSourcePath('~/.aws/config')).toBe('.aws/config');
      expect(getHomeRelativeSourcePath('~/.kube/config')).toBe('.kube/config');
    });

    it('should build unique destinations from source paths', () => {
      expect(getRelativeDestinationFromSource('misc', '~/.aws/config')).toBe(
        'files/misc/.aws/config'
      );
      expect(getRelativeDestinationFromSource('misc', '~/.kube/config')).toBe(
        'files/misc/.kube/config'
      );
    });

    it('should build absolute destination paths from source paths', () => {
      const destination = getDestinationPathFromSource(`${TEST_HOME}/.tuck`, 'shell', '~/.zshrc');
      expect(destination.replace(/\\/g, '/')).toBe(`${TEST_HOME}/.tuck/files/shell/.zshrc`);
    });
  });
});
