import { describe, it, expect } from 'vitest';
import {
  shouldExcludeFile,
  DEFAULT_EXCLUSION_PATTERNS,
} from '../../src/lib/detect.js';

describe('detect', () => {
  describe('DEFAULT_EXCLUSION_PATTERNS', () => {
    it('should have cache directories defined', () => {
      expect(DEFAULT_EXCLUSION_PATTERNS.cacheDirectories).toContain('~/.cache');
      expect(DEFAULT_EXCLUSION_PATTERNS.cacheDirectories).toContain('~/.npm');
      expect(DEFAULT_EXCLUSION_PATTERNS.cacheDirectories).toContain(
        '~/.yarn/cache'
      );
    });

    it('should have history files defined', () => {
      expect(DEFAULT_EXCLUSION_PATTERNS.historyFiles).toContain(
        '~/.bash_history'
      );
      expect(DEFAULT_EXCLUSION_PATTERNS.historyFiles).toContain(
        '~/.zsh_history'
      );
      expect(DEFAULT_EXCLUSION_PATTERNS.historyFiles).toContain('~/.lesshst');
    });

    it('should have binary patterns defined', () => {
      expect(DEFAULT_EXCLUSION_PATTERNS.binaryPatterns.length).toBeGreaterThan(
        0
      );
    });

    it('should have temp file patterns defined', () => {
      expect(DEFAULT_EXCLUSION_PATTERNS.tempFiles.length).toBeGreaterThan(0);
    });
  });

  describe('shouldExcludeFile', () => {
    describe('cache directories', () => {
      it('should exclude ~/.cache', () => {
        expect(shouldExcludeFile('~/.cache')).toBe(true);
        expect(shouldExcludeFile('~/.cache/some/nested/file')).toBe(true);
      });

      it('should exclude ~/.npm', () => {
        expect(shouldExcludeFile('~/.npm')).toBe(true);
        expect(shouldExcludeFile('~/.npm/_cacache')).toBe(true);
      });

      it('should exclude ~/.yarn/cache', () => {
        expect(shouldExcludeFile('~/.yarn/cache')).toBe(true);
        expect(shouldExcludeFile('~/.yarn/cache/package-1234.zip')).toBe(true);
      });

      it('should exclude language version managers', () => {
        expect(shouldExcludeFile('~/.pyenv/versions')).toBe(true);
        expect(shouldExcludeFile('~/.nvm/versions')).toBe(true);
        expect(shouldExcludeFile('~/.rbenv/versions')).toBe(true);
      });

      it('should NOT exclude non-cache directories', () => {
        expect(shouldExcludeFile('~/.config')).toBe(false);
        expect(shouldExcludeFile('~/.zshrc')).toBe(false);
        expect(shouldExcludeFile('~/.npmrc')).toBe(false);
      });
    });

    describe('history files', () => {
      it('should exclude bash history', () => {
        expect(shouldExcludeFile('~/.bash_history')).toBe(true);
      });

      it('should exclude zsh history', () => {
        expect(shouldExcludeFile('~/.zsh_history')).toBe(true);
        expect(shouldExcludeFile('~/.zhistory')).toBe(true);
      });

      it('should exclude lesshst', () => {
        expect(shouldExcludeFile('~/.lesshst')).toBe(true);
      });

      it('should exclude database histories', () => {
        expect(shouldExcludeFile('~/.mysql_history')).toBe(true);
        expect(shouldExcludeFile('~/.psql_history')).toBe(true);
        expect(shouldExcludeFile('~/.sqlite_history')).toBe(true);
      });

      it('should exclude vim info files', () => {
        expect(shouldExcludeFile('~/.viminfo')).toBe(true);
        expect(shouldExcludeFile('~/.netrwhist')).toBe(true);
      });

      it('should NOT exclude config files', () => {
        expect(shouldExcludeFile('~/.bashrc')).toBe(false);
        expect(shouldExcludeFile('~/.zshrc')).toBe(false);
      });
    });

    describe('binary patterns', () => {
      it('should exclude image files', () => {
        expect(shouldExcludeFile('~/some/file.png')).toBe(true);
        expect(shouldExcludeFile('~/some/file.jpg')).toBe(true);
        expect(shouldExcludeFile('~/some/file.jpeg')).toBe(true);
        expect(shouldExcludeFile('~/some/file.gif')).toBe(true);
        expect(shouldExcludeFile('~/some/file.PNG')).toBe(true);
      });

      it('should exclude font files', () => {
        expect(shouldExcludeFile('~/fonts/file.ttf')).toBe(true);
        expect(shouldExcludeFile('~/fonts/file.woff')).toBe(true);
        expect(shouldExcludeFile('~/fonts/file.woff2')).toBe(true);
        expect(shouldExcludeFile('~/fonts/file.otf')).toBe(true);
      });

      it('should exclude compiled binaries', () => {
        expect(shouldExcludeFile('~/bin/file.so')).toBe(true);
        expect(shouldExcludeFile('~/bin/file.dylib')).toBe(true);
        expect(shouldExcludeFile('~/bin/file.dll')).toBe(true);
        expect(shouldExcludeFile('~/bin/file.exe')).toBe(true);
      });

      it('should exclude database files', () => {
        expect(shouldExcludeFile('~/data/file.db')).toBe(true);
        expect(shouldExcludeFile('~/data/file.sqlite')).toBe(true);
        expect(shouldExcludeFile('~/data/file.sqlite3')).toBe(true);
      });

      it('should exclude archive files', () => {
        expect(shouldExcludeFile('~/downloads/file.zip')).toBe(true);
        expect(shouldExcludeFile('~/downloads/file.tar')).toBe(true);
        expect(shouldExcludeFile('~/downloads/file.gz')).toBe(true);
        expect(shouldExcludeFile('~/downloads/file.7z')).toBe(true);
      });

      it('should NOT exclude text/config files', () => {
        expect(shouldExcludeFile('~/config.json')).toBe(false);
        expect(shouldExcludeFile('~/config.toml')).toBe(false);
        expect(shouldExcludeFile('~/config.yaml')).toBe(false);
        expect(shouldExcludeFile('~/.zshrc')).toBe(false);
      });
    });

    describe('temp files', () => {
      it('should exclude generic .lock files but keep dependency lockfiles', () => {
        // package-lock.json is intentionally NOT excluded: it's important for dependency management
        // and our pattern only matches files that end in `.lock`, not `.lock.json` or `-lock.yaml`.
        expect(shouldExcludeFile('~/package-lock.json')).toBe(false);
        expect(shouldExcludeFile('~/yarn.lock')).toBe(true);
        // pnpm-lock.yaml is also intentionally NOT excluded for the same reason as package-lock.json.
        expect(shouldExcludeFile('~/pnpm-lock.yaml')).toBe(false);
        expect(shouldExcludeFile('~/Cargo.lock')).toBe(true);
      });

      it('should exclude swap files', () => {
        expect(shouldExcludeFile('~/.zshrc.swp')).toBe(true);
        expect(shouldExcludeFile('~/.vimrc.swo')).toBe(true);
      });

      it('should exclude backup files', () => {
        expect(shouldExcludeFile('~/.zshrc~')).toBe(true);
        expect(shouldExcludeFile('~/.zshrc.bak')).toBe(true);
        expect(shouldExcludeFile('~/.zshrc.backup')).toBe(true);
        expect(shouldExcludeFile('~/.zshrc.orig')).toBe(true);
      });

      it('should exclude temp files', () => {
        expect(shouldExcludeFile('~/file.tmp')).toBe(true);
        expect(shouldExcludeFile('~/file.temp')).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle paths without ~ prefix', () => {
        // These are already tested via other tests but let's be explicit
        expect(shouldExcludeFile('/home/user/.bash_history')).toBe(false); // Won't match without proper HOME
        expect(shouldExcludeFile('~/.bash_history')).toBe(true);
      });

      it('should be case insensitive for file extensions', () => {
        expect(shouldExcludeFile('~/file.PNG')).toBe(true);
        expect(shouldExcludeFile('~/file.Png')).toBe(true);
        expect(shouldExcludeFile('~/file.TMP')).toBe(true);
      });

      it('should NOT exclude dotfiles that happen to contain excluded words', () => {
        expect(shouldExcludeFile('~/.cache-config')).toBe(false); // Different from ~/.cache
        expect(shouldExcludeFile('~/.history-manager')).toBe(false);
      });
    });
  });
});
