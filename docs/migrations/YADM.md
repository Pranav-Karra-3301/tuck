# Yadm Migration Plan

> Detailed implementation guide for migrating from yadm to tuck

---

## Table of Contents

1. [Overview](#overview)
2. [Yadm Structure Analysis](#yadm-structure-analysis)
3. [Detection Strategy](#detection-strategy)
4. [Alternate Files](#alternate-files)
5. [Encryption Handling](#encryption-handling)
6. [Template Processing](#template-processing)
7. [Migration Steps](#migration-steps)
8. [Edge Cases](#edge-cases)
9. [Implementation](#implementation)
10. [Testing](#testing)

---

## Overview

Yadm (Yet Another Dotfiles Manager) wraps Git to manage dotfiles directly in the home directory using a bare repository pattern. It adds features like alternate files for machine-specific configs, encryption, and templates.

### Key Challenges

1. **Bare git repo** - Files are tracked directly in `$HOME`, not in a subdirectory
2. **Alternate files** - Machine-specific variants with `##` suffix notation
3. **Encryption** - Files encrypted with GPG or OpenSSL stored in an archive
4. **Templates** - Multiple template engines (default, esh, j2cli)
5. **Bootstrap script** - May contain setup logic

### Yadm Resources

- Official docs: https://yadm.io/
- GitHub: https://github.com/yadm-dev/yadm
- Man page: https://yadm.io/docs/man

---

## Yadm Structure Analysis

### Directory Locations

```
# Yadm v3 (current) - XDG compliant
~/.config/yadm/               # Configuration directory ($YADM_DIR)
├── config                    # Yadm configuration
├── encrypt                   # Encryption patterns
├── alt/                      # Alternate files directory
├── hooks/                    # Pre/post hooks
└── bootstrap                 # Bootstrap script

~/.local/share/yadm/          # Data directory ($YADM_DATA)
├── repo.git/                 # Bare git repository
└── archive                   # Encrypted files archive

# Yadm v2 (legacy)
~/.yadm/                      # Everything in one directory
├── repo.git/
├── encrypt
└── config
```

### Configuration File

Located at `~/.config/yadm/config` (or `~/.yadm/config` for v2):

```ini
[yadm]
    auto-alt = true
    auto-perms = true
    cipher = gpg

[local]
    class = workstation
    hostname = my-laptop
```

### Tracked Files Location

Unlike other tools, yadm tracks files **directly in `$HOME`**:

```
~/
├── .zshrc                    # Tracked by yadm
├── .gitconfig                # Tracked by yadm
├── .config/
│   └── nvim/
│       └── init.lua          # Tracked by yadm
└── .local/share/yadm/
    └── repo.git/             # The bare git repo
```

---

## Detection Strategy

### Detection Steps

```typescript
async function detectYadm(): Promise<DetectionResult> {
  // 1. Check for yadm v3 repository (XDG location)
  const v3RepoPath = join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'yadm',
    'repo.git'
  );

  if (await pathExists(v3RepoPath)) {
    const configDir = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'yadm'
    );

    return {
      tool: 'yadm',
      path: v3RepoPath,
      confidence: 'high',
      metadata: {
        version: 3,
        configDir,
        dataDir: join(v3RepoPath, '..'),
      },
    };
  }

  // 2. Check for yadm v2 repository (legacy location)
  const v2RepoPath = join(homedir(), '.yadm', 'repo.git');

  if (await pathExists(v2RepoPath)) {
    return {
      tool: 'yadm',
      path: v2RepoPath,
      confidence: 'high',
      metadata: {
        version: 2,
        configDir: join(homedir(), '.yadm'),
        dataDir: join(homedir(), '.yadm'),
      },
    };
  }

  // 3. Check for yadm CLI
  try {
    const { stdout } = await execAsync('yadm version');
    // yadm is installed but no repo yet
    return {
      tool: 'yadm',
      path: null,
      confidence: 'low',
      metadata: { cliOnly: true, version: stdout.trim() },
    };
  } catch {
    // yadm not installed
  }

  return { tool: null, path: null, confidence: 'low' };
}
```

### Getting Tracked Files

```typescript
async function getTrackedFiles(): Promise<string[]> {
  // Method 1: Use yadm CLI (preferred)
  if (await commandExists('yadm')) {
    const { stdout } = await execAsync('yadm list -a');
    return stdout.trim().split('\n').filter(Boolean);
  }

  // Method 2: Query bare repo directly
  const repoPath = this.metadata.path;
  const { stdout } = await execAsync(
    `git --git-dir="${repoPath}" --work-tree="${homedir()}" ls-tree -r --name-only HEAD`
  );
  return stdout.trim().split('\n').filter(Boolean);
}
```

---

## Alternate Files

Yadm's alternate files feature allows different file versions for different systems.

### Naming Convention

Format: `filename##[conditions]`

Each condition is a key-value pair separated by `.`:

```
.zshrc##os.Darwin                    # macOS only
.zshrc##os.Linux                     # Linux only
.zshrc##hostname.work-laptop         # Specific hostname
.zshrc##class.workstation            # User-defined class
.zshrc##distro.Ubuntu                # Specific distro
.zshrc##os.Darwin,hostname.my-mac    # Multiple conditions
.zshrc##default                      # Fallback when no match
```

### Condition Types (in precedence order)

| Condition | Source | Example |
|-----------|--------|---------|
| `template` (t) | Template processor | `t.default`, `t.esh` |
| `user` (u) | `id -u -n` | `u.john` |
| `hostname` (h) | Short hostname | `h.my-laptop` |
| `class` (c) | `yadm config local.class` | `c.workstation` |
| `distro_family` (f) | `/etc/os-release` | `f.debian` |
| `distro` (d) | `/etc/os-release` | `d.ubuntu` |
| `os` (o) | `uname -s` | `o.Darwin`, `o.Linux` |
| `arch` (a) | `uname -m` | `a.x86_64`, `a.arm64` |
| `default` | Fallback | `default` |
| `extension` (e) | File extension | `e.yaml` |

### Negation

Prefix condition with `~` to negate:

```
.zshrc##~os.Windows    # NOT Windows
```

### Alternate Resolution

```typescript
interface AlternateFile {
  basePath: string;           // e.g., "~/.zshrc"
  alternates: AlternateVariant[];
  selectedVariant: AlternateVariant | null;
}

interface AlternateVariant {
  path: string;               // e.g., "~/.zshrc##os.Darwin"
  conditions: Condition[];
  score: number;              // For ranking
}

interface Condition {
  type: 'template' | 'user' | 'hostname' | 'class' | 'distro_family' |
        'distro' | 'os' | 'arch' | 'default' | 'extension';
  value: string;
  negated: boolean;
}

function parseAlternateFilename(filename: string): {
  baseName: string;
  conditions: Condition[];
} {
  const match = filename.match(/^(.+?)##(.+)$/);
  if (!match) {
    return { baseName: filename, conditions: [] };
  }

  const [, baseName, condStr] = match;
  const conditions: Condition[] = [];

  for (const cond of condStr.split(',')) {
    const negated = cond.startsWith('~');
    const cleaned = negated ? cond.slice(1) : cond;

    if (cleaned === 'default') {
      conditions.push({ type: 'default', value: '', negated: false });
      continue;
    }

    const [type, value] = cleaned.split('.');
    const typeMap: Record<string, Condition['type']> = {
      t: 'template', template: 'template',
      u: 'user', user: 'user',
      h: 'hostname', hostname: 'hostname',
      c: 'class', class: 'class',
      f: 'distro_family', distro_family: 'distro_family',
      d: 'distro', distro: 'distro',
      o: 'os', os: 'os',
      a: 'arch', arch: 'arch',
      e: 'extension', extension: 'extension',
    };

    conditions.push({
      type: typeMap[type] || 'os',
      value,
      negated,
    });
  }

  return { baseName, conditions };
}
```

### Migration Strategy for Alternates

**Option 1: Import active variant only**
- Determine which alternate matches current system
- Import only that file
- Simple, but loses machine-specific configs

**Option 2: Import all variants with documentation**
- Import the active variant as the main file
- Document other variants in a migration notes file
- User decides what to do with others

**Option 3: Use tuck profiles (future)**
- Create a tuck profile for each machine class
- Import appropriate files into each profile

```typescript
async function resolveAlternates(
  trackedFiles: string[]
): Promise<Map<string, AlternateFile>> {
  const alternates = new Map<string, AlternateFile>();

  // Group files by base path
  for (const file of trackedFiles) {
    const { baseName, conditions } = parseAlternateFilename(basename(file));

    if (conditions.length === 0) {
      // Regular file, not an alternate
      continue;
    }

    const basePath = join(dirname(file), baseName);

    if (!alternates.has(basePath)) {
      alternates.set(basePath, {
        basePath,
        alternates: [],
        selectedVariant: null,
      });
    }

    const variant: AlternateVariant = {
      path: file,
      conditions,
      score: calculateScore(conditions),
    };

    alternates.get(basePath)!.alternates.push(variant);
  }

  // Select best variant for current system
  for (const [, alt] of alternates) {
    alt.alternates.sort((a, b) => b.score - a.score);

    for (const variant of alt.alternates) {
      if (await matchesCurrentSystem(variant.conditions)) {
        alt.selectedVariant = variant;
        break;
      }
    }

    // Fallback to default if no match
    if (!alt.selectedVariant) {
      const defaultVariant = alt.alternates.find(v =>
        v.conditions.some(c => c.type === 'default')
      );
      alt.selectedVariant = defaultVariant || null;
    }
  }

  return alternates;
}
```

---

## Encryption Handling

### Encryption File

Located at `~/.config/yadm/encrypt` (or `~/.yadm/encrypt` for v2):

```
# Glob patterns for files to encrypt
.ssh/*.key
.ssh/id_*
!.ssh/*.pub          # Exclude public keys
.gnupg/*
.config/secrets/**   # Recursive matching
```

### Encrypted Archive

Encrypted files are stored in `~/.local/share/yadm/archive`.

### Decryption Process

```typescript
async function handleEncryption(): Promise<EncryptedFile[]> {
  const encryptedFiles: EncryptedFile[] = [];

  // 1. Read encrypt patterns
  const encryptPath = join(this.configDir, 'encrypt');
  if (!await pathExists(encryptPath)) {
    return [];
  }

  const patterns = await readFile(encryptPath, 'utf-8');
  const globs = patterns
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  // 2. Find matching files
  for (const pattern of globs) {
    if (pattern.startsWith('!')) continue;  // Exclusion

    const matches = await glob(pattern, { cwd: homedir() });
    for (const match of matches) {
      encryptedFiles.push({
        path: join('~', match),
        pattern,
        decrypted: false,
      });
    }
  }

  // 3. Check archive exists
  const archivePath = join(this.dataDir, 'archive');
  if (!await pathExists(archivePath)) {
    logger.warn('Encrypted archive not found. Files may not be decrypted.');
    return encryptedFiles;
  }

  return encryptedFiles;
}

async function decryptFiles(): Promise<void> {
  if (!await commandExists('yadm')) {
    throw new Error(
      'yadm CLI is required to decrypt files. ' +
      'Install yadm or decrypt manually before migration.'
    );
  }

  // yadm decrypt will extract files from archive
  await execAsync('yadm decrypt');
}
```

### Migration Strategy for Encrypted Files

1. Skip encrypted files by default (require `--include-encrypted`)
2. If included:
   - Run `yadm decrypt` to extract files
   - Import decrypted content
   - Mark files as sensitive in manifest
   - Recommend tuck's encryption (when available)

---

## Template Processing

### Yadm Template Processors

| Processor | Syntax | Invocation |
|-----------|--------|------------|
| `default` | Awk-based Jinja-like | `##template` or `##t.default` |
| `esh` | Shell-based | `##t.esh` |
| `j2cli` | Jinja2 | `##t.j2cli` |
| `envtpl` | Environment templates | `##t.envtpl` |

### Default Template Syntax

```jinja
{% if YADM_OS == "Darwin" %}
macOS specific content
{% endif %}

{% if YADM_HOSTNAME == "work-laptop" %}
Work configuration
{% endif %}

{{ YADM_USER }}
{{ env.HOME }}
```

### Available Template Variables

| Variable | Description |
|----------|-------------|
| `YADM_CLASS` | Value of `local.class` |
| `YADM_DISTRO` | Distribution ID |
| `YADM_DISTRO_FAMILY` | Distribution family |
| `YADM_OS` | `uname -s` |
| `YADM_HOSTNAME` | Short hostname |
| `YADM_USER` | Current username |
| `YADM_ARCH` | `uname -m` |
| `YADM_SOURCE` | Path to yadm source |

### Template Detection

```typescript
function isYadmTemplate(filename: string): { isTemplate: boolean; processor?: string } {
  const { conditions } = parseAlternateFilename(filename);

  const templateCond = conditions.find(c => c.type === 'template');
  if (templateCond) {
    return { isTemplate: true, processor: templateCond.value || 'default' };
  }

  return { isTemplate: false };
}

// Default processor patterns
const YADM_TEMPLATE_PATTERNS = [
  /\{%\s*if\b/,                    // {% if %}
  /\{%\s*for\b/,                   // {% for %}
  /\{\{\s*\w+\s*\}\}/,             // {{ variable }}
  /\{\{\s*env\.\w+\s*\}\}/,        // {{ env.VAR }}
  /\{%\s*include\b/,               // {% include %}
];

function hasYadmTemplates(content: string): boolean {
  return YADM_TEMPLATE_PATTERNS.some(p => p.test(content));
}
```

### Template Processing

```typescript
async function processTemplate(
  sourcePath: string,
  processor: string
): Promise<string> {
  // Best approach: use yadm to process the template
  if (await commandExists('yadm')) {
    // Create temp file and let yadm alt process it
    // This is complex; may be better to evaluate inline

    // Alternative: read and substitute variables manually
    let content = await readFile(expandPath(sourcePath), 'utf-8');

    const vars = await getYadmVariables();
    content = substituteVariables(content, vars);

    return content;
  }

  // Fallback: return raw content with warning
  logger.warn(`Cannot process template ${sourcePath} without yadm CLI`);
  return readFile(expandPath(sourcePath), 'utf-8');
}

async function getYadmVariables(): Promise<Record<string, string>> {
  return {
    YADM_CLASS: await getYadmConfig('local.class') || '',
    YADM_DISTRO: await getDistroId(),
    YADM_DISTRO_FAMILY: await getDistroFamily(),
    YADM_OS: os.platform() === 'darwin' ? 'Darwin' : 'Linux',
    YADM_HOSTNAME: os.hostname().split('.')[0],
    YADM_USER: os.userInfo().username,
    YADM_ARCH: os.arch(),
  };
}
```

---

## Migration Steps

### Step 1: Detection and Validation

```typescript
async function step1_detect(): Promise<void> {
  const detection = await this.detect();

  if (!detection.path) {
    throw new Error('Yadm repository not found');
  }

  this.repoPath = detection.path;
  this.configDir = detection.metadata.configDir;
  this.dataDir = detection.metadata.dataDir;
  this.version = detection.metadata.version;

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
  // Get all tracked files
  const allFiles = await this.getTrackedFiles();

  // Separate regular files from alternates
  const regularFiles: string[] = [];
  const alternateFiles: string[] = [];

  for (const file of allFiles) {
    if (file.includes('##')) {
      alternateFiles.push(file);
    } else {
      regularFiles.push(file);
    }
  }

  // Resolve alternates to get active variants
  const alternates = await this.resolveAlternates(alternateFiles);

  // Build migration file list
  const migratedFiles: MigratedFile[] = [];

  // Add regular files
  for (const file of regularFiles) {
    // Skip yadm internal files
    if (file.startsWith('.config/yadm/') || file.startsWith('.yadm/')) {
      continue;
    }

    const { isTemplate, processor } = isYadmTemplate(file);

    migratedFiles.push({
      originalPath: file,
      targetPath: '~/' + file,
      sourcePath: expandPath('~/' + file),
      category: categorizeFile('~/' + file),
      isTemplate,
      templateEngine: processor as 'yadm' | undefined,
      isEncrypted: await this.isEncrypted(file),
      metadata: {},
      warnings: [],
    });
  }

  // Add resolved alternates
  for (const [basePath, alt] of alternates) {
    if (!alt.selectedVariant) {
      logger.warn(`No matching alternate for ${basePath}`);
      continue;
    }

    const { isTemplate, processor } = isYadmTemplate(alt.selectedVariant.path);

    migratedFiles.push({
      originalPath: alt.selectedVariant.path,
      targetPath: basePath.startsWith('~') ? basePath : '~/' + basePath,
      sourcePath: expandPath(alt.selectedVariant.path),
      category: categorizeFile(basePath),
      isTemplate,
      templateEngine: processor as 'yadm' | undefined,
      isEncrypted: await this.isEncrypted(alt.selectedVariant.path),
      metadata: {
        alternateInfo: {
          conditions: alt.selectedVariant.conditions,
          otherVariants: alt.alternates
            .filter(v => v !== alt.selectedVariant)
            .map(v => v.path),
        },
      },
      warnings: alt.alternates.length > 1 ? [
        `File has ${alt.alternates.length} alternate versions. Only importing: ${alt.selectedVariant.path}`
      ] : [],
    });
  }

  return migratedFiles;
}
```

### Step 3: Handle Encryption

```typescript
async function step3_handleEncryption(
  files: MigratedFile[],
  options: MigrationOptions
): Promise<MigratedFile[]> {
  const encrypted = files.filter(f => f.isEncrypted);

  if (encrypted.length === 0) {
    return files;
  }

  if (!options.includeEncrypted) {
    logger.info(`Skipping ${encrypted.length} encrypted file(s)`);
    return files.filter(f => !f.isEncrypted);
  }

  // Decrypt files
  logger.info('Decrypting encrypted files...');

  if (!await commandExists('yadm')) {
    throw new Error(
      'yadm CLI required for decryption. ' +
      'Run "yadm decrypt" manually before migration.'
    );
  }

  await execAsync('yadm decrypt');

  // Mark as decrypted
  for (const file of encrypted) {
    file.isEncrypted = false;
    file.warnings.push('File was encrypted; imported decrypted content');
  }

  return files;
}
```

### Step 4: Import Files

```typescript
async function step4_import(
  files: MigratedFile[],
  options: MigrationOptions
): Promise<MigrationResult> {
  const imported: MigratedFile[] = [];
  const failed: Array<{ file: MigratedFile; error: string }> = [];
  const skipped: MigratedFile[] = [];

  for (const file of files) {
    try {
      // Get content
      let content: string;

      if (file.isTemplate && file.templateEngine) {
        content = await this.processTemplate(
          file.sourcePath,
          file.templateEngine
        );
      } else {
        content = await readFile(file.sourcePath, 'utf-8');
      }

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
        checksum: await getFileChecksum(tuckDest),
      });

      imported.push(file);

      // Log alternate info
      if (file.metadata.alternateInfo?.otherVariants?.length) {
        logger.dim(
          `  Other variants not imported: ${file.metadata.alternateInfo.otherVariants.join(', ')}`
        );
      }
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

### Step 5: Cleanup (Optional)

```typescript
async function step5_cleanup(): Promise<void> {
  const shouldCleanup = await prompts.confirm(
    'Remove yadm installation?',
    false
  );

  if (!shouldCleanup) {
    logger.info('Keeping yadm installation');
    logger.info('Note: yadm and tuck can coexist, but may conflict.');
    return;
  }

  // Backup yadm data
  const backupDir = await createBackupDir();

  // Backup config
  if (await pathExists(this.configDir)) {
    await copy(this.configDir, join(backupDir, 'config'));
  }

  // Backup repo (just the .git, not the working tree)
  if (await pathExists(this.repoPath)) {
    await copy(this.repoPath, join(backupDir, 'repo.git'));
  }

  logger.info(`Backed up yadm data to: ${backupDir}`);

  // Remove yadm installation
  // Note: We can't just delete tracked files - they're the actual dotfiles!
  // We only remove yadm's internal data

  await rm(this.repoPath, { recursive: true });
  await rm(this.configDir, { recursive: true });

  if (this.version === 2) {
    // v2: whole .yadm directory
    await rm(join(homedir(), '.yadm'), { recursive: true });
  }

  logger.success('Yadm installation removed');
  logger.info('Your dotfiles remain in place, now managed by tuck.');
}
```

---

## Edge Cases

### 1. Files Outside Home Directory

Yadm can track files outside `$HOME` using worktree:

```bash
yadm add /etc/hosts  # Requires sudo
```

**Solution:** Skip files outside home, warn user.

### 2. Symlinks in Home Directory

Yadm may track symlinks, not their targets:

```
~/.zshrc → ~/.dotfiles/zsh/zshrc
```

**Solution:** Resolve symlinks and import actual content.

### 3. Large Binary Files

Yadm can track any file, including binaries:

```
~/.local/bin/large-binary
```

**Solution:** Warn about large files, skip or compress.

### 4. Git Submodules

Yadm repos can have submodules (e.g., for plugins):

```
~/.vim/bundle/plugin (submodule)
```

**Solution:** Warn about submodules, don't import.

### 5. Multiple Alternates, No Match

If alternates exist but none match current system:

```
.zshrc##os.Windows
.zshrc##os.FreeBSD
# No .zshrc##os.Linux or default
```

**Solution:** Warn user, skip file or use first available.

### 6. Conflicting Yadm and Tuck

If user runs `yadm add` after partial migration:

**Solution:** Check for yadm repo in cleanup, warn about conflicts.

### 7. Bootstrap Script

Yadm's bootstrap script may set up the environment:

```bash
#!/bin/bash
# ~/.config/yadm/bootstrap
brew bundle install
pip install -r requirements.txt
```

**Solution:** Don't import as dotfile, offer to convert to tuck hook.

### 8. Class-Based Alternates

User may rely on `local.class` for machine categorization:

```
.gitconfig##class.work
.gitconfig##class.personal
```

**Solution:** Document which class was detected, suggest tuck profiles.

---

## Implementation

### File: `src/lib/migrate/yadm.ts`

```typescript
import { join } from 'path';
import { homedir } from 'os';
import { readFile, stat, readdir } from 'fs/promises';
import type { Migrator, DetectionResult, MigratedFile, MigrationResult, MigrationOptions } from './index.js';
import { pathExists, expandPath, collapsePath } from '../paths.js';
import { commandExists, execAsync } from './common.js';

export class YadmMigrator implements Migrator {
  readonly name = 'yadm';
  readonly displayName = 'Yadm';

  private repoPath: string | null = null;
  private configDir: string | null = null;
  private dataDir: string | null = null;
  private version: number = 3;
  private tuckDir: string;

  constructor(tuckDir: string) {
    this.tuckDir = tuckDir;
  }

  async detect(): Promise<DetectionResult> {
    // Implementation as described above
  }

  async getTrackedFiles(): Promise<string[]> {
    // Implementation using yadm list -a
  }

  async validate(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!this.repoPath || !await pathExists(this.repoPath)) {
      issues.push('Yadm repository not found');
    }

    // Check for encrypted files
    const encryptFile = join(this.configDir!, 'encrypt');
    if (await pathExists(encryptFile)) {
      issues.push('Encrypted files detected. Use --include-encrypted to import.');
    }

    // Check for alternates
    const files = await this.getTrackedFiles();
    const alternates = files.filter(f => f.includes('##'));
    if (alternates.length > 0) {
      issues.push(`${alternates.length} alternate file(s) found. Only active variants will be imported.`);
    }

    return { valid: issues.filter(i => i.includes('not found')).length === 0, issues };
  }

  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    // Implementation combining all steps
  }

  async cleanup(): Promise<void> {
    // Implementation as described above
  }

  // Private helpers
  private parseAlternateFilename(name: string) { /* ... */ }
  private async resolveAlternates(files: string[]) { /* ... */ }
  private async isEncrypted(file: string): Promise<boolean> { /* ... */ }
  private async processTemplate(path: string, processor: string): Promise<string> { /* ... */ }
}
```

---

## Testing

### Unit Tests

```typescript
describe('YadmMigrator', () => {
  describe('parseAlternateFilename', () => {
    const testCases = [
      {
        input: '.zshrc##os.Darwin',
        expected: { baseName: '.zshrc', conditions: [{ type: 'os', value: 'Darwin', negated: false }] }
      },
      {
        input: '.zshrc##os.Linux,hostname.work',
        expected: {
          baseName: '.zshrc',
          conditions: [
            { type: 'os', value: 'Linux', negated: false },
            { type: 'hostname', value: 'work', negated: false }
          ]
        }
      },
      {
        input: '.config##~os.Windows',
        expected: { baseName: '.config', conditions: [{ type: 'os', value: 'Windows', negated: true }] }
      },
      {
        input: '.zshrc##default',
        expected: { baseName: '.zshrc', conditions: [{ type: 'default', value: '', negated: false }] }
      },
      {
        input: '.zshrc##t.esh',
        expected: { baseName: '.zshrc', conditions: [{ type: 'template', value: 'esh', negated: false }] }
      },
    ];

    for (const { input, expected } of testCases) {
      it(`should parse "${input}" correctly`, () => {
        const result = parseAlternateFilename(input);
        expect(result).toMatchObject(expected);
      });
    }
  });

  describe('resolveAlternates', () => {
    it('should select matching alternate', async () => {
      // Mock current system as Darwin
      const files = [
        '.zshrc##os.Darwin',
        '.zshrc##os.Linux',
      ];

      const result = await resolveAlternates(files);
      expect(result.get('~/.zshrc')?.selectedVariant?.path).toBe('.zshrc##os.Darwin');
    });

    it('should use default when no match', async () => {
      const files = [
        '.zshrc##os.FreeBSD',
        '.zshrc##default',
      ];

      const result = await resolveAlternates(files);
      expect(result.get('~/.zshrc')?.selectedVariant?.path).toBe('.zshrc##default');
    });
  });

  describe('hasYadmTemplates', () => {
    it('should detect if conditions', () => {
      expect(hasYadmTemplates('{% if YADM_OS == "Darwin" %}')).toBe(true);
    });

    it('should detect variable substitution', () => {
      expect(hasYadmTemplates('Hello {{ YADM_USER }}')).toBe(true);
    });

    it('should not match regular content', () => {
      expect(hasYadmTemplates('export PATH=$HOME/bin:$PATH')).toBe(false);
    });
  });
});
```

### Integration Tests

```typescript
describe('Yadm Migration Integration', () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'yadm-test-'));

    // Create fake yadm structure
    await mkdir(join(testHome, '.local', 'share', 'yadm'), { recursive: true });
    await mkdir(join(testHome, '.config', 'yadm'), { recursive: true });

    // Initialize bare repo
    await execAsync(`git init --bare "${join(testHome, '.local/share/yadm/repo.git')}"`);
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true });
  });

  it('should detect v3 installation', async () => {
    // Test with mocked homedir
  });

  it('should handle alternates correctly', async () => {
    // Create alternate files and test resolution
  });
});
```

---

## Summary

Yadm migration requires careful handling of:

1. **Bare repo access** - Files are in `$HOME`, not a subdirectory
2. **Alternate resolution** - Pick correct variant for current system
3. **Encryption** - Requires yadm CLI for decryption
4. **Templates** - Multiple processor types
5. **Cleanup** - Only remove yadm data, not the dotfiles themselves

Key differences from other tools:
- Files stay in place during migration (they're already in `$HOME`)
- Need to handle alternate variants carefully
- Cleanup removes metadata only, not files

---

*Last updated: December 2024*
