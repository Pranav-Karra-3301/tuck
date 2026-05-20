import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  loadPatterns,
  resetPatternsCache,
} from '../../src/lib/patternsRegistry.js';
import { TEST_HOME } from '../setup.js';

// Resolve the bundled patterns dir using the same logic as patternsRegistry.ts.
// This matches what `bundledPatternsDir()` returns at runtime.
const bundledDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  // tests/lib -> tests -> repo root
  '../../templates/patterns'
);

const seedBundledShellFile = (): void => {
  vol.mkdirSync(bundledDir, { recursive: true });
  const doc = {
    $schema: 'https://tuck.sh/schemas/patterns-v1.json',
    category: 'shell',
    patterns: [
      {
        pattern: '~/.zshrc',
        category: 'shell',
        description: 'Zsh interactive shell config',
        sensitive: false,
        isDirectory: false,
        exclude: [],
      },
      {
        pattern: '~/.bashrc',
        category: 'shell',
        description: 'Bash interactive shell config',
        sensitive: false,
        isDirectory: false,
        exclude: [],
      },
    ],
  };
  vol.writeFileSync(`${bundledDir}/shell.json`, JSON.stringify(doc));
};

const seedBundledGitFile = (): void => {
  vol.mkdirSync(bundledDir, { recursive: true });
  const doc = {
    $schema: 'https://tuck.sh/schemas/patterns-v1.json',
    category: 'git',
    patterns: [
      {
        pattern: '~/.gitconfig',
        category: 'git',
        description: 'Git global configuration',
        sensitive: false,
        isDirectory: false,
        exclude: [],
      },
    ],
  };
  vol.writeFileSync(`${bundledDir}/git.json`, JSON.stringify(doc));
};

describe('patternsRegistry', () => {
  beforeEach(() => {
    resetPatternsCache();
    delete process.env.TUCK_PATTERNS_DIR;
  });

  afterEach(() => {
    resetPatternsCache();
    delete process.env.TUCK_PATTERNS_DIR;
  });

  describe('loadPatterns', () => {
    it('loads bundled patterns from templates/patterns/*.json', async () => {
      seedBundledShellFile();
      seedBundledGitFile();

      const patterns = await loadPatterns();
      expect(patterns.length).toBe(3);

      const zshrc = patterns.find((p) => p.path === '~/.zshrc');
      expect(zshrc).toBeDefined();
      expect(zshrc!.category).toBe('shell');
      expect(zshrc!.description).toBe('Zsh interactive shell config');

      const gitconfig = patterns.find((p) => p.path === '~/.gitconfig');
      expect(gitconfig).toBeDefined();
      expect(gitconfig!.category).toBe('git');
    });

    it('returns the canonical DotfilePattern shape', async () => {
      seedBundledShellFile();
      const patterns = await loadPatterns();
      for (const p of patterns) {
        expect(typeof p.path).toBe('string');
        expect(typeof p.category).toBe('string');
        expect(typeof p.description).toBe('string');
        if (p.sensitive !== undefined) expect(typeof p.sensitive).toBe('boolean');
        if (p.exclude !== undefined) expect(Array.isArray(p.exclude)).toBe(true);
        if (p.platform !== undefined) {
          expect(['darwin', 'linux', 'win32', 'all']).toContain(p.platform);
        }
      }
    });

    it('caches the result across calls', async () => {
      seedBundledShellFile();
      const first = await loadPatterns();
      const second = await loadPatterns();
      // Same reference because of in-process cache.
      expect(second).toBe(first);
    });

    it('appends user overrides with new pattern paths', async () => {
      seedBundledShellFile();
      const userDir = `${TEST_HOME}/custom-patterns`;
      vol.mkdirSync(userDir, { recursive: true });
      const doc = {
        $schema: 'https://tuck.sh/schemas/patterns-v1.json',
        category: 'cli',
        patterns: [
          {
            pattern: '~/.my-totally-custom-tool',
            category: 'cli',
            description: 'User-defined tool',
            sensitive: false,
            isDirectory: false,
            exclude: [],
          },
        ],
      };
      vol.writeFileSync(`${userDir}/custom.json`, JSON.stringify(doc));

      process.env.TUCK_PATTERNS_DIR = userDir;
      resetPatternsCache();

      const patterns = await loadPatterns();
      const custom = patterns.find(
        (p) => p.path === '~/.my-totally-custom-tool'
      );
      expect(custom).toBeDefined();
      expect(custom!.category).toBe('cli');
      expect(custom!.description).toBe('User-defined tool');
      // Bundled entries should still be present.
      expect(patterns.find((p) => p.path === '~/.zshrc')).toBeDefined();
    });

    it('replaces bundled entries when a user override shares the same pattern path', async () => {
      seedBundledShellFile();
      const userDir = `${TEST_HOME}/custom-patterns`;
      vol.mkdirSync(userDir, { recursive: true });
      const doc = {
        $schema: 'https://tuck.sh/schemas/patterns-v1.json',
        category: 'shell',
        patterns: [
          {
            pattern: '~/.zshrc',
            category: 'shell',
            description: 'OVERRIDDEN zsh config',
            sensitive: true,
            isDirectory: false,
            exclude: [],
          },
        ],
      };
      vol.writeFileSync(`${userDir}/override.json`, JSON.stringify(doc));

      process.env.TUCK_PATTERNS_DIR = userDir;
      resetPatternsCache();

      const patterns = await loadPatterns();
      const zshrcEntries = patterns.filter((p) => p.path === '~/.zshrc');
      // Override should replace in place — exactly one entry.
      expect(zshrcEntries).toHaveLength(1);
      expect(zshrcEntries[0]!.description).toBe('OVERRIDDEN zsh config');
      expect(zshrcEntries[0]!.sensitive).toBe(true);
    });

    it('ignores malformed JSON files gracefully', async () => {
      seedBundledShellFile();
      const userDir = `${TEST_HOME}/custom-patterns`;
      vol.mkdirSync(userDir, { recursive: true });
      vol.writeFileSync(`${userDir}/broken.json`, '{ not json');

      process.env.TUCK_PATTERNS_DIR = userDir;
      resetPatternsCache();

      // Should not throw, and bundled patterns should still be present.
      const patterns = await loadPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.find((p) => p.path === '~/.zshrc')).toBeDefined();
    });

    it('returns an empty array when no bundled or user files exist', async () => {
      // No seeding — memfs has nothing at the bundled or user paths.
      resetPatternsCache();
      const patterns = await loadPatterns();
      expect(patterns).toEqual([]);
    });
  });
});
