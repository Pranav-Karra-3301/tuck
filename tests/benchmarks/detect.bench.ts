/**
 * Dotfile detection benchmarks for tuck.
 *
 * The detect module scans for 150+ potential dotfile paths.
 * Performance concerns:
 * - Many filesystem existence checks
 * - Platform-specific filtering
 * - Category classification
 *
 * Target performance:
 * - Full scan: < 500ms
 * - Category detection: < 1ms per file
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { createTempDir, generateDotfileContent } from './setup.js';

// Import detect functions
import { detectDotfiles } from '../../src/lib/detect.js';
import { detectCategory } from '../../src/lib/paths.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('detect-bench-');
const mockHome = join(tempDir, 'home');

// Create a mock home directory with realistic dotfiles
const dotfiles = [
  '.bashrc',
  '.zshrc',
  '.bash_profile',
  '.zprofile',
  '.profile',
  '.gitconfig',
  '.gitignore_global',
  '.vimrc',
  '.tmux.conf',
  '.inputrc',
  '.aliases',
  '.exports',
  '.functions',
  '.ssh/config',
  '.config/starship.toml',
  '.config/nvim/init.lua',
  '.config/alacritty/alacritty.yml',
  '.config/kitty/kitty.conf',
  '.config/fish/config.fish',
  '.config/git/config',
];

mkdirSync(mockHome, { recursive: true });

for (const dotfile of dotfiles) {
  const fullPath = join(mockHome, dotfile);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, generateDotfileContent(20));
}

// Test paths for category detection
const testPaths = [
  '~/.bashrc',
  '~/.zshrc',
  '~/.gitconfig',
  '~/.vimrc',
  '~/.config/nvim/init.lua',
  '~/.tmux.conf',
  '~/.ssh/config',
  '~/.config/starship.toml',
  '~/.random-file',
  '/usr/local/etc/config',
];

const shellPaths = ['~/.bashrc', '~/.zshrc', '~/.bash_profile', '~/.zprofile', '~/.profile'];

const configPaths = [
  '~/.config/nvim/init.lua',
  '~/.config/alacritty/alacritty.yml',
  '~/.config/kitty/kitty.conf',
  '~/.config/fish/config.fish',
  '~/.config/starship.toml',
];

// Paths for filesystem checks
const realHomePaths = [
  join(homedir(), '.bashrc'),
  join(homedir(), '.zshrc'),
  join(homedir(), '.gitconfig'),
  join(homedir(), '.config'),
  join(homedir(), '.ssh'),
];

const potentialPaths = [
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.zprofile',
  '.gitconfig',
  '.gitignore_global',
  '.vimrc',
  '.tmux.conf',
  '.config/nvim',
  '.config/alacritty',
  '.config/kitty',
  '.config/fish',
  '.config/starship.toml',
  '.config/htop',
  '.ssh/config',
  '.gnupg/gpg.conf',
  '.npmrc',
  '.yarnrc',
  '.pyenv',
  '.rbenv',
  '.nvm',
  '.cargo',
  '.rustup',
  // Non-existent paths (should be fast)
  '.nonexistent1',
  '.nonexistent2',
  '.nonexistent3',
  '.fake_config',
  '.imaginary',
  '.not_real',
].map((p) => join(homedir(), p));

// ============================================================================
// Benchmarks
// ============================================================================

describe('Dotfile Detection Benchmarks', () => {
  // ============================================================================
  // Full Detection Benchmarks
  // ============================================================================

  describe('detectDotfiles', () => {
    bench('detect dotfiles on real home', async () => {
      await detectDotfiles();
    });

    bench('detect dotfiles (second run - cached paths)', async () => {
      // First run
      await detectDotfiles();
      // Second run - some internal caching may apply
      await detectDotfiles();
    });
  });

  // ============================================================================
  // Category Detection Benchmarks
  // ============================================================================

  describe('detectCategory', () => {
    bench('categorize single path', () => {
      detectCategory('~/.zshrc');
    });

    bench('categorize 10 paths', () => {
      for (const path of testPaths) {
        detectCategory(path);
      }
    });

    bench('categorize 100 paths', () => {
      for (let i = 0; i < 10; i++) {
        for (const path of testPaths) {
          detectCategory(path);
        }
      }
    });

    bench('categorize shell files', () => {
      for (const path of shellPaths) {
        detectCategory(path);
      }
    });

    bench('categorize config directory paths', () => {
      for (const path of configPaths) {
        detectCategory(path);
      }
    });
  });

  // ============================================================================
  // Path Existence Checks
  // ============================================================================

  describe('Filesystem Checks', () => {
    bench('existsSync on real home files', () => {
      for (const path of realHomePaths) {
        existsSync(path);
      }
    });

    bench('existsSync on 50 potential paths', () => {
      for (const path of potentialPaths) {
        existsSync(path);
      }
    });
  });

  // ============================================================================
  // Filtering Benchmarks
  // ============================================================================

  describe('Detection Filtering', () => {
    bench('filter by category after detection', async () => {
      const detected = await detectDotfiles();
      detected.filter((f) => f.category === 'shell');
      detected.filter((f) => f.category === 'git');
      detected.filter((f) => f.category === 'editors');
    });

    bench('filter sensitive files', async () => {
      const detected = await detectDotfiles();
      detected.filter((f) => f.sensitive === true);
    });

    bench('group by category', async () => {
      const detected = await detectDotfiles();
      const byCategory: Record<string, typeof detected> = {};

      for (const file of detected) {
        if (!byCategory[file.category]) {
          byCategory[file.category] = [];
        }
        byCategory[file.category].push(file);
      }
    });
  });
});
