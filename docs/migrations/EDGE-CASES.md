# Migration Edge Cases & Pitfalls

> Comprehensive guide to edge cases, common mistakes, and how to handle them

---

## Table of Contents

1. [Universal Edge Cases](#universal-edge-cases)
2. [Security Concerns](#security-concerns)
3. [File System Edge Cases](#file-system-edge-cases)
4. [Tool-Specific Pitfalls](#tool-specific-pitfalls)
5. [Common Mistakes to Avoid](#common-mistakes-to-avoid)
6. [Error Recovery](#error-recovery)
7. [Testing Checklist](#testing-checklist)

---

## Universal Edge Cases

These edge cases apply to migrations from any dotfiles manager.

### 1. Files Outside Home Directory

**Issue:** Some tools can track files outside `$HOME` (e.g., `/etc/hosts`, system configs).

**How it manifests:**
```
chezmoi add /etc/hosts
yadm add /etc/hosts
```

**Solution:**
```typescript
function validateFilePath(path: string): { valid: boolean; reason?: string } {
  const expanded = expandPath(path);
  const home = homedir();

  if (!expanded.startsWith(home + '/') && expanded !== home) {
    return {
      valid: false,
      reason: `File is outside home directory: ${path}. Tuck only manages files in $HOME.`,
    };
  }

  return { valid: true };
}
```

**User guidance:** Inform user these files will be skipped and suggest manual management.

---

### 2. Symbolic Links

**Issue:** File might be a symlink to another location, or the target might not exist.

**Scenarios:**
- Symlink to file inside stow directory (normal for stow)
- Symlink to file outside home (edge case)
- Broken symlink (target deleted)
- Circular symlinks

**Solution:**
```typescript
async function resolveSymlink(path: string): Promise<{
  type: 'file' | 'directory' | 'broken' | 'circular';
  realPath: string | null;
  depth: number;
}> {
  const MAX_DEPTH = 40;  // Prevent infinite loops
  let current = path;
  let depth = 0;
  const seen = new Set<string>();

  while (depth < MAX_DEPTH) {
    try {
      const stats = await lstat(current);

      if (!stats.isSymbolicLink()) {
        return {
          type: stats.isDirectory() ? 'directory' : 'file',
          realPath: current,
          depth,
        };
      }

      if (seen.has(current)) {
        return { type: 'circular', realPath: null, depth };
      }
      seen.add(current);

      const target = await readlink(current);
      current = resolve(dirname(current), target);
      depth++;
    } catch (error) {
      return { type: 'broken', realPath: null, depth };
    }
  }

  return { type: 'circular', realPath: null, depth: MAX_DEPTH };
}
```

---

### 3. Binary Files

**Issue:** Some tracked files might be binary (executables, images, fonts).

**Problems:**
- Large file sizes
- Can't display in diffs
- May contain sensitive data (compiled credentials)

**Solution:**
```typescript
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib',  // Executables
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',  // Images
  '.ttf', '.otf', '.woff', '.woff2',  // Fonts
  '.zip', '.tar', '.gz', '.bz2', '.xz',  // Archives
  '.db', '.sqlite', '.sqlite3',  // Databases
]);

const MAX_FILE_SIZE = 1024 * 1024;  // 1MB

async function checkFile(path: string): Promise<{
  isBinary: boolean;
  isLarge: boolean;
  size: number;
}> {
  const stats = await stat(path);
  const ext = extname(path).toLowerCase();

  return {
    isBinary: BINARY_EXTENSIONS.has(ext) || await isBinaryContent(path),
    isLarge: stats.size > MAX_FILE_SIZE,
    size: stats.size,
  };
}

async function isBinaryContent(path: string): Promise<boolean> {
  // Read first 8KB and check for null bytes
  const buffer = Buffer.alloc(8192);
  const fd = await open(path, 'r');
  await fd.read(buffer, 0, 8192, 0);
  await fd.close();

  return buffer.includes(0);  // Null byte indicates binary
}
```

**User guidance:** Warn about large/binary files, offer to skip.

---

### 4. Empty Files

**Issue:** Some dotfiles are intentionally empty (e.g., `.hushlogin`, `.sudo_as_admin_successful`).

**Solution:**
```typescript
async function handleEmptyFile(path: string): Promise<void> {
  const stats = await stat(path);

  if (stats.size === 0) {
    // Still import - some files must be empty to have effect
    logger.info(`Importing empty file: ${path}`);
  }
}
```

---

### 5. Very Long Paths

**Issue:** Deeply nested paths might exceed file system limits.

**Solution:**
```typescript
const MAX_PATH_LENGTH = 260;  // Windows limit (Linux is 4096)

function validatePathLength(path: string): boolean {
  if (process.platform === 'win32' && path.length > MAX_PATH_LENGTH) {
    logger.warn(`Path exceeds Windows limit: ${path}`);
    return false;
  }
  return true;
}
```

---

### 6. Special Characters in Filenames

**Issue:** Filenames with spaces, unicode, or special chars may cause issues.

**Examples:**
```
.config/My Settings/config.yaml
.ssh/私のキー
.local/bin/hello world.sh
```

**Solution:**
```typescript
function sanitizeForStorage(filename: string): string {
  // Preserve original for source tracking, sanitize for storage
  return filename
    .replace(/\s+/g, '_')           // Spaces to underscores
    .replace(/[<>:"|?*]/g, '-')     // Windows forbidden chars
    .normalize('NFC');               // Normalize unicode
}
```

---

### 7. File Permission Mismatches

**Issue:** Source file permissions might not match what tuck expects.

**Examples:**
- Private key with 777 (security issue)
- Script without execute bit
- Config with restrictive permissions that prevent reading

**Solution:**
```typescript
async function validatePermissions(path: string): Promise<{
  valid: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const stats = await stat(path);
  const mode = stats.mode & 0o777;

  // Check for overly permissive
  if (isSensitivePath(path) && (mode & 0o077) !== 0) {
    warnings.push(`File is readable by group/others: ${path}`);
  }

  // Check for non-readable
  if ((mode & 0o400) === 0) {
    warnings.push(`File is not readable: ${path}`);
    return { valid: false, warnings };
  }

  return { valid: true, warnings };
}
```

---

### 8. Hidden Subdirectories

**Issue:** Directories like `.config` may contain both tracked and untracked items.

**Solution:**
```typescript
async function importDirectory(
  sourcePath: string,
  trackedFiles: Set<string>
): Promise<void> {
  // Only import files that were explicitly tracked
  // Don't recursively grab everything in a directory

  const entries = await readdir(sourcePath, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(entry.parentPath, entry.name);

    if (trackedFiles.has(fullPath) && entry.isFile()) {
      await importFile(fullPath);
    }
  }
}
```

---

### 9. Dotfiles That Reference Other Dotfiles

**Issue:** Some configs reference other files by path:

```bash
# .zshrc
source ~/.zsh/aliases.zsh
source ~/.zsh/functions.zsh
```

**Solution:**
- Import referenced files too
- Or warn user about dependencies

```typescript
function detectDependencies(content: string): string[] {
  const patterns = [
    /source\s+([~$][\w/.]+)/g,           // Shell source
    /include\s+([~$][\w/.]+)/g,          // Include directives
    /\$HOME\/([\w/.]+)/g,                // Explicit home paths
  ];

  const deps: string[] = [];
  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      deps.push(expandPath(match[1]));
    }
  }

  return deps;
}
```

---

### 10. Git Submodules

**Issue:** Dotfiles repo might use submodules for plugins (vim, zsh, etc.).

**Solution:**
```typescript
async function detectSubmodules(repoPath: string): Promise<string[]> {
  const gitmodulesPath = join(repoPath, '.gitmodules');

  if (!await pathExists(gitmodulesPath)) {
    return [];
  }

  const content = await readFile(gitmodulesPath, 'utf-8');
  const submodules: string[] = [];

  const pathRegex = /path\s*=\s*(.+)/g;
  for (const match of content.matchAll(pathRegex)) {
    submodules.push(match[1].trim());
  }

  return submodules;
}
```

**User guidance:** Warn about submodules, suggest manual handling.

---

## Security Concerns

### 1. Private Keys

**CRITICAL:** Never import private keys.

**Detection:**
```typescript
const PRIVATE_KEY_PATTERNS = [
  // SSH keys
  /^id_rsa$/,
  /^id_ed25519$/,
  /^id_ecdsa$/,
  /^id_dsa$/,
  /\.pem$/,
  /\.key$/,

  // GPG
  /secring\.gpg$/,
  /private-keys-v1\.d\//,

  // Other
  /\.p12$/,
  /\.pfx$/,
];

const PRIVATE_KEY_HEADERS = [
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
];

async function isPrivateKey(path: string): Promise<boolean> {
  const name = basename(path);

  // Check filename patterns
  for (const pattern of PRIVATE_KEY_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }

  // Check file content (first line)
  try {
    const content = await readFile(path, 'utf-8');
    const firstLine = content.split('\n')[0];

    for (const header of PRIVATE_KEY_HEADERS) {
      if (firstLine.includes(header)) {
        return true;
      }
    }
  } catch {
    // Can't read file
  }

  return false;
}
```

---

### 2. Inline Secrets

**Issue:** Config files may contain hardcoded secrets.

**Detection:**
```typescript
const SECRET_PATTERNS = [
  // API keys
  /api[_-]?key\s*[:=]\s*['"]?[\w-]{20,}/gi,
  /secret\s*[:=]\s*['"]?[\w-]{20,}/gi,
  /token\s*[:=]\s*['"]?[\w-]{20,}/gi,

  // Passwords
  /password\s*[:=]\s*['"][^'"]+['"]/gi,
  /passwd\s*[:=]\s*['"][^'"]+['"]/gi,

  // AWS
  /AKIA[0-9A-Z]{16}/g,
  /aws_secret_access_key\s*[:=]/gi,

  // OAuth
  /client_secret\s*[:=]\s*['"]?[\w-]+/gi,

  // Database URLs with credentials
  /postgres:\/\/\w+:\w+@/gi,
  /mysql:\/\/\w+:\w+@/gi,
];

function detectInlineSecrets(content: string): string[] {
  const findings: string[] = [];

  for (const pattern of SECRET_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      // Mask the actual secret
      const masked = match[0].replace(/[:=]\s*['"]?[\w-]+/, '=***MASKED***');
      findings.push(masked);
    }
  }

  return findings;
}
```

---

### 3. Encrypted Files

**Issue:** Migrating encrypted files without proper handling.

**Rules:**
1. Don't import encrypted files by default
2. Require explicit flag (`--include-encrypted`)
3. Attempt decryption with user consent
4. Store decrypted content (tuck will have its own encryption)

---

### 4. File with Sensitive Names

**Warning for these files:**
```typescript
const SENSITIVE_FILES = [
  '.netrc',
  '.aws/credentials',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.kube/config',
  '.vault-token',
  '.circleci/cli.yml',
];
```

---

## File System Edge Cases

### 1. Case Sensitivity

**Issue:** macOS/Windows are case-insensitive, Linux is case-sensitive.

**Example problem:**
```
.Zshrc (macOS)
.zshrc (Linux)
```

**Solution:**
```typescript
function normalizeFilename(name: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin' || platform === 'win32') {
    // Case-insensitive: normalize to lowercase for comparison
    return name.toLowerCase();
  }
  return name;
}
```

---

### 2. Unicode Normalization

**Issue:** Unicode can be represented in different forms (NFC vs NFD).

**Example:** macOS uses NFD (decomposed), Linux uses NFC (composed).

**Solution:**
```typescript
function normalizeUnicode(path: string): string {
  return path.normalize('NFC');
}
```

---

### 3. Hardlinks

**Issue:** File might be a hardlink to another file.

**Detection:**
```typescript
async function isHardlink(path: string): Promise<boolean> {
  const stats = await stat(path);
  return stats.nlink > 1;
}
```

**Solution:** Treat as regular file, import content.

---

### 4. Special File Types

**Issue:** File might be a socket, FIFO, or device.

**Detection:**
```typescript
async function getFileType(path: string): Promise<
  'file' | 'directory' | 'symlink' | 'socket' | 'fifo' | 'block' | 'char' | 'unknown'
> {
  const stats = await lstat(path);

  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isSocket()) return 'socket';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isBlockDevice()) return 'block';
  if (stats.isCharacterDevice()) return 'char';

  return 'unknown';
}
```

**Solution:** Skip non-regular files with warning.

---

### 5. Extended Attributes (xattr)

**Issue:** Files may have extended attributes that need preserving.

**Detection (macOS):**
```typescript
async function hasXattrs(path: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`xattr -l "${path}"`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
```

**Solution:** Log warning, attributes won't be preserved.

---

### 6. ACLs (Access Control Lists)

**Issue:** Files may have complex ACLs beyond traditional permissions.

**Solution:** Log warning, ACLs won't be preserved.

---

## Tool-Specific Pitfalls

### Chezmoi

| Pitfall | Description | Solution |
|---------|-------------|----------|
| Prefix order | Prefixes must be parsed in specific order | Follow documented order |
| Template partials | `.chezmoitemplates/` files aren't standalone | Skip, they're embedded |
| Run scripts | `run_` prefixed files are scripts, not dotfiles | Skip, offer hook conversion |
| External files | URLs in `.chezmoiexternal.toml` | Skip, document for user |
| Modify scripts | `modify_` scripts transform files | Skip, complex to handle |
| `.chezmoiroot` | Source may be in subdirectory | Detect and adjust path |

### Yadm

| Pitfall | Description | Solution |
|---------|-------------|----------|
| Alternate selection | Wrong variant might be selected | Use yadm CLI or implement scoring |
| Template processors | Multiple template engines | Document which was used |
| Encrypted archive | Need yadm CLI to decrypt | Require `--include-encrypted` |
| Bootstrap script | Setup logic, not a dotfile | Skip, document for user |
| Class assignment | User-defined machine classes | Document active class |
| Worktree is $HOME | Files are in place, not copies | Don't duplicate, just track |

### GNU Stow

| Pitfall | Description | Solution |
|---------|-------------|----------|
| Folding | Directory symlinks vs file symlinks | Detect and walk directories |
| Multiple stow dirs | User might have several | Migrate one at a time |
| Ignore patterns | `.stow-local-ignore` uses Perl regex | Parse and apply |
| Adopt mode | Files might exist in both places | Prefer actual content |
| Tree conflicts | Stow uses specific conflict resolution | Not relevant for migration |

### Bare Git

| Pitfall | Description | Solution |
|---------|-------------|----------|
| Alias detection | Alias might use custom name | Search shell configs |
| Worktree config | Might not be $HOME | Read git config |
| Uncommitted changes | Files might be modified | Offer to commit first |
| Remote repository | User might want to keep pushing there | Document remote URL |
| Shell config tracking | Config contains the alias | Import but warn about alias |

---

## Common Mistakes to Avoid

### During Implementation

1. **Not creating backups**
   - ALWAYS create a backup before any migration
   - Store backup location for potential rollback

2. **Assuming file existence**
   - Always check if files exist before reading
   - Handle deleted/moved files gracefully

3. **Ignoring permissions**
   - Preserve file permissions during import
   - Check for unreadable files

4. **Forgetting to handle directories**
   - Some tracked items are directories
   - Walk contents correctly

5. **Not validating paths**
   - Always validate paths are within $HOME
   - Prevent path traversal attacks

6. **Assuming text encoding**
   - Not all files are UTF-8
   - Binary files exist
   - Handle encoding errors

7. **Silent failures**
   - Always report what failed and why
   - Provide actionable error messages

8. **Assuming CLI availability**
   - Source tool's CLI might not be installed
   - Have fallback detection methods

9. **Not handling empty results**
   - What if no files are found?
   - What if all files are skipped?

10. **Modifying source files**
    - Never modify the source tool's files
    - Only read, never write

### During Testing

1. **Only testing happy path**
   - Test error conditions
   - Test edge cases
   - Test on different platforms

2. **Not testing cleanup**
   - Test backup creation
   - Test cleanup removal
   - Test partial cleanup

3. **Ignoring performance**
   - Test with large numbers of files
   - Test with large files
   - Test with slow file systems

---

## Error Recovery

### Rollback Procedure

```typescript
async function rollback(backupPath: string, tuckDir: string): Promise<void> {
  logger.info('Rolling back migration...');

  // 1. Remove any files added to tuck
  const manifest = await loadManifest(tuckDir);
  for (const [id, file] of Object.entries(manifest.files)) {
    const destPath = join(tuckDir, file.destination);
    if (await pathExists(destPath)) {
      await rm(destPath, { recursive: true });
    }
  }

  // 2. Restore manifest from backup
  const backupManifest = join(backupPath, '.tuckmanifest.json');
  if (await pathExists(backupManifest)) {
    await copy(backupManifest, getManifestPath(tuckDir));
  }

  logger.success('Rollback complete');
}
```

### Partial Migration Recovery

```typescript
async function resumeMigration(
  migrationState: MigrationState
): Promise<void> {
  // Resume from last successful file
  const remaining = migrationState.files.filter(
    f => !migrationState.completed.includes(f.originalPath)
  );

  logger.info(`Resuming migration: ${remaining.length} files remaining`);

  for (const file of remaining) {
    try {
      await importFile(file);
      migrationState.completed.push(file.originalPath);
      await saveMigrationState(migrationState);
    } catch (error) {
      logger.error(`Failed to import ${file.originalPath}: ${error}`);
      throw error;
    }
  }
}
```

---

## Testing Checklist

### Unit Tests

- [ ] Filename parsing for each tool
- [ ] Path normalization
- [ ] Security detection (private keys, secrets)
- [ ] Category detection
- [ ] Symlink resolution
- [ ] Binary file detection
- [ ] Empty file handling
- [ ] Permission validation

### Integration Tests

- [ ] Detection of each tool
- [ ] Full migration flow
- [ ] Backup creation
- [ ] Cleanup removal
- [ ] Rollback procedure
- [ ] Error handling

### Edge Case Tests

- [ ] Files outside home
- [ ] Broken symlinks
- [ ] Large files
- [ ] Binary files
- [ ] Empty files
- [ ] Unicode filenames
- [ ] Special permissions
- [ ] Circular symlinks

### Platform Tests

- [ ] macOS
- [ ] Linux (various distros)
- [ ] Windows (if supported)
- [ ] Case sensitivity
- [ ] Path separators

### Security Tests

- [ ] Private key detection
- [ ] Secret pattern detection
- [ ] Encrypted file handling
- [ ] Path traversal prevention
- [ ] Permission preservation

---

## Reporting Issues

When migration fails, collect:

1. **Tool version** - Which version of source tool
2. **File list** - What files were being migrated
3. **Error message** - Exact error text
4. **Platform** - OS and version
5. **Permissions** - File permissions if relevant
6. **Partial state** - What succeeded before failure

---

*Last updated: December 2024*
