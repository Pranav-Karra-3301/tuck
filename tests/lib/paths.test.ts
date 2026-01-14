import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import {
  expandPath,
  collapsePath,
  detectCategory,
  sanitizeFilename,
  generateFileId,
} from '../../src/lib/paths.js';
import { normalizePath, normalizeForComparison } from '../../src/lib/platform.js';

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

    it('should handle Windows-style backslashes in paths', () => {
      // generateFileId should handle both / and \ separators
      const id = generateFileId('~\\.config\\nvim');
      expect(id).toBe('config_nvim');
    });
  });

  // ============================================================================
  // Windows Compatibility Tests (Beta)
  // These tests verify that path functions handle Windows-style paths correctly
  // even when running on Unix systems. On actual Windows, ~ expands to %USERPROFILE%.
  // ============================================================================
  describe('Windows path compatibility', () => {
    describe('normalizePath', () => {
      it('should convert backslashes to forward slashes', () => {
        expect(normalizePath('C:\\Users\\test\\.gitconfig')).toBe('C:/Users/test/.gitconfig');
        expect(normalizePath('~\\.config\\nvim')).toBe('~/.config/nvim');
      });

      it('should not modify paths that already use forward slashes', () => {
        expect(normalizePath('~/.config/nvim')).toBe('~/.config/nvim');
        expect(normalizePath('/home/user/.zshrc')).toBe('/home/user/.zshrc');
      });

      it('should handle mixed separators', () => {
        expect(normalizePath('~/.config\\nvim/init.lua')).toBe('~/.config/nvim/init.lua');
      });
    });

    describe('normalizeForComparison', () => {
      it('should normalize and remove trailing slashes', () => {
        expect(normalizeForComparison('~/.config/')).toBe('~/.config');
        expect(normalizeForComparison('~\\.config\\')).toBe('~/.config');
      });
    });

    describe('expandPath with Windows-style paths', () => {
      it('should expand ~\\ prefix (Windows backslash)', () => {
        const home = homedir();
        // expandPath should handle both ~/ and ~\
        expect(expandPath('~\\.gitconfig')).toBe(`${home}/.gitconfig`);
      });

      it('should expand $HOME\\ prefix', () => {
        const home = homedir();
        expect(expandPath('$HOME\\.config')).toBe(`${home}/.config`);
      });
    });

    describe('generateFileId with Windows paths', () => {
      it('should handle Windows AppData-style paths', () => {
        // These paths simulate what Windows users might have
        const id = generateFileId('~/AppData/Roaming/Code/User/settings.json');
        expect(id).toBe('AppData_Roaming_Code_User_settings-json');
      });

      it('should handle backslashes in nested paths', () => {
        const id = generateFileId('~\\Documents\\PowerShell\\profile.ps1');
        expect(id).toBe('Documents_PowerShell_profile-ps1');
      });
    });
  });
});
