# GNU Stow Migration Plan

> Detailed implementation guide for migrating from GNU Stow to tuck

---

## Table of Contents

1. [Overview](#overview)
2. [Stow Structure Analysis](#stow-structure-analysis)
3. [Detection Strategy](#detection-strategy)
4. [Symlink Resolution](#symlink-resolution)
5. [Package Discovery](#package-discovery)
6. [Migration Steps](#migration-steps)
7. [Edge Cases](#edge-cases)
8. [Implementation](#implementation)
9. [Testing](#testing)

---

## Overview

GNU Stow is a symlink farm manager that creates symlinks from a source directory (the "stow directory") to a target directory (usually `$HOME`). It organizes files into "packages" - directories that mirror the target structure.

### Key Challenges

1. **Symlink-based** - Need to resolve symlinks to actual content
2. **Package structure** - Directory layout mirrors target hierarchy
3. **No manifest** - Must discover what's stowed by finding symlinks
4. **Potential conflicts** - Existing non-symlink files may conflict

### Stow Resources

- Official manual: https://www.gnu.org/software/stow/manual/
- Common patterns: https://systemcrafters.net/managing-your-dotfiles/using-gnu-stow/

### Advantages of Stow Migration

- Simplest of all migrations (no templates, no encryption)
- Files are actual files in the stow directory
- Clear package organization can map to tuck categories

---

## Stow Structure Analysis

### Common Stow Directory Locations

```
~/dotfiles/              # Most common
~/.dotfiles/             # Hidden variant
~/stow/                  # Alternative name
~/.stow/                 # Hidden alternative
$STOW_DIR/               # Environment variable
```

### Package Structure

Each package is a directory containing the target hierarchy:

```
~/dotfiles/                    # Stow directory
├── zsh/                       # Package "zsh"
│   └── .zshrc                 # Creates ~/.zshrc symlink
├── git/                       # Package "git"
│   └── .gitconfig             # Creates ~/.gitconfig symlink
├── nvim/                      # Package "nvim"
│   └── .config/
│       └── nvim/
│           ├── init.lua       # Creates ~/.config/nvim/init.lua
│           └── lua/
│               └── settings.lua
├── ssh/                       # Package "ssh"
│   └── .ssh/
│       └── config             # Creates ~/.ssh/config symlink
└── .stow-local-ignore         # Ignore patterns
```

### Resulting Symlinks in `$HOME`

```
~/.zshrc → ~/dotfiles/zsh/.zshrc
~/.gitconfig → ~/dotfiles/git/.gitconfig
~/.config/nvim/ → ~/dotfiles/nvim/.config/nvim/
~/.ssh/config → ~/dotfiles/ssh/.ssh/config
```

### Stow Command Usage

```bash
# Stow a package (create symlinks)
stow -d ~/dotfiles -t ~ zsh

# Unstow a package (remove symlinks)
stow -D -d ~/dotfiles -t ~ zsh

# Restow (unstow then stow)
stow -R -d ~/dotfiles -t ~ zsh

# Dry run
stow -n -d ~/dotfiles -t ~ zsh
```

### Ignore File

`.stow-local-ignore` in package or stow directory:

```
# Ignore patterns (Perl regex)
README.*
LICENSE
\.git
\.gitignore
```

---

## Detection Strategy

### Detection Steps

```typescript
async function detectStow(): Promise<DetectionResult> {
  // Common stow directory locations
  const candidates = [
    join(homedir(), 'dotfiles'),
    join(homedir(), '.dotfiles'),
    join(homedir(), 'stow'),
    join(homedir(), '.stow'),
    process.env.STOW_DIR,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!await pathExists(candidate)) continue;

    // Check if it looks like a stow directory
    const isStowDir = await looksLikeStowDir(candidate);
    if (isStowDir.isStow) {
      return {
        tool: 'stow',
        path: candidate,
        confidence: isStowDir.confidence,
        metadata: {
          packages: isStowDir.packages,
        },
      };
    }
  }

  // Look for symlinks in home that point to a common parent
  const stowDir = await detectStowFromSymlinks();
  if (stowDir) {
    return {
      tool: 'stow',
      path: stowDir.path,
      confidence: 'medium',
      metadata: {
        packages: stowDir.packages,
        detectedFromSymlinks: true,
      },
    };
  }

  return { tool: null, path: null, confidence: 'low' };
}

async function looksLikeStowDir(
  dir: string
): Promise<{ isStow: boolean; confidence: 'high' | 'medium' | 'low'; packages: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const packages: string[] = [];
  let hasPackageStructure = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;  // Skip hidden dirs

    const pkgPath = join(dir, entry.name);
    const pkgEntries = await readdir(pkgPath);

    // A package should contain dotfiles or .config structure
    const hasDotfiles = pkgEntries.some(e => e.startsWith('.'));
    const hasConfigDir = pkgEntries.includes('.config');

    if (hasDotfiles || hasConfigDir) {
      hasPackageStructure = true;
      packages.push(entry.name);
    }
  }

  // Check for stow-specific files
  const hasStowIgnore = await pathExists(join(dir, '.stow-local-ignore'));
  const hasStowGlobalIgnore = await pathExists(join(dir, '.stow-global-ignore'));

  if (hasStowIgnore || hasStowGlobalIgnore) {
    return { isStow: true, confidence: 'high', packages };
  }

  if (hasPackageStructure && packages.length > 0) {
    return { isStow: true, confidence: 'medium', packages };
  }

  return { isStow: false, confidence: 'low', packages: [] };
}

async function detectStowFromSymlinks(): Promise<{ path: string; packages: string[] } | null> {
  // Find symlinks in home directory
  const homeEntries = await readdir(homedir(), { withFileTypes: true });
  const symlinks: Array<{ name: string; target: string }> = [];

  for (const entry of homeEntries) {
    if (entry.isSymbolicLink()) {
      const fullPath = join(homedir(), entry.name);
      const target = await readlink(fullPath);
      symlinks.push({ name: entry.name, target: resolve(dirname(fullPath), target) });
    }
  }

  // Also check .config
  const configPath = join(homedir(), '.config');
  if (await pathExists(configPath)) {
    const configEntries = await readdir(configPath, { withFileTypes: true });
    for (const entry of configEntries) {
      if (entry.isSymbolicLink()) {
        const fullPath = join(configPath, entry.name);
        const target = await readlink(fullPath);
        symlinks.push({
          name: `.config/${entry.name}`,
          target: resolve(dirname(fullPath), target),
        });
      }
    }
  }

  if (symlinks.length === 0) {
    return null;
  }

  // Find common parent directory
  const targetDirs = symlinks.map(s => dirname(s.target));
  const parents = new Map<string, number>();

  for (const dir of targetDirs) {
    // Walk up to find potential stow directory
    let current = dir;
    while (current !== homedir() && current !== '/') {
      const parent = dirname(current);
      parents.set(parent, (parents.get(parent) || 0) + 1);
      current = parent;
    }
  }

  // Find most common parent
  let bestParent: string | null = null;
  let bestCount = 0;

  for (const [parent, count] of parents) {
    if (count > bestCount) {
      bestCount = count;
      bestParent = parent;
    }
  }

  if (bestParent && bestCount >= 2) {
    // Get package names from immediate children
    const packages = [...new Set(
      symlinks
        .filter(s => s.target.startsWith(bestParent + '/'))
        .map(s => {
          const relative = s.target.slice(bestParent!.length + 1);
          return relative.split('/')[0];
        })
    )];

    return { path: bestParent, packages };
  }

  return null;
}
```

---

## Symlink Resolution

### Finding Stowed Files

Since stow creates symlinks, we need to:
1. Find all symlinks that point into the stow directory
2. Resolve them to actual files
3. Import the actual file content

```typescript
interface StowedFile {
  symlinkPath: string;    // e.g., ~/.zshrc
  targetPath: string;     // e.g., ~/dotfiles/zsh/.zshrc
  packageName: string;    // e.g., "zsh"
  relativePath: string;   // e.g., ".zshrc"
}

async function findStowedFiles(stowDir: string): Promise<StowedFile[]> {
  const stowedFiles: StowedFile[] = [];

  // Method 1: Walk stow directory and find expected symlinks
  const packages = await getPackages(stowDir);

  for (const pkg of packages) {
    const pkgPath = join(stowDir, pkg);
    const files = await walkDirectory(pkgPath);

    for (const file of files) {
      const relativePath = file.slice(pkgPath.length + 1);
      const expectedSymlink = join(homedir(), relativePath);

      // Check if symlink exists and points to this file
      if (await pathExists(expectedSymlink)) {
        const stats = await lstat(expectedSymlink);
        if (stats.isSymbolicLink()) {
          const target = await readlink(expectedSymlink);
          const resolvedTarget = resolve(dirname(expectedSymlink), target);

          if (resolvedTarget === file) {
            stowedFiles.push({
              symlinkPath: expectedSymlink,
              targetPath: file,
              packageName: pkg,
              relativePath,
            });
          }
        }
      }
    }
  }

  // Method 2: Find orphaned symlinks (stow dir moved/renamed)
  // This catches symlinks that might point to a different path

  return stowedFiles;
}

async function getPackages(stowDir: string): Promise<string[]> {
  const entries = await readdir(stowDir, { withFileTypes: true });

  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);
}
```

### Directory vs File Symlinks

Stow can create symlinks to entire directories or individual files:

```typescript
async function analyzeSymlink(
  symlinkPath: string
): Promise<'file' | 'directory' | 'broken'> {
  try {
    const stats = await stat(symlinkPath);  // Follows symlink
    return stats.isDirectory() ? 'directory' : 'file';
  } catch {
    return 'broken';
  }
}
```

---

## Package Discovery

### Mapping Packages to Categories

Stow packages often align with tuck categories:

```typescript
const PACKAGE_TO_CATEGORY: Record<string, string> = {
  // Shell
  'zsh': 'shell',
  'bash': 'shell',
  'shell': 'shell',
  'fish': 'shell',

  // Git
  'git': 'git',

  // Editors
  'vim': 'editors',
  'nvim': 'editors',
  'neovim': 'editors',
  'emacs': 'editors',
  'vscode': 'editors',

  // Terminal
  'tmux': 'terminal',
  'alacritty': 'terminal',
  'kitty': 'terminal',
  'wezterm': 'terminal',
  'starship': 'terminal',

  // SSH
  'ssh': 'ssh',
};

function packageToCategory(packageName: string): string {
  const lower = packageName.toLowerCase();

  // Direct match
  if (PACKAGE_TO_CATEGORY[lower]) {
    return PACKAGE_TO_CATEGORY[lower];
  }

  // Partial match
  for (const [pkg, category] of Object.entries(PACKAGE_TO_CATEGORY)) {
    if (lower.includes(pkg) || pkg.includes(lower)) {
      return category;
    }
  }

  // Fall back to detecting from files
  return 'misc';
}
```

### Ignore Patterns

Parse `.stow-local-ignore`:

```typescript
async function loadIgnorePatterns(stowDir: string): Promise<RegExp[]> {
  const patterns: RegExp[] = [];

  // Default ignores (stow's built-in)
  const defaultIgnores = [
    /^\.git$/,
    /^\.gitignore$/,
    /^README.*/,
    /^LICENSE$/,
    /^COPYING$/,
  ];
  patterns.push(...defaultIgnores);

  // Local ignore file
  const localIgnore = join(stowDir, '.stow-local-ignore');
  if (await pathExists(localIgnore)) {
    const content = await readFile(localIgnore, 'utf-8');
    const lines = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    for (const line of lines) {
      try {
        patterns.push(new RegExp(line));
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return patterns;
}

function shouldIgnore(path: string, patterns: RegExp[]): boolean {
  const filename = basename(path);
  return patterns.some(p => p.test(filename));
}
```

---

## Migration Steps

### Step 1: Detection and Validation

```typescript
async function step1_detect(providedPath?: string): Promise<void> {
  if (providedPath) {
    // User specified stow directory
    if (!await pathExists(providedPath)) {
      throw new Error(`Stow directory not found: ${providedPath}`);
    }
    this.stowDir = expandPath(providedPath);
  } else {
    // Auto-detect
    const detection = await this.detect();
    if (!detection.path) {
      throw new Error(
        'Could not detect stow directory. ' +
        'Please specify path: tuck migrate stow ~/dotfiles'
      );
    }
    this.stowDir = detection.path;
    this.packages = detection.metadata?.packages || [];
  }

  // Validate
  const { valid, issues } = await this.validate();
  for (const issue of issues) {
    logger.warn(issue);
  }
}
```

### Step 2: Enumerate Files

```typescript
async function step2_enumerateFiles(): Promise<MigratedFile[]> {
  const ignorePatterns = await loadIgnorePatterns(this.stowDir);
  const stowedFiles = await findStowedFiles(this.stowDir);
  const migratedFiles: MigratedFile[] = [];

  for (const stowed of stowedFiles) {
    // Check ignore patterns
    if (shouldIgnore(stowed.relativePath, ignorePatterns)) {
      continue;
    }

    // Determine symlink type
    const type = await analyzeSymlink(stowed.symlinkPath);
    if (type === 'broken') {
      logger.warn(`Broken symlink: ${stowed.symlinkPath}`);
      continue;
    }

    // Map package to category
    const category = packageToCategory(stowed.packageName);

    migratedFiles.push({
      originalPath: stowed.targetPath,
      targetPath: collapsePath(stowed.symlinkPath),
      sourcePath: stowed.targetPath,
      category,
      isTemplate: false,
      isEncrypted: false,
      metadata: {
        packageName: stowed.packageName,
        isDirectory: type === 'directory',
      },
      warnings: [],
    });
  }

  return migratedFiles;
}
```

### Step 3: Preview

```typescript
async function step3_preview(files: MigratedFile[]): Promise<void> {
  console.log('\n');
  prompts.log.info(`Found ${files.length} stowed files from ${this.packages.length} packages:`);
  console.log('\n');

  // Group by package
  const byPackage = groupBy(files, f => f.metadata.packageName);

  for (const [pkg, pkgFiles] of Object.entries(byPackage)) {
    console.log(`  [${pkg}] (${pkgFiles.length} files)`);
    for (const file of pkgFiles.slice(0, 5)) {
      console.log(`    ${file.targetPath}`);
    }
    if (pkgFiles.length > 5) {
      console.log(chalk.dim(`    ... and ${pkgFiles.length - 5} more`));
    }
  }

  console.log('\n');
}
```

### Step 4: Handle Symlinks

Before importing, we need to decide what to do with existing symlinks:

```typescript
async function step4_handleSymlinks(
  files: MigratedFile[],
  options: MigrationOptions
): Promise<void> {
  // Option 1: Remove symlinks, copy actual files
  // This is the default - tuck manages copies, not symlinks

  // Option 2: Keep symlinks, just update tuck manifest
  // This preserves stow's symlink behavior

  const strategy = options.keepSymlinks ? 'preserve' : 'copy';

  if (strategy === 'copy') {
    prompts.log.info('Will copy actual files and remove symlinks');
    prompts.log.info('Your stow directory will remain intact');
  } else {
    prompts.log.info('Will preserve symlinks and track them in tuck');
  }
}
```

### Step 5: Import Files

```typescript
async function step5_import(
  files: MigratedFile[],
  options: MigrationOptions
): Promise<MigrationResult> {
  const imported: MigratedFile[] = [];
  const failed: Array<{ file: MigratedFile; error: string }> = [];
  const skipped: MigratedFile[] = [];

  for (const file of files) {
    try {
      // Read actual content (resolves symlink)
      const content = await readFile(file.sourcePath);

      // Determine filename
      const filename = sanitizeFilename(file.targetPath);

      // Write to tuck
      const tuckDest = getDestinationPath(this.tuckDir, file.category, filename);

      if (file.metadata.isDirectory) {
        // Copy entire directory
        await copy(file.sourcePath, tuckDest);
      } else {
        await ensureDir(dirname(tuckDest));
        await writeFile(tuckDest, content);
      }

      // Preserve permissions
      const stats = await stat(file.sourcePath);
      await chmod(tuckDest, stats.mode);

      // Add to manifest
      const checksum = await getFileChecksum(tuckDest);
      await addFileToManifest(this.tuckDir, generateFileId(file.targetPath), {
        source: file.targetPath,
        destination: getRelativeDestination(file.category, filename),
        category: file.category,
        strategy: 'copy',  // Tuck default
        encrypted: false,
        template: false,
        permissions: (stats.mode & 0o777).toString(8),
        added: new Date().toISOString(),
        modified: new Date().toISOString(),
        checksum,
      });

      imported.push(file);
    } catch (error) {
      failed.push({ file, error: String(error) });
    }
  }

  return {
    success: failed.length === 0,
    imported,
    failed,
    skipped,
    warnings: [],
    cleanedUp: false,
  };
}
```

### Step 6: Cleanup (Optional)

```typescript
async function step6_cleanup(importedFiles: MigratedFile[]): Promise<void> {
  const shouldCleanup = await prompts.confirm(
    'Remove stow symlinks and stow directory?',
    false
  );

  if (!shouldCleanup) {
    logger.info('Keeping stow installation');
    logger.info('Note: You may want to unstow packages manually:');
    logger.info(`  cd ${this.stowDir} && stow -D ${this.packages.join(' ')}`);
    return;
  }

  // Backup stow directory
  const backupPath = await backupDirectory(this.stowDir);
  logger.info(`Backed up stow directory to: ${backupPath}`);

  // Remove symlinks in home
  for (const file of importedFiles) {
    const symlinkPath = expandPath(file.targetPath);

    // Verify it's still a symlink (not replaced)
    const stats = await lstat(symlinkPath).catch(() => null);
    if (stats?.isSymbolicLink()) {
      await unlink(symlinkPath);
    }
  }

  // Optionally remove stow directory
  const removeStowDir = await prompts.confirm(
    `Remove stow directory? (${this.stowDir})`,
    false
  );

  if (removeStowDir) {
    await rm(this.stowDir, { recursive: true });
    logger.success('Stow directory removed');
  }

  // Now run tuck restore to create files in home
  logger.info("Run 'tuck restore' to restore files to home directory");
}
```

---

## Edge Cases

### 1. Nested Symlink Directories

Stow may create a symlink to a directory, which then contains more symlinks:

```
~/.config → ~/dotfiles/base/.config  (symlink to directory)
```

**Solution:** Detect directory symlinks and walk their contents.

### 2. Conflicting Files

If a file exists in home that isn't a symlink (not managed by stow):

```
~/.zshrc  (regular file, not symlink)
```

**Solution:** Warn user, skip or ask to overwrite.

### 3. Broken Symlinks

Symlinks pointing to non-existent targets:

```
~/.oldconfig → ~/dotfiles/old/.oldconfig  (target deleted)
```

**Solution:** Skip broken symlinks, warn user.

### 4. Multiple Stow Directories

User might have multiple stow directories:

```
~/dotfiles/        # Personal configs
~/work-dotfiles/   # Work configs
```

**Solution:** Detect and migrate one at a time, or let user specify.

### 5. Folding

Stow's "folding" creates directory symlinks instead of individual file symlinks:

```
# Instead of:
~/.config/nvim/init.lua → ~/dotfiles/nvim/.config/nvim/init.lua

# Stow might create:
~/.config/nvim → ~/dotfiles/nvim/.config/nvim
```

**Solution:** Detect directory symlinks and enumerate contents.

### 6. Tree Folding/Unfolding Conflicts

When stow needs to unfold a directory symlink to add more files:

**Solution:** Not relevant for migration - we import actual content.

### 7. Adopt Mode

Stow's `--adopt` can create unusual states where files exist in both places.

**Solution:** Always prefer the actual file content, warn about mismatches.

### 8. Absolute vs Relative Symlinks

Stow typically creates relative symlinks, but absolute ones may exist:

```
~/.zshrc → /home/user/dotfiles/zsh/.zshrc  (absolute)
~/.zshrc → ../dotfiles/zsh/.zshrc          (relative)
```

**Solution:** Handle both by resolving to absolute paths.

---

## Implementation

### File: `src/lib/migrate/stow.ts`

```typescript
import { join, dirname, basename, resolve } from 'path';
import { homedir } from 'os';
import { readdir, readFile, readlink, stat, lstat, unlink, chmod } from 'fs/promises';
import { copy } from 'fs-extra';
import type { Migrator, DetectionResult, MigratedFile, MigrationResult, MigrationOptions } from './index.js';
import { pathExists, expandPath, collapsePath } from '../paths.js';

export class StowMigrator implements Migrator {
  readonly name = 'stow';
  readonly displayName = 'GNU Stow';

  private stowDir: string | null = null;
  private packages: string[] = [];
  private tuckDir: string;
  private ignorePatterns: RegExp[] = [];

  constructor(tuckDir: string) {
    this.tuckDir = tuckDir;
  }

  async detect(): Promise<DetectionResult> {
    // Implementation as described above
  }

  async getTrackedFiles(): Promise<MigratedFile[]> {
    return this.enumerateFiles();
  }

  async validate(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!this.stowDir || !await pathExists(this.stowDir)) {
      issues.push('Stow directory not found');
      return { valid: false, issues };
    }

    // Check for packages
    const packages = await this.getPackages();
    if (packages.length === 0) {
      issues.push('No stow packages found');
    }

    // Check for broken symlinks
    const stowedFiles = await this.findStowedFiles();
    const broken = stowedFiles.filter(async f => {
      const type = await this.analyzeSymlink(f.symlinkPath);
      return type === 'broken';
    });

    if (broken.length > 0) {
      issues.push(`${broken.length} broken symlink(s) found - will be skipped`);
    }

    return { valid: issues.filter(i => i.includes('not found')).length === 0, issues };
  }

  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    // Detection
    await this.step1_detect(options.path);

    // Load ignore patterns
    this.ignorePatterns = await this.loadIgnorePatterns();

    // Enumerate files
    const files = await this.step2_enumerateFiles();

    if (options.dryRun) {
      await this.step3_preview(files);
      return {
        success: true,
        imported: [],
        failed: [],
        skipped: files,
        warnings: ['Dry run - no changes made'],
        cleanedUp: false,
      };
    }

    // Confirm
    if (!options.force) {
      await this.step3_preview(files);
      const confirmed = await prompts.confirm(
        `Import ${files.length} files?`,
        true
      );
      if (!confirmed) {
        return {
          success: false,
          imported: [],
          failed: [],
          skipped: files,
          warnings: ['Migration cancelled by user'],
          cleanedUp: false,
        };
      }
    }

    // Create backup
    await createMigrationBackup(this.tuckDir);

    // Import
    const result = await this.step5_import(files, options);

    // Cleanup
    if (!options.keepOld && result.success) {
      await this.step6_cleanup(result.imported);
    }

    return result;
  }

  async cleanup(): Promise<void> {
    // Implementation as described above
  }

  // Private helpers
  private async getPackages(): Promise<string[]> { /* ... */ }
  private async findStowedFiles(): Promise<StowedFile[]> { /* ... */ }
  private async loadIgnorePatterns(): Promise<RegExp[]> { /* ... */ }
  private async analyzeSymlink(path: string): Promise<'file' | 'directory' | 'broken'> { /* ... */ }
}
```

---

## Testing

### Unit Tests

```typescript
describe('StowMigrator', () => {
  describe('looksLikeStowDir', () => {
    it('should detect stow directory with .stow-local-ignore', async () => {
      // Test with mock filesystem
    });

    it('should detect stow directory by package structure', async () => {
      // Test with packages containing dotfiles
    });

    it('should not detect random directories', async () => {
      // Test with non-stow directories
    });
  });

  describe('findStowedFiles', () => {
    it('should find symlinks pointing to stow packages', async () => {
      // Create test symlinks
    });

    it('should handle directory symlinks (folding)', async () => {
      // Test folded directory symlinks
    });

    it('should detect broken symlinks', async () => {
      // Test broken symlinks
    });
  });

  describe('packageToCategory', () => {
    const testCases = [
      { input: 'zsh', expected: 'shell' },
      { input: 'ZSH', expected: 'shell' },
      { input: 'my-zsh-config', expected: 'shell' },
      { input: 'nvim', expected: 'editors' },
      { input: 'neovim', expected: 'editors' },
      { input: 'random-package', expected: 'misc' },
    ];

    for (const { input, expected } of testCases) {
      it(`should map "${input}" to "${expected}"`, () => {
        expect(packageToCategory(input)).toBe(expected);
      });
    }
  });

  describe('loadIgnorePatterns', () => {
    it('should load default patterns', async () => {
      const patterns = await loadIgnorePatterns('/empty/dir');
      expect(patterns.some(p => p.test('.git'))).toBe(true);
    });

    it('should load custom patterns from .stow-local-ignore', async () => {
      // Test with custom ignore file
    });
  });
});
```

### Integration Tests

```typescript
describe('Stow Migration Integration', () => {
  let testDir: string;
  let stowDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'stow-test-'));
    stowDir = join(testDir, 'dotfiles');
    homeDir = join(testDir, 'home');

    await mkdir(stowDir);
    await mkdir(homeDir);

    // Create stow package structure
    await mkdir(join(stowDir, 'zsh'));
    await writeFile(join(stowDir, 'zsh', '.zshrc'), 'export PATH=$PATH');

    await mkdir(join(stowDir, 'git'));
    await writeFile(join(stowDir, 'git', '.gitconfig'), '[user]\nname = Test');

    // Create symlinks in "home"
    await symlink(
      join(stowDir, 'zsh', '.zshrc'),
      join(homeDir, '.zshrc')
    );
    await symlink(
      join(stowDir, 'git', '.gitconfig'),
      join(homeDir, '.gitconfig')
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it('should detect stow directory', async () => {
    // Test detection
  });

  it('should enumerate stowed files', async () => {
    // Test file enumeration
  });

  it('should import stowed files', async () => {
    // Test import
  });

  it('should handle directory symlinks', async () => {
    // Test folded directories
  });
});
```

---

## Summary

GNU Stow migration is straightforward because:

1. **No templates** - Files are actual content
2. **No encryption** - No decryption needed
3. **Clear structure** - Packages map to categories
4. **Symlink resolution** - Well-defined process

Key implementation points:

1. **Detect stow directory** - Check common locations or analyze symlinks
2. **Find stowed files** - Walk packages and match symlinks
3. **Resolve symlinks** - Get actual file content
4. **Map packages to categories** - Use naming conventions
5. **Import content** - Copy files, remove symlinks optionally

The main complexity is handling symlink edge cases (folding, broken links, directory symlinks).

---

*Last updated: December 2024*
