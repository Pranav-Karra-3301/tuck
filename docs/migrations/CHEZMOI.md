# Chezmoi Migration Plan

> Detailed implementation guide for migrating from chezmoi to tuck

---

## Table of Contents

1. [Overview](#overview)
2. [Chezmoi Structure Analysis](#chezmoi-structure-analysis)
3. [Detection Strategy](#detection-strategy)
4. [File Parsing](#file-parsing)
5. [Template Handling](#template-handling)
6. [Migration Steps](#migration-steps)
7. [Edge Cases](#edge-cases)
8. [Implementation](#implementation)
9. [Testing](#testing)

---

## Overview

Chezmoi is one of the most feature-rich dotfiles managers. It uses a unique file naming convention with prefixes to encode metadata and supports templates, encryption, and scripts.

### Key Challenges

1. **File naming prefixes** - Need to parse and reverse `dot_`, `executable_`, etc.
2. **Templates** - Need to detect and optionally convert template syntax
3. **Encrypted files** - Require chezmoi CLI for decryption
4. **Scripts** - `run_` prefixed scripts need to be excluded or converted to hooks
5. **External files** - Files fetched from URLs need special handling

### Chezmoi Resources

- Official docs: https://www.chezmoi.io/
- Source state attributes: https://www.chezmoi.io/reference/source-state-attributes/
- CLI reference: https://www.chezmoi.io/reference/commands/

---

## Chezmoi Structure Analysis

### Source Directory Location

```
~/.local/share/chezmoi/          # Default (XDG_DATA_HOME)
~/.chezmoi/                       # Legacy (rare)
$CHEZMOI_SOURCE_DIR/              # Custom via env var
```

### Configuration File Location

```
~/.config/chezmoi/chezmoi.toml   # TOML format (most common)
~/.config/chezmoi/chezmoi.yaml   # YAML format
~/.config/chezmoi/chezmoi.json   # JSON format
```

### File Naming Convention

Chezmoi uses prefixes and suffixes to encode file attributes. The order matters!

#### Prefix Order (must be parsed in this order)

| Order | Prefix | Meaning |
|-------|--------|---------|
| 1 | `external_` | External file/dir (fetched from URL) |
| 2 | `remove_` | File to be removed |
| 3 | `create_` | Create only if doesn't exist |
| 4 | `modify_` | Modify existing file with script |
| 5 | `run_` | Script to execute |
| 6 | `once_` | Run only once (used with `run_`) |
| 7 | `onchange_` | Run on content change (used with `run_`) |
| 8 | `before_` | Run before other operations |
| 9 | `after_` | Run after other operations |
| 10 | `encrypted_` | Encrypted with age |
| 11 | `private_` | Set restrictive permissions (0700/0600) |
| 12 | `readonly_` | Remove write permissions |
| 13 | `empty_` | Allow empty file |
| 14 | `executable_` | Set executable bit |
| 15 | `exact_` | For directories: remove extra files |
| 16 | `symlink_` | Create symlink instead of file |
| 17 | `dot_` | Prepend dot to filename |
| 18 | `literal_` | Stop parsing prefixes |

#### Suffix Order

| Suffix | Meaning |
|--------|---------|
| `.tmpl` | Template file |
| `.literal` | Stop parsing suffixes |
| `.age` | Age encrypted (auto-stripped) |
| `.asc` | GPG encrypted (auto-stripped) |

### Example Mappings

| Source File | Target File | Notes |
|-------------|-------------|-------|
| `dot_zshrc` | `~/.zshrc` | Simple dotfile |
| `dot_gitconfig` | `~/.gitconfig` | Simple dotfile |
| `private_dot_ssh/config` | `~/.ssh/config` | Private permissions |
| `executable_dot_local/bin/script` | `~/.local/bin/script` | Executable |
| `dot_config/nvim/init.lua` | `~/.config/nvim/init.lua` | Nested directory |
| `encrypted_private_dot_netrc` | `~/.netrc` | Encrypted + private |
| `dot_zshrc.tmpl` | `~/.zshrc` | Template |
| `run_once_install.sh` | (script) | Not a dotfile |

### Special Directories

```
.chezmoiroot          # File indicating subdirectory is root
.chezmoitemplates/    # Shared template partials
.chezmoiexternal.toml # External file definitions
.chezmoiignore        # Files to ignore
.chezmoiversion       # Minimum chezmoi version
```

---

## Detection Strategy

### Detection Steps

```typescript
async function detectChezmoi(): Promise<DetectionResult> {
  // 1. Check default XDG location
  const xdgPath = join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'chezmoi'
  );

  if (await pathExists(xdgPath)) {
    return {
      tool: 'chezmoi',
      path: xdgPath,
      confidence: 'high',
    };
  }

  // 2. Check legacy location
  const legacyPath = join(homedir(), '.chezmoi');
  if (await pathExists(legacyPath)) {
    return {
      tool: 'chezmoi',
      path: legacyPath,
      confidence: 'high',
    };
  }

  // 3. Check for chezmoi config (indicates usage)
  const configPath = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'chezmoi'
  );

  if (await pathExists(configPath)) {
    // Config exists but no source - might have been purged
    return {
      tool: 'chezmoi',
      path: null,
      confidence: 'low',
      metadata: { configOnly: true },
    };
  }

  // 4. Check for chezmoi CLI
  try {
    const { stdout } = await execAsync('chezmoi source-path');
    const sourcePath = stdout.trim();
    if (await pathExists(sourcePath)) {
      return {
        tool: 'chezmoi',
        path: sourcePath,
        confidence: 'high',
      };
    }
  } catch {
    // CLI not available or not configured
  }

  return { tool: null, path: null, confidence: 'low' };
}
```

### Validation

```typescript
async function validate(): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Check if chezmoi source directory exists and is readable
  if (!await pathExists(this.sourcePath)) {
    issues.push(`Source directory not found: ${this.sourcePath}`);
  }

  // Check for .chezmoiroot - may indicate non-standard layout
  const rootFile = join(this.sourcePath, '.chezmoiroot');
  if (await pathExists(rootFile)) {
    const root = await readFile(rootFile, 'utf-8');
    this.sourcePath = join(this.sourcePath, root.trim());
    // Re-validate with new path
  }

  // Check for encrypted files
  const encryptedFiles = await this.findEncryptedFiles();
  if (encryptedFiles.length > 0) {
    issues.push(
      `Found ${encryptedFiles.length} encrypted file(s). ` +
      `Use --include-encrypted to import them.`
    );
  }

  // Check for templates
  const templates = await this.findTemplates();
  if (templates.length > 0) {
    issues.push(
      `Found ${templates.length} template file(s). ` +
      `These will need manual review after import.`
    );
  }

  return { valid: issues.length === 0, issues };
}
```

---

## File Parsing

### Filename Parser Implementation

```typescript
interface ParsedChezmoiFilename {
  targetName: string;       // Final filename (e.g., ".zshrc")
  isScript: boolean;        // run_ prefix
  isRemove: boolean;        // remove_ prefix
  isCreate: boolean;        // create_ prefix
  isModify: boolean;        // modify_ prefix
  isOnce: boolean;          // once_ prefix
  isOnChange: boolean;      // onchange_ prefix
  isExternal: boolean;      // external_ prefix
  isEncrypted: boolean;     // encrypted_ prefix
  isPrivate: boolean;       // private_ prefix
  isReadonly: boolean;      // readonly_ prefix
  isEmpty: boolean;         // empty_ prefix
  isExecutable: boolean;    // executable_ prefix
  isExact: boolean;         // exact_ prefix (directories)
  isSymlink: boolean;       // symlink_ prefix
  isTemplate: boolean;      // .tmpl suffix
}

function parseChezmoiFilename(sourceName: string): ParsedChezmoiFilename {
  const result: ParsedChezmoiFilename = {
    targetName: sourceName,
    isScript: false,
    isRemove: false,
    isCreate: false,
    isModify: false,
    isOnce: false,
    isOnChange: false,
    isExternal: false,
    isEncrypted: false,
    isPrivate: false,
    isReadonly: false,
    isEmpty: false,
    isExecutable: false,
    isExact: false,
    isSymlink: false,
    isTemplate: false,
  };

  let name = sourceName;

  // Parse suffixes first (right to left)
  if (name.endsWith('.tmpl')) {
    result.isTemplate = true;
    name = name.slice(0, -5);
  }

  // Strip encryption suffixes (just markers, content is encrypted)
  if (name.endsWith('.age') || name.endsWith('.asc')) {
    name = name.slice(0, name.lastIndexOf('.'));
  }

  // Parse prefixes (in order)
  const prefixes = [
    ['external_', 'isExternal'],
    ['remove_', 'isRemove'],
    ['create_', 'isCreate'],
    ['modify_', 'isModify'],
    ['run_', 'isScript'],
    ['once_', 'isOnce'],
    ['onchange_', 'isOnChange'],
    ['before_', null],  // Ignored
    ['after_', null],   // Ignored
    ['encrypted_', 'isEncrypted'],
    ['private_', 'isPrivate'],
    ['readonly_', 'isReadonly'],
    ['empty_', 'isEmpty'],
    ['executable_', 'isExecutable'],
    ['exact_', 'isExact'],
    ['symlink_', 'isSymlink'],
    ['dot_', null],  // Special handling
    ['literal_', null],  // Stop parsing
  ] as const;

  for (const [prefix, prop] of prefixes) {
    if (name.startsWith(prefix)) {
      if (prefix === 'literal_') {
        // Stop parsing, rest is literal
        name = name.slice(prefix.length);
        break;
      }
      if (prefix === 'dot_') {
        name = '.' + name.slice(prefix.length);
      } else if (prop) {
        result[prop as keyof ParsedChezmoiFilename] = true as never;
        name = name.slice(prefix.length);
      } else {
        // Just strip the prefix
        name = name.slice(prefix.length);
      }
    }
  }

  result.targetName = name;
  return result;
}
```

### Path Reconstruction

```typescript
function reconstructTargetPath(
  sourceRelativePath: string
): { targetPath: string; parsed: ParsedChezmoiFilename } {
  const parts = sourceRelativePath.split('/');
  const reconstructedParts: string[] = [];
  let parsed: ParsedChezmoiFilename | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;

    // Skip special directories
    if (part.startsWith('.chezmoi')) {
      return { targetPath: '', parsed: null as never };
    }

    parsed = parseChezmoiFilename(part);
    reconstructedParts.push(parsed.targetName);
  }

  return {
    targetPath: '~/' + reconstructedParts.join('/'),
    parsed: parsed!,
  };
}
```

---

## Template Handling

### Chezmoi Template Syntax

Chezmoi uses Go's `text/template` syntax:

```go
// Variable access
{{ .chezmoi.hostname }}
{{ .chezmoi.os }}
{{ .chezmoi.arch }}
{{ .email }}  // From config data

// Conditionals
{{ if eq .chezmoi.os "darwin" }}
macOS specific
{{ else if eq .chezmoi.os "linux" }}
Linux specific
{{ end }}

// Environment variables
{{ env "HOME" }}
{{ env "USER" }}

// Functions
{{ include "partial.tmpl" }}
{{ output "command" "arg1" }}
```

### Template Detection

```typescript
const CHEZMOI_TEMPLATE_PATTERNS = [
  /\{\{\s*\./,                    // {{ .variable }}
  /\{\{\s*if\b/,                  // {{ if }}
  /\{\{\s*range\b/,               // {{ range }}
  /\{\{\s*template\b/,            // {{ template }}
  /\{\{\s*include\b/,             // {{ include }}
  /\{\{\s*output\b/,              // {{ output }}
  /\{\{\s*env\b/,                 // {{ env }}
  /\{\{\s*\$\w+\s*:=/,           // {{ $var := }}
];

function hasChezmoiTemplates(content: string): boolean {
  return CHEZMOI_TEMPLATE_PATTERNS.some(pattern => pattern.test(content));
}
```

### Template Conversion Strategy

**Option 1: Keep as-is with warning**
- Import the raw template content
- Set `template: true` in manifest
- User manually converts later

**Option 2: Evaluate template (preferred)**
- Use `chezmoi execute-template` to get actual content
- Import the evaluated result
- No template markers in tuck

**Option 3: Convert to tuck templates (future)**
- Parse chezmoi syntax
- Convert to tuck's planned template syntax
- Mark as template in manifest

```typescript
async function processTemplate(
  sourcePath: string,
  targetPath: string
): Promise<{ content: string; wasTemplate: boolean }> {
  // Check if chezmoi CLI is available
  const hasChezmoiCli = await commandExists('chezmoi');

  if (hasChezmoiCli) {
    try {
      // Use chezmoi to evaluate the template
      const { stdout } = await execAsync(
        `chezmoi execute-template < "${sourcePath}"`
      );
      return { content: stdout, wasTemplate: true };
    } catch (error) {
      logger.warn(`Could not evaluate template ${sourcePath}: ${error}`);
    }
  }

  // Fallback: read raw content
  const content = await readFile(sourcePath, 'utf-8');
  const hasTemplates = hasChezmoiTemplates(content);

  return { content, wasTemplate: hasTemplates };
}
```

---

## Migration Steps

### Step 1: Detection and Validation

```typescript
async function step1_detect(): Promise<void> {
  // Detect chezmoi installation
  const detection = await this.detect();

  if (!detection.path) {
    throw new Error('Chezmoi source directory not found');
  }

  // Check for .chezmoiroot
  await this.adjustForChezmoiRoot();

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
  const files: MigratedFile[] = [];

  // Method 1: Use chezmoi CLI if available (preferred)
  if (await commandExists('chezmoi')) {
    const { stdout } = await execAsync('chezmoi managed --format json');
    const managed = JSON.parse(stdout);
    // Process each managed file...
  }

  // Method 2: Walk the source directory
  const entries = await walkDirectory(this.sourcePath);

  for (const entry of entries) {
    // Skip special directories
    if (entry.name.startsWith('.chezmoi')) continue;

    const { targetPath, parsed } = reconstructTargetPath(entry.relativePath);

    // Skip scripts
    if (parsed.isScript) {
      logger.info(`Skipping script: ${entry.relativePath}`);
      continue;
    }

    // Skip remove targets
    if (parsed.isRemove) {
      logger.info(`Skipping remove target: ${entry.relativePath}`);
      continue;
    }

    // Skip external files
    if (parsed.isExternal) {
      logger.info(`Skipping external file: ${entry.relativePath}`);
      continue;
    }

    files.push({
      originalPath: entry.relativePath,
      targetPath,
      sourcePath: entry.absolutePath,
      category: categorizeFile(targetPath),
      isTemplate: parsed.isTemplate,
      templateEngine: parsed.isTemplate ? 'chezmoi' : undefined,
      isEncrypted: parsed.isEncrypted,
      metadata: {
        isPrivate: parsed.isPrivate,
        isExecutable: parsed.isExecutable,
        isReadonly: parsed.isReadonly,
      },
      warnings: [],
    });
  }

  return files;
}
```

### Step 3: Preview and Confirm

```typescript
async function step3_preview(files: MigratedFile[]): Promise<void> {
  console.log('\n');
  prompts.log.info(`Found ${files.length} files to import:`);
  console.log('\n');

  // Group by category
  const byCategory = groupBy(files, f => f.category);

  for (const [category, categoryFiles] of Object.entries(byCategory)) {
    const icon = CATEGORIES[category]?.icon || '-';
    console.log(`  ${icon} ${category}:`);
    for (const file of categoryFiles) {
      let suffix = '';
      if (file.isTemplate) suffix += ' (template)';
      if (file.isEncrypted) suffix += ' (encrypted)';
      console.log(`      ${file.targetPath}${chalk.dim(suffix)}`);
    }
  }

  console.log('\n');

  // Show warnings
  const templates = files.filter(f => f.isTemplate);
  if (templates.length > 0) {
    prompts.log.warn(
      `${templates.length} template file(s) will be imported with evaluated content.\n` +
      `  Original templates will NOT be preserved.`
    );
  }

  const encrypted = files.filter(f => f.isEncrypted);
  if (encrypted.length > 0) {
    prompts.log.warn(
      `${encrypted.length} encrypted file(s) found.\n` +
      `  These will be skipped unless --include-encrypted is used.`
    );
  }
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
      // Skip encrypted if not requested
      if (file.isEncrypted && !options.includeEncrypted) {
        skipped.push(file);
        continue;
      }

      // Get actual content (evaluating templates if needed)
      let content: string;
      if (file.isTemplate) {
        const result = await processTemplate(file.sourcePath, file.targetPath);
        content = result.content;
      } else if (file.isEncrypted) {
        // Use chezmoi to decrypt
        const { stdout } = await execAsync(
          `chezmoi decrypt "${file.sourcePath}"`
        );
        content = stdout;
      } else {
        content = await readFile(file.sourcePath, 'utf-8');
      }

      // Write to tuck's file structure
      const tuckDest = getDestinationPath(tuckDir, file.category, filename);
      await ensureDir(dirname(tuckDest));
      await writeFile(tuckDest, content);

      // Set permissions if needed
      if (file.metadata.isExecutable) {
        await chmod(tuckDest, 0o755);
      } else if (file.metadata.isPrivate) {
        await chmod(tuckDest, 0o600);
      }

      // Add to manifest
      await addFileToManifest(tuckDir, generateFileId(file.targetPath), {
        source: file.targetPath,
        destination: getRelativeDestination(file.category, filename),
        category: file.category,
        strategy: 'copy',
        encrypted: false,
        template: false,  // Already evaluated
        permissions: file.metadata.isPrivate ? '600' :
                     file.metadata.isExecutable ? '755' : undefined,
        added: new Date().toISOString(),
        modified: new Date().toISOString(),
        checksum: await getFileChecksum(tuckDest),
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

### Step 5: Cleanup (Optional)

```typescript
async function step5_cleanup(): Promise<void> {
  // Offer to run chezmoi purge
  const shouldCleanup = await prompts.confirm(
    'Remove chezmoi installation? (runs `chezmoi purge`)',
    false  // Default to no
  );

  if (!shouldCleanup) {
    logger.info('Keeping chezmoi installation');
    logger.info('You can manually remove it later with: chezmoi purge');
    return;
  }

  // Create additional backup
  const backupPath = await backupDirectory(this.sourcePath);
  logger.info(`Backed up chezmoi source to: ${backupPath}`);

  // Run chezmoi purge
  if (await commandExists('chezmoi')) {
    await execAsync('chezmoi purge --force');
    logger.success('Chezmoi installation removed');
  } else {
    // Manual cleanup
    await rm(this.sourcePath, { recursive: true });
    logger.success('Chezmoi source directory removed');
  }
}
```

---

## Edge Cases

### 1. `.chezmoiroot` Custom Root

Some repos use a subdirectory as the actual source:

```
repo/
├── .chezmoiroot     # Contains "home"
└── home/
    ├── dot_zshrc
    └── dot_gitconfig
```

**Solution:** Check for `.chezmoiroot` and adjust source path accordingly.

### 2. External Files

Chezmoi can fetch files from URLs via `.chezmoiexternal.toml`:

```toml
[".oh-my-zsh"]
    type = "archive"
    url = "https://github.com/ohmyzsh/ohmyzsh/archive/master.tar.gz"
```

**Solution:** Skip external files, provide guidance to user.

### 3. Modify Scripts

Files prefixed with `modify_` are scripts that modify existing files:

```bash
#!/bin/bash
# modify_dot_config/private_example/config.yaml
# Reads stdin (existing file), outputs modified version
```

**Solution:** Skip modify scripts, warn user they need manual handling.

### 4. Run Scripts

Scripts prefixed with `run_` are executed during `chezmoi apply`:

```
run_once_install-homebrew.sh
run_onchange_update-plugins.sh
```

**Solution:**
- Skip scripts during import
- Optionally offer to convert to tuck hooks (future)
- Document scripts that user needs to handle manually

### 5. Symlink Mode

Some files are created as symlinks:

```
symlink_dot_current-theme → themes/dark.yaml
```

**Solution:**
- Resolve symlink target
- Import actual content
- Note: tuck supports symlink strategy via config

### 6. Empty Files

Files prefixed with `empty_` can be zero-length:

```
empty_dot_hushlogin
```

**Solution:** Create empty file in tuck with appropriate handling.

### 7. Template Partials

Files in `.chezmoitemplates/` are partials, not standalone:

```
.chezmoitemplates/
└── common.tmpl    # Used by {{ template "common.tmpl" }}
```

**Solution:** Skip template partials, they're embedded in other files.

### 8. Encrypted Files Without Key

User may not have the age key available.

**Solution:**
- Detect encrypted files
- Require `--include-encrypted` flag
- Attempt decryption with `chezmoi decrypt`
- Fail gracefully with clear message if key unavailable

---

## Implementation

### File: `src/lib/migrate/chezmoi.ts`

```typescript
import { join } from 'path';
import { homedir } from 'os';
import { readdir, readFile, stat } from 'fs/promises';
import type { Migrator, DetectionResult, MigratedFile, MigrationResult, MigrationOptions } from './index.js';
import { pathExists, expandPath, collapsePath } from '../paths.js';
import { commandExists, execAsync } from './common.js';

export class ChezmoiMigrator implements Migrator {
  readonly name = 'chezmoi';
  readonly displayName = 'Chezmoi';

  private sourcePath: string | null = null;
  private configPath: string | null = null;

  async detect(): Promise<DetectionResult> {
    // Implementation as described above
  }

  async getTrackedFiles(): Promise<MigratedFile[]> {
    // Implementation as described above
  }

  async validate(): Promise<{ valid: boolean; issues: string[] }> {
    // Implementation as described above
  }

  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    // Implementation as described above
  }

  async cleanup(): Promise<void> {
    // Implementation as described above
  }

  // Private helpers
  private parseFilename(name: string): ParsedChezmoiFilename {
    // Implementation as described above
  }

  private async walkSourceDirectory(): Promise<WalkEntry[]> {
    // Recursively walk source directory
  }

  private async processTemplate(path: string): Promise<string> {
    // Evaluate template using chezmoi CLI
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('ChezmoiMigrator', () => {
  describe('parseFilename', () => {
    const testCases = [
      { input: 'dot_zshrc', expected: { targetName: '.zshrc' } },
      { input: 'dot_gitconfig', expected: { targetName: '.gitconfig' } },
      { input: 'private_dot_ssh', expected: { targetName: '.ssh', isPrivate: true } },
      { input: 'executable_dot_local/bin/myscript', expected: { targetName: '.local', isExecutable: true } },
      { input: 'encrypted_private_dot_netrc', expected: { targetName: '.netrc', isEncrypted: true, isPrivate: true } },
      { input: 'dot_zshrc.tmpl', expected: { targetName: '.zshrc', isTemplate: true } },
      { input: 'run_once_setup.sh', expected: { isScript: true, isOnce: true } },
      { input: 'symlink_dot_vimrc', expected: { targetName: '.vimrc', isSymlink: true } },
      { input: 'literal_dot_special', expected: { targetName: 'dot_special' } },
    ];

    for (const { input, expected } of testCases) {
      it(`should parse "${input}" correctly`, () => {
        const result = parseChezmoiFilename(input);
        expect(result).toMatchObject(expected);
      });
    }
  });

  describe('reconstructTargetPath', () => {
    it('should handle nested directories', () => {
      const result = reconstructTargetPath('dot_config/nvim/init.lua');
      expect(result.targetPath).toBe('~/.config/nvim/init.lua');
    });

    it('should handle private directories', () => {
      const result = reconstructTargetPath('private_dot_ssh/config');
      expect(result.targetPath).toBe('~/.ssh/config');
    });
  });

  describe('hasChezmoiTemplates', () => {
    it('should detect variable syntax', () => {
      expect(hasChezmoiTemplates('{{ .chezmoi.hostname }}')).toBe(true);
    });

    it('should detect conditionals', () => {
      expect(hasChezmoiTemplates('{{ if eq .chezmoi.os "darwin" }}')).toBe(true);
    });

    it('should not match regular files', () => {
      expect(hasChezmoiTemplates('export PATH=$HOME/bin:$PATH')).toBe(false);
    });
  });
});
```

### Integration Tests

```typescript
describe('Chezmoi Migration Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'chezmoi-test-'));

    // Create fake chezmoi structure
    await mkdir(join(testDir, 'chezmoi'));
    await writeFile(
      join(testDir, 'chezmoi', 'dot_zshrc'),
      'export PATH=$HOME/bin:$PATH'
    );
    await writeFile(
      join(testDir, 'chezmoi', 'dot_gitconfig'),
      '[user]\n  name = Test User'
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it('should migrate simple dotfiles', async () => {
    // Test implementation
  });
});
```

---

## Summary

The chezmoi migration is the most complex due to its rich feature set. Key points:

1. **Parse filename prefixes carefully** - Order matters
2. **Use chezmoi CLI when available** - For templates and encryption
3. **Skip scripts and external files** - These don't map to tuck
4. **Evaluate templates** - Import actual content, not template source
5. **Preserve permissions** - Private and executable flags
6. **Handle edge cases** - `.chezmoiroot`, empty files, symlinks

---

*Last updated: December 2024*
