import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  expandPath,
  isPathWithinHome,
  validateSafeSourcePath,
  validateSafeDestinationPath,
  validatePathWithinRoot,
  validateSafeManifestDestination,
  getSafeRepoPathFromDestination,
  getTuckDir,
} from '../../src/lib/paths.js';
import { assertRealTargetWithinRoots } from '../../src/commands/apply.js';
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

  describe('validatePathWithinRoot', () => {
    it('accepts paths that stay inside the provided root', () => {
      expect(() =>
        validatePathWithinRoot(join(TEST_TUCK_DIR, 'files', 'shell', 'zshrc'), TEST_TUCK_DIR)
      ).not.toThrow();
    });

    it('rejects paths that escape the provided root', () => {
      expect(() =>
        validatePathWithinRoot(join(TEST_TUCK_DIR, '..', 'outside'), TEST_TUCK_DIR)
      ).toThrow('path must be within');
    });
  });

  describe('validateSafeManifestDestination', () => {
    it('allows repo destinations under files/', () => {
      expect(() => validateSafeManifestDestination('files/shell/zshrc')).not.toThrow();
    });

    it('rejects traversal and non-files destinations', () => {
      expect(() => validateSafeManifestDestination('files/../../secret')).toThrow(
        'path traversal'
      );
      expect(() => validateSafeManifestDestination('backup/zshrc')).toThrow(
        'destination must be inside'
      );
    });
  });

  describe('getSafeRepoPathFromDestination', () => {
    it('resolves valid destinations inside tuck root', () => {
      const repoPath = getSafeRepoPathFromDestination(TEST_TUCK_DIR, 'files/shell/zshrc');
      expect(repoPath.replace(/\\/g, '/')).toBe('/test-home/.tuck/files/shell/zshrc');
    });

    it('rejects destinations that attempt root escape', () => {
      expect(() =>
        getSafeRepoPathFromDestination(TEST_TUCK_DIR, 'files/../../outside')
      ).toThrow('path traversal');
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

  // Regression: the apply write path was confined only LEXICALLY, so a symlinked
  // path segment planted on the live tree (by a malicious repo's directory entry)
  // let a subsequent write escape $HOME. assertRealTargetWithinRoots is the
  // realpath-based guard that closes that TOCTOU by refusing to write THROUGH a
  // symlinked segment. (See src/commands/apply.ts.)
  describe('assertRealTargetWithinRoots (symlink TOCTOU guard)', () => {
    it('rejects a write when a path segment resolves outside home via a symlink', async () => {
      // Attacker plants ~/link -> /outside; the lexical destination ~/link/pwned
      // looks home-scoped but escapes once the symlink is resolved.
      vol.mkdirSync('/outside', { recursive: true });
      vol.symlinkSync('/outside', join(TEST_HOME, 'link'));

      // The lexical validator does NOT catch it — this is exactly the gap.
      expect(() =>
        validatePathWithinRoot(join(TEST_HOME, 'link', 'pwned'), TEST_HOME)
      ).not.toThrow();

      // The realpath guard DOES.
      await expect(
        assertRealTargetWithinRoots(join(TEST_HOME, 'link', 'pwned'), [TEST_HOME])
      ).rejects.toThrow(/symlinked path|outside the allowed roots/);
    });

    it('rejects writing directly onto an existing symlink that points outside home', async () => {
      vol.mkdirSync('/outside', { recursive: true });
      vol.symlinkSync('/outside/secret', join(TEST_HOME, '.evil'));

      await expect(
        assertRealTargetWithinRoots(join(TEST_HOME, '.evil'), [TEST_HOME])
      ).rejects.toThrow(/symlinked path|outside the allowed roots/);
    });

    it('allows a normal home-scoped write with no symlinked segment', async () => {
      await expect(
        assertRealTargetWithinRoots(join(TEST_HOME, '.config', 'app', 'settings'), [TEST_HOME])
      ).resolves.toBeUndefined();
    });

    it('allows a symlinked segment that stays inside home', async () => {
      vol.mkdirSync(join(TEST_HOME, 'real'), { recursive: true });
      vol.symlinkSync(join(TEST_HOME, 'real'), join(TEST_HOME, 'inlink'));

      await expect(
        assertRealTargetWithinRoots(join(TEST_HOME, 'inlink', 'file'), [TEST_HOME])
      ).resolves.toBeUndefined();
    });
  });
});
