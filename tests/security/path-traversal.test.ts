import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  expandPath,
  isPathWithinHome,
  validateSafeSourcePath,
  validateSafeDestinationPath,
  getTuckDir,
} from '../../src/lib/paths.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

describe('Path Traversal Security', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  describe('expandPath', () => {
    it('expands home-relative paths deterministically', () => {
      const result = expandPath('~/.zshrc');
      expect(result.replace(/\\/g, '/')).toBe('/test-home/.zshrc');
    });
  });

  describe('isPathWithinHome', () => {
    it('returns true for normal home-scoped paths', () => {
      expect(isPathWithinHome('~/.zshrc')).toBe(true);
      expect(isPathWithinHome('~/.config/nvim/init.lua')).toBe(true);
      expect(isPathWithinHome(join(TEST_HOME, '.gitconfig'))).toBe(true);
    });

    it('returns false for traversal and external absolute paths', () => {
      expect(isPathWithinHome('~/../etc/passwd')).toBe(false);
      expect(isPathWithinHome('~/../../root/.ssh/id_rsa')).toBe(false);
      if (process.platform !== 'win32') {
        expect(isPathWithinHome('/etc/passwd')).toBe(false);
      }
    });

    it('rejects windows drive and UNC paths on every platform', () => {
      expect(isPathWithinHome('C:\\Windows\\System32\\config\\SAM')).toBe(false);
      expect(isPathWithinHome('\\\\server\\share\\secret')).toBe(false);
    });
  });

  describe('validateSafeSourcePath', () => {
    it('allows safe source paths', () => {
      expect(() => validateSafeSourcePath('~/.zshrc')).not.toThrow();
      expect(() => validateSafeSourcePath('~/.config/alacritty/alacritty.yml')).not.toThrow();
    });

    it('throws for traversal attempts', () => {
      expect(() => validateSafeSourcePath('~/../etc/passwd')).toThrow('path traversal');
      expect(() => validateSafeSourcePath('~\\..\\etc\\passwd')).toThrow('path traversal');
    });

    it('throws for absolute paths outside home', () => {
      if (process.platform !== 'win32') {
        expect(() => validateSafeSourcePath('/var/log/syslog')).toThrow('Unsafe path');
      }
    });
  });

  describe('validateSafeDestinationPath', () => {
    it('allows home-scoped destinations', () => {
      expect(() => validateSafeDestinationPath('~/.tuck/files/shell/zshrc')).not.toThrow();
      expect(() => validateSafeDestinationPath(join(TEST_HOME, '.tuck', 'files', 'gitconfig'))).not.toThrow();
    });

    it('rejects destinations outside allowed roots', () => {
      if (process.platform !== 'win32') {
        expect(() => validateSafeDestinationPath('/etc/malicious')).toThrow(
          'destination must be within allowed roots'
        );
      }
    });
  });

  describe('getTuckDir', () => {
    it('returns a home-scoped default directory', () => {
      expect(isPathWithinHome(getTuckDir())).toBe(true);
    });

    it('rejects custom directories outside home', () => {
      if (process.platform !== 'win32') {
        expect(() => getTuckDir('/etc/tuck')).toThrow('custom tuck directory must be within home');
      }
    });
  });
});
