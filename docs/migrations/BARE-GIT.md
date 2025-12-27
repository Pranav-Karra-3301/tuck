# Bare Git Repository Migration Plan

> Detailed implementation guide for migrating from bare git repo pattern to tuck

---

## Table of Contents

1. [Overview](#overview)
2. [Bare Git Pattern Analysis](#bare-git-pattern-analysis)
3. [Detection Strategy](#detection-strategy)
4. [File Enumeration](#file-enumeration)
5. [Migration Steps](#migration-steps)
6. [Edge Cases](#edge-cases)
7. [Implementation](#implementation)
8. [Testing](#testing)

---

## Overview

The "bare git repository" pattern stores dotfiles by using a bare git repository with `$HOME` as the work tree. This avoids symlinks by tracking files directly where they live. It's a popular minimal approach requiring no additional tools.

### Key Advantages for Migration

1. **Simplest migration** - No templates, encryption, or special features
2. **Files already in place** - No symlink resolution needed
3. **Standard git** - Use familiar git commands
4. **No dependencies** - Just needs git

### Pattern Origins

This technique was popularized by [Atlassian's dotfiles tutorial](https://www.atlassian.com/git/tutorials/dotfiles) and various HN discussions. Common implementations use an alias like `config` or `dotfiles`.

---

## Bare Git Pattern Analysis

### How It Works

1. Create a bare git repository in a hidden folder:
   ```bash
   git init --bare $HOME/.cfg
   ```

2. Create an alias that specifies the git-dir and work-tree:
   ```bash
   alias config='/usr/bin/git --git-dir=$HOME/.cfg/ --work-tree=$HOME'
   ```

3. Ignore untracked files (so `git status` is clean):
   ```bash
   config config --local status.showUntrackedFiles no
   ```

4. Track files with the alias:
   ```bash
   config add ~/.zshrc
   config commit -m "Add zshrc"
   ```

### Common Directory Locations

```
~/.cfg/                    # Most common (from Atlassian tutorial)
~/.dotfiles.git/           # Descriptive name
~/.dotfiles/               # May be bare or regular
~/.myconfig/               # Personal variation
~/.config.git/             # XDG-inspired
$DOTFILES/                 # Environment variable
```

### Git Configuration

The bare repo typically has these settings:

```ini
# In .cfg/config (or similar)
[core]
    bare = true
    worktree = /home/user
[status]
    showUntrackedFiles = no
```

### Alias Patterns

Common aliases found in shell configs:

```bash
# Standard pattern
alias config='/usr/bin/git --git-dir=$HOME/.cfg/ --work-tree=$HOME'

# Alternative names
alias dotfiles='git --git-dir=$HOME/.dotfiles.git/ --work-tree=$HOME'
alias dot='git --git-dir=$HOME/.dot/ --work-tree=$HOME'

# Git alias variant
git config --global alias.dtf '!git --git-dir=$HOME/.dotfiles --work-tree=$HOME'
```

---

## Detection Strategy

### Detection Steps

```typescript
async function detectBareGitRepo(): Promise<DetectionResult> {
  // Common bare repo locations
  const candidates = [
    join(homedir(), '.cfg'),
    join(homedir(), '.dotfiles.git'),
    join(homedir(), '.dotfiles'),
    join(homedir(), '.myconfig'),
    join(homedir(), '.config.git'),
    join(homedir(), '.dot'),
    process.env.DOTFILES,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!await pathExists(candidate)) continue;

    const isBare = await isBareGitRepo(candidate);
    if (isBare) {
      const worktree = await getWorktree(candidate);

      return {
        tool: 'bare',
        path: candidate,
        confidence: 'high',
        metadata: {
          worktree,
          alias: await detectAlias(candidate),
        },
      };
    }
  }

  // Check shell configs for aliases
  const aliasResult = await detectFromShellConfig();
  if (aliasResult) {
    return aliasResult;
  }

  return { tool: null, path: null, confidence: 'low' };
}

async function isBareGitRepo(path: string): Promise<boolean> {
  try {
    // Check for bare repo markers
    const hasHead = await pathExists(join(path, 'HEAD'));
    const hasConfig = await pathExists(join(path, 'config'));
    const hasObjects = await pathExists(join(path, 'objects'));

    if (!(hasHead && hasConfig && hasObjects)) {
      return false;
    }

    // Verify it's actually bare
    const configContent = await readFile(join(path, 'config'), 'utf-8');
    return configContent.includes('bare = true');
  } catch {
    return false;
  }
}

async function getWorktree(gitDir: string): Promise<string> {
  try {
    // Check git config for worktree
    const { stdout } = await execAsync(
      `git --git-dir="${gitDir}" config core.worktree`
    );
    return stdout.trim() || homedir();
  } catch {
    // Default to home
    return homedir();
  }
}

async function detectAlias(gitDir: string): Promise<string | null> {
  // Search shell config files for matching alias
  const shellConfigs = [
    join(homedir(), '.bashrc'),
    join(homedir(), '.bash_profile'),
    join(homedir(), '.zshrc'),
    join(homedir(), '.config', 'fish', 'config.fish'),
  ];

  const escapedGitDir = gitDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliasPattern = new RegExp(
    `alias\\s+(\\w+)\\s*=\\s*['"](git|/usr/bin/git)\\s+--git-dir=.*(${basename(gitDir)}|${escapedGitDir})`,
    'i'
  );

  for (const configPath of shellConfigs) {
    if (!await pathExists(configPath)) continue;

    const content = await readFile(configPath, 'utf-8');
    const match = content.match(aliasPattern);

    if (match) {
      return match[1];  // The alias name
    }
  }

  return null;
}

async function detectFromShellConfig(): Promise<DetectionResult | null> {
  // Common alias patterns to search for
  const patterns = [
    /alias\s+(\w+)\s*=\s*['"]?(?:\/usr\/bin\/)?git\s+--git-dir=([^'"\s]+)/g,
    /git\s+config\s+--global\s+alias\.(\w+)\s+['"]!git\s+--git-dir=([^'"\s]+)/g,
  ];

  const shellConfigs = [
    join(homedir(), '.bashrc'),
    join(homedir(), '.bash_profile'),
    join(homedir(), '.zshrc'),
    join(homedir(), '.config', 'fish', 'config.fish'),
  ];

  for (const configPath of shellConfigs) {
    if (!await pathExists(configPath)) continue;

    const content = await readFile(configPath, 'utf-8');

    for (const pattern of patterns) {
      const matches = [...content.matchAll(pattern)];
      for (const match of matches) {
        const aliasName = match[1];
        let gitDir = match[2];

        // Expand variables
        gitDir = gitDir
          .replace(/\$HOME|\${HOME}/g, homedir())
          .replace(/~\//g, homedir() + '/');

        if (await isBareGitRepo(gitDir)) {
          return {
            tool: 'bare',
            path: gitDir,
            confidence: 'high',
            metadata: {
              worktree: await getWorktree(gitDir),
              alias: aliasName,
              detectedFromAlias: true,
            },
          };
        }
      }
    }
  }

  return null;
}
```

---

## File Enumeration

### Listing Tracked Files

```typescript
async function getTrackedFiles(gitDir: string, worktree: string): Promise<string[]> {
  // List all tracked files
  const { stdout } = await execAsync(
    `git --git-dir="${gitDir}" --work-tree="${worktree}" ls-tree -r --name-only HEAD`
  );

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(f => join(worktree, f));
}

async function getFileStatus(
  gitDir: string,
  worktree: string
): Promise<Map<string, 'clean' | 'modified' | 'deleted'>> {
  const status = new Map<string, 'clean' | 'modified' | 'deleted'>();

  // Get status of all tracked files
  const { stdout } = await execAsync(
    `git --git-dir="${gitDir}" --work-tree="${worktree}" status --porcelain=v1`
  );

  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;

    const statusCode = line.slice(0, 2);
    const filepath = line.slice(3);

    if (statusCode.includes('D')) {
      status.set(filepath, 'deleted');
    } else if (statusCode.includes('M') || statusCode.includes('A')) {
      status.set(filepath, 'modified');
    }
  }

  return status;
}
```

### Filtering Files

```typescript
function shouldImportFile(filepath: string): boolean {
  // Skip shell config if it contains the dotfiles alias
  // (We might be tracking the file that defines the alias)

  // Skip git-related files in home
  if (basename(filepath) === '.gitconfig') {
    return true;  // This is a dotfile we want
  }

  // Skip obvious non-dotfiles that might be accidentally tracked
  const skipPatterns = [
    /^LICENSE$/,
    /^README/i,
    /^\.git\//,          // Never import .git directory contents
    /^\.gitmodules$/,    // Submodule config
  ];

  const relativePath = filepath.startsWith(homedir())
    ? filepath.slice(homedir().length + 1)
    : filepath;

  return !skipPatterns.some(p => p.test(relativePath));
}
```

---

## Migration Steps

### Step 1: Detection and Validation

```typescript
async function step1_detect(providedPath?: string): Promise<void> {
  if (providedPath) {
    // User specified git directory
    const fullPath = expandPath(providedPath);

    if (!await isBareGitRepo(fullPath)) {
      throw new Error(`Not a bare git repository: ${providedPath}`);
    }

    this.gitDir = fullPath;
    this.worktree = await getWorktree(fullPath);
  } else {
    // Auto-detect
    const detection = await this.detect();

    if (!detection.path) {
      throw new Error(
        'Could not detect bare git repository. ' +
        'Please specify path: tuck migrate bare ~/.cfg'
      );
    }

    this.gitDir = detection.path;
    this.worktree = detection.metadata?.worktree || homedir();
    this.alias = detection.metadata?.alias;
  }

  logger.info(`Found bare git repo: ${this.gitDir}`);
  logger.info(`Work tree: ${this.worktree}`);
  if (this.alias) {
    logger.info(`Alias: ${this.alias}`);
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
  const tracked = await getTrackedFiles(this.gitDir, this.worktree);
  const status = await getFileStatus(this.gitDir, this.worktree);
  const migratedFiles: MigratedFile[] = [];

  for (const filepath of tracked) {
    // Skip non-importable files
    if (!shouldImportFile(filepath)) {
      continue;
    }

    // Check if file still exists
    if (!await pathExists(filepath)) {
      logger.warn(`Tracked file not found: ${filepath}`);
      continue;
    }

    // Check status
    const fileStatus = status.get(filepath.slice(this.worktree.length + 1));
    const warnings: string[] = [];

    if (fileStatus === 'modified') {
      warnings.push('File has uncommitted changes');
    }

    migratedFiles.push({
      originalPath: filepath,
      targetPath: collapsePath(filepath),
      sourcePath: filepath,
      category: categorizeFile(filepath),
      isTemplate: false,
      isEncrypted: false,
      metadata: {
        status: fileStatus || 'clean',
      },
      warnings,
    });
  }

  return migratedFiles;
}
```

### Step 3: Preview

```typescript
async function step3_preview(files: MigratedFile[]): Promise<void> {
  console.log('\n');
  prompts.log.info(`Found ${files.length} tracked files:`);
  console.log('\n');

  // Group by category
  const byCategory = groupBy(files, f => f.category);

  for (const [category, categoryFiles] of Object.entries(byCategory)) {
    const icon = CATEGORIES[category]?.icon || '-';
    console.log(`  ${icon} ${category} (${categoryFiles.length})`);

    for (const file of categoryFiles.slice(0, 5)) {
      let suffix = '';
      if (file.metadata.status === 'modified') {
        suffix = chalk.yellow(' (modified)');
      }
      console.log(`    ${file.targetPath}${suffix}`);
    }

    if (categoryFiles.length > 5) {
      console.log(chalk.dim(`    ... and ${categoryFiles.length - 5} more`));
    }
  }

  console.log('\n');

  // Warn about modified files
  const modified = files.filter(f => f.metadata.status === 'modified');
  if (modified.length > 0) {
    prompts.log.warn(
      `${modified.length} file(s) have uncommitted changes.\n` +
      `  Consider committing changes before migration.`
    );
  }
}
```

### Step 4: Handle Uncommitted Changes

```typescript
async function step4_handleUncommitted(
  files: MigratedFile[]
): Promise<'commit' | 'proceed' | 'cancel'> {
  const modified = files.filter(f => f.metadata.status === 'modified');

  if (modified.length === 0) {
    return 'proceed';
  }

  const choice = await prompts.select(
    `${modified.length} files have uncommitted changes. What would you like to do?`,
    [
      { value: 'commit', label: 'Commit changes before migration' },
      { value: 'proceed', label: 'Proceed anyway (import current state)' },
      { value: 'cancel', label: 'Cancel migration' },
    ]
  );

  if (choice === 'commit') {
    // Commit changes using the bare repo
    await execAsync(
      `git --git-dir="${this.gitDir}" --work-tree="${this.worktree}" add -A`
    );
    await execAsync(
      `git --git-dir="${this.gitDir}" --work-tree="${this.worktree}" commit -m "Pre-migration commit"`
    );
    logger.success('Changes committed');
  }

  return choice as 'commit' | 'proceed' | 'cancel';
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
      // Read file content
      const content = await readFile(file.sourcePath);

      // Determine filename for tuck storage
      const filename = sanitizeFilename(file.targetPath);

      // Write to tuck
      const tuckDest = getDestinationPath(this.tuckDir, file.category, filename);
      await ensureDir(dirname(tuckDest));
      await writeFile(tuckDest, content);

      // Preserve permissions
      const stats = await stat(file.sourcePath);
      await chmod(tuckDest, stats.mode);

      // Add to manifest
      const checksum = await getFileChecksum(tuckDest);
      await addFileToManifest(this.tuckDir, generateFileId(file.targetPath), {
        source: file.targetPath,
        destination: getRelativeDestination(file.category, filename),
        category: file.category,
        strategy: 'copy',
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
async function step6_cleanup(): Promise<void> {
  const shouldCleanup = await prompts.confirm(
    'Remove bare git repository and alias?',
    false
  );

  if (!shouldCleanup) {
    logger.info('Keeping bare git repository');
    logger.info(`Note: You can still use '${this.alias || 'git'}' commands`);
    logger.info('Your dotfiles are now also managed by tuck.');
    return;
  }

  // Backup git directory
  const backupPath = join(
    homedir(),
    `.tuck-backups/bare-git-${Date.now()}`
  );
  await copy(this.gitDir, backupPath);
  logger.info(`Backed up git directory to: ${backupPath}`);

  // Remove bare repo
  await rm(this.gitDir, { recursive: true });
  logger.success(`Removed ${this.gitDir}`);

  // Offer to remove alias
  if (this.alias) {
    const removeAlias = await prompts.confirm(
      `Remove '${this.alias}' alias from shell config?`,
      true
    );

    if (removeAlias) {
      await this.removeAliasFromShellConfigs();
      logger.success(`Removed alias '${this.alias}'`);
      logger.info('Please restart your shell or source your config');
    }
  }
}

async function removeAliasFromShellConfigs(): Promise<void> {
  const shellConfigs = [
    join(homedir(), '.bashrc'),
    join(homedir(), '.bash_profile'),
    join(homedir(), '.zshrc'),
  ];

  const aliasPattern = new RegExp(
    `^\\s*alias\\s+${this.alias}\\s*=.*$`,
    'gm'
  );

  for (const configPath of shellConfigs) {
    if (!await pathExists(configPath)) continue;

    let content = await readFile(configPath, 'utf-8');
    const newContent = content.replace(aliasPattern, '');

    if (newContent !== content) {
      // Backup original
      await writeFile(configPath + '.bak', content);
      // Write modified
      await writeFile(configPath, newContent);
      logger.dim(`Removed alias from ${configPath}`);
    }
  }
}
```

---

## Edge Cases

### 1. Repository in Unusual Location

User might store repo in non-standard location:

```bash
git init --bare /external/drive/dotfiles.git
```

**Solution:** Accept path as argument, validate it's a bare repo.

### 2. Non-Home Work Tree

Repo might have work tree set to somewhere other than `$HOME`:

```bash
git config core.worktree /custom/path
```

**Solution:** Read core.worktree from git config.

### 3. Multiple Bare Repos

User might have multiple bare repos for different purposes:

```
~/.cfg              # Personal dotfiles
~/.work-cfg         # Work dotfiles
```

**Solution:** Migrate one at a time, let user specify which.

### 4. Submodules

Bare repo might use submodules for plugins:

```
~/.vim/bundle/plugin (submodule)
```

**Solution:** Warn about submodules, don't follow them.

### 5. Binary Files

May track large binary files:

```
~/.local/bin/large-executable
```

**Solution:** Warn about large files, offer to skip.

### 6. Files Outside Home

Some configs might be outside home:

```bash
config add /etc/hosts  # System file
```

**Solution:** Skip files outside home, warn user.

### 7. Alias Collision

User's alias might conflict with tuck:

```bash
alias config='...'  # Conflicts with tuck config command
```

**Solution:** No actual conflict since tuck uses full command.

### 8. Shell Config Tracking

The bare repo often tracks the shell config that contains its own alias:

```bash
config add ~/.zshrc  # Contains "alias config=..."
```

**Solution:** Import the file but note the alias will be outdated after cleanup.

### 9. Remote Repository

Bare repo usually has a remote for backup:

```
origin → git@github.com:user/dotfiles.git
```

**Solution:** Note the remote URL in migration output for user reference.

### 10. Uncommitted Changes with Conflicts

Modified files might cause import issues:

**Solution:** Offer to commit changes first, or proceed with current state.

---

## Implementation

### File: `src/lib/migrate/bare.ts`

```typescript
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { readFile, stat, chmod, readdir } from 'fs/promises';
import { copy } from 'fs-extra';
import type { Migrator, DetectionResult, MigratedFile, MigrationResult, MigrationOptions } from './index.js';
import { pathExists, expandPath, collapsePath } from '../paths.js';
import { execAsync } from './common.js';

export class BareGitMigrator implements Migrator {
  readonly name = 'bare';
  readonly displayName = 'Bare Git Repository';

  private gitDir: string | null = null;
  private worktree: string = homedir();
  private alias: string | null = null;
  private tuckDir: string;

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

    if (!this.gitDir) {
      issues.push('Bare git repository not detected');
      return { valid: false, issues };
    }

    // Check worktree
    if (!await pathExists(this.worktree)) {
      issues.push(`Work tree not found: ${this.worktree}`);
    }

    // Check for uncommitted changes
    const status = await getFileStatus(this.gitDir, this.worktree);
    const modified = [...status.values()].filter(s => s === 'modified').length;
    if (modified > 0) {
      issues.push(`${modified} file(s) have uncommitted changes`);
    }

    // Check for remote (informational)
    try {
      const { stdout } = await execAsync(
        `git --git-dir="${this.gitDir}" remote get-url origin`
      );
      if (stdout.trim()) {
        logger.info(`Remote repository: ${stdout.trim()}`);
      }
    } catch {
      // No remote
    }

    return { valid: !issues.some(i => i.includes('not found') || i.includes('not detected')), issues };
  }

  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    // Detection
    await this.step1_detect(options.path);

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

    // Preview and confirm
    if (!options.force) {
      await this.step3_preview(files);

      // Handle uncommitted changes
      const uncommittedChoice = await this.step4_handleUncommitted(files);
      if (uncommittedChoice === 'cancel') {
        return {
          success: false,
          imported: [],
          failed: [],
          skipped: files,
          warnings: ['Migration cancelled by user'],
          cleanedUp: false,
        };
      }

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
      await this.step6_cleanup();
    }

    return result;
  }

  async cleanup(): Promise<void> {
    await this.step6_cleanup();
  }

  // Private helpers
  private async isBareGitRepo(path: string): Promise<boolean> { /* ... */ }
  private async getWorktree(gitDir: string): Promise<string> { /* ... */ }
  private async detectAlias(gitDir: string): Promise<string | null> { /* ... */ }
}
```

---

## Testing

### Unit Tests

```typescript
describe('BareGitMigrator', () => {
  describe('isBareGitRepo', () => {
    it('should detect valid bare repo', async () => {
      // Create temp bare repo
      const testDir = await mkdtemp(join(tmpdir(), 'bare-test-'));
      await execAsync(`git init --bare "${testDir}"`);

      const result = await isBareGitRepo(testDir);
      expect(result).toBe(true);

      await rm(testDir, { recursive: true });
    });

    it('should reject regular repo', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'bare-test-'));
      await execAsync(`git init "${testDir}"`);  // Not bare

      const result = await isBareGitRepo(testDir);
      expect(result).toBe(false);

      await rm(testDir, { recursive: true });
    });

    it('should reject non-git directory', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'bare-test-'));

      const result = await isBareGitRepo(testDir);
      expect(result).toBe(false);

      await rm(testDir, { recursive: true });
    });
  });

  describe('detectAlias', () => {
    it('should find alias in bashrc', async () => {
      // Create temp bashrc with alias
      const content = `
        alias config='/usr/bin/git --git-dir=$HOME/.cfg/ --work-tree=$HOME'
      `;
      // Mock readFile or use temp file
    });

    it('should find git alias', async () => {
      // Test git config alias pattern
    });

    it('should return null when no alias found', async () => {
      // Test with empty shell configs
    });
  });

  describe('getTrackedFiles', () => {
    it('should list all tracked files', async () => {
      // Create bare repo with tracked files
    });

    it('should handle empty repo', async () => {
      // Test with no tracked files
    });
  });

  describe('shouldImportFile', () => {
    const testCases = [
      { input: '/home/user/.zshrc', expected: true },
      { input: '/home/user/.gitconfig', expected: true },
      { input: '/home/user/README.md', expected: false },
      { input: '/home/user/LICENSE', expected: false },
      { input: '/home/user/.git/config', expected: false },
    ];

    for (const { input, expected } of testCases) {
      it(`should ${expected ? 'import' : 'skip'} "${input}"`, () => {
        expect(shouldImportFile(input)).toBe(expected);
      });
    }
  });
});
```

### Integration Tests

```typescript
describe('Bare Git Migration Integration', () => {
  let testDir: string;
  let bareRepo: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'bare-int-test-'));
    bareRepo = join(testDir, '.cfg');
    homeDir = join(testDir, 'home');

    await mkdir(homeDir);

    // Create bare repo
    await execAsync(`git init --bare "${bareRepo}"`);

    // Set work tree
    await execAsync(
      `git --git-dir="${bareRepo}" config core.worktree "${homeDir}"`
    );

    // Create and track a dotfile
    await writeFile(join(homeDir, '.zshrc'), 'export PATH=$PATH');
    await execAsync(
      `git --git-dir="${bareRepo}" --work-tree="${homeDir}" add .zshrc`
    );
    await execAsync(
      `git --git-dir="${bareRepo}" --work-tree="${homeDir}" commit -m "Add zshrc"`
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it('should detect bare repo', async () => {
    const migrator = new BareGitMigrator('/tmp/tuck');
    const result = await migrator.detect();

    // Would need to mock homedir() for this test
  });

  it('should enumerate tracked files', async () => {
    const files = await getTrackedFiles(bareRepo, homeDir);
    expect(files).toContain(join(homeDir, '.zshrc'));
  });

  it('should detect uncommitted changes', async () => {
    // Modify file
    await writeFile(join(homeDir, '.zshrc'), 'export PATH=$PATH:/new');

    const status = await getFileStatus(bareRepo, homeDir);
    expect(status.get('.zshrc')).toBe('modified');
  });
});
```

---

## Summary

Bare git repository migration is the simplest because:

1. **No special features** - Just tracked files
2. **Files in place** - Already at their target locations
3. **Standard git** - Use familiar commands
4. **No dependencies** - Just git

Key implementation points:

1. **Detect bare repo** - Check common locations and shell configs
2. **Get worktree** - Read from git config
3. **List tracked files** - Use `git ls-tree`
4. **Handle uncommitted changes** - Offer to commit or proceed
5. **Clean up alias** - Remove from shell configs

The main complexity is detecting the bare repo location, especially when the user has a custom alias.

---

*Last updated: December 2024*
