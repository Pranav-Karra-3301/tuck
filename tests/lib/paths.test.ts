import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import {
  expandPath,
  collapsePath,
  detectCategory,
  sanitizeFilename,
  generateFileId,
} from '../../src/lib/paths.js';

describe('paths', () => {
  describe('expandPath', () => {
    it('should expand ~ to home directory', () => {
      const home = homedir();
      expect(expandPath('~/.zshrc')).toBe(`${home}/.zshrc`);
    });

    it('should expand $HOME to home directory', () => {
      const home = homedir();
      expect(expandPath('$HOME/.zshrc')).toBe(`${home}/.zshrc`);
    });

    it('should return absolute paths unchanged', () => {
      expect(expandPath('/usr/local/bin')).toBe('/usr/local/bin');
    });
  });

  describe('collapsePath', () => {
    it('should collapse home directory to ~', () => {
      const home = homedir();
      expect(collapsePath(`${home}/.zshrc`)).toBe('~/.zshrc');
    });

    it('should return non-home paths unchanged', () => {
      expect(collapsePath('/usr/local/bin')).toBe('/usr/local/bin');
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
      expect(sanitizeFilename('/home/user/.zshrc')).toBe('zshrc');
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
});
