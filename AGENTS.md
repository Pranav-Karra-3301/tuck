# AGENTS.md - AI Coding Assistant Guidelines for tuck

> Instructions for GitHub Copilot, OpenAI Codex, and other AI coding assistants working on the tuck project.

## Project Overview

**tuck** is a modern dotfiles manager CLI built with TypeScript and Node.js. It provides a beautiful, safe, and git-native way to manage configuration files across machines.

### Core Values

1. **Safety First** — Never lose user data, always confirm destructive operations
2. **Beautiful by Default** — Polished terminal UI using @clack/prompts, chalk, boxen
3. **Git-Native** — Built on git but abstracts complexity
4. **Zero-Config Start** — Works immediately, powerful when configured

---

## Tech Stack Reference

| Component | Technology | Notes |
|-----------|------------|-------|
| Runtime | Node.js 18+ | ESM modules only |
| Language | TypeScript 5.x | Strict mode enabled |
| Package Manager | pnpm 9+ | Use `pnpm` not `npm` |
| CLI Framework | Commander.js | v12+ |
| Prompts | @clack/prompts | For interactive UI |
| Styling | chalk, boxen, ora | Terminal colors/boxes/spinners |
| Git | simple-git | Async git operations |
| File System | fs-extra | Extended fs operations |
| Validation | Zod | Runtime type validation |
| Testing | Vitest | Unit and integration tests |
| Build | tsup | Bundle to single file |

---

## Directory Structure

```
tuck/
├── src/
│   ├── commands/        # CLI command implementations
│   │   ├── init.ts      # tuck init
│   │   ├── add.ts       # tuck add <path>
│   │   ├── remove.ts    # tuck remove <path>
│   │   ├── sync.ts      # tuck sync
│   │   ├── push.ts      # tuck push
│   │   ├── pull.ts      # tuck pull
│   │   ├── restore.ts   # tuck restore
│   │   ├── status.ts    # tuck status
│   │   ├── list.ts      # tuck list
│   │   ├── diff.ts      # tuck diff
│   │   └── config.ts    # tuck config
│   ├── lib/             # Core modules
│   │   ├── paths.ts     # Path utilities
│   │   ├── config.ts    # Config management
│   │   ├── manifest.ts  # File tracking
│   │   ├── git.ts       # Git wrapper
│   │   ├── files.ts     # File operations
│   │   ├── backup.ts    # Backup system
│   │   └── hooks.ts     # Lifecycle hooks
│   ├── ui/              # UI components
│   │   ├── banner.ts    # ASCII art
│   │   ├── logger.ts    # Styled logs
│   │   ├── prompts.ts   # Interactive prompts
│   │   ├── spinner.ts   # Loading spinners
│   │   └── table.ts     # Table output
│   ├── schemas/         # Zod schemas
│   ├── constants.ts     # App constants
│   ├── types.ts         # TypeScript types
│   ├── errors.ts        # Custom errors
│   └── index.ts         # Entry point
├── tests/               # Test files
├── dist/                # Build output
└── docs/                # Documentation
```

---

## Code Generation Guidelines

### DO Generate

1. **Explicit TypeScript types**
   ```typescript
   // Good
   interface FileChange {
     path: string;
     status: 'added' | 'modified' | 'deleted';
     checksum: string;
   }

   const detectChanges = async (dir: string): Promise<FileChange[]> => {
     // implementation
   };
   ```

2. **Proper error handling with custom errors**
   ```typescript
   // Good
   import { FileNotFoundError, PermissionError } from '../errors.js';

   if (!await pathExists(filePath)) {
     throw new FileNotFoundError(filePath);
   }
   ```

3. **User feedback with UI utilities**
   ```typescript
   // Good
   import { prompts, logger } from '../ui/index.js';

   prompts.intro('tuck sync');
   const spinner = prompts.spinner();
   spinner.start('Syncing files...');
   // work
   spinner.stop('Synced 5 files');
   prompts.outro('Done!');
   ```

4. **Confirmation for destructive actions**
   ```typescript
   // Good
   const confirmed = await prompts.confirm(
     'This will overwrite existing files. Continue?',
     false
   );
   if (!confirmed) {
     prompts.cancel('Operation cancelled');
     return;
   }
   ```

5. **Path handling with utilities**
   ```typescript
   // Good
   import { expandPath, collapsePath, pathExists } from '../lib/paths.js';

   const fullPath = expandPath('~/.zshrc');
   const displayPath = collapsePath(fullPath);
   ```

### DO NOT Generate

1. **Never use `any` type**
   ```typescript
   // Bad
   const data: any = JSON.parse(content);

   // Good
   const data: unknown = JSON.parse(content);
   const validated = ConfigSchema.parse(data);
   ```

2. **Never ignore errors silently**
   ```typescript
   // Bad
   await copyFile(src, dest).catch(() => {});

   // Good
   try {
     await copyFile(src, dest);
   } catch (error) {
     throw new PermissionError(dest, 'write');
   }
   ```

3. **Never hardcode paths**
   ```typescript
   // Bad
   const config = '/Users/user/.tuck/config.json';

   // Good
   const config = getConfigPath(getTuckDir());
   ```

4. **Never use npm commands**
   ```bash
   # Bad
   npm install
   npm test

   # Good
   pnpm install
   pnpm test
   ```

5. **Never skip the shebang in tsup** (it's added automatically)
   ```typescript
   // src/index.ts should NOT have shebang
   // tsup.config.ts adds it via banner option
   ```

---

## Common Patterns

### Creating a New Command

```typescript
import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError } from '../errors.js';
import type { CommandOptions } from '../types.js';

interface MyCommandOptions extends CommandOptions {
  myOption?: string;
}

const runMyCommand = async (options: MyCommandOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Always verify initialization
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  prompts.intro('tuck mycommand');

  // Implementation here

  prompts.outro('Complete!');
};

export const myCommand = new Command('mycommand')
  .description('What this command does')
  .option('-m, --my-option <value>', 'Option description')
  .action(async (options: MyCommandOptions) => {
    await runMyCommand(options);
  });
```

### Working with the Manifest

```typescript
import {
  loadManifest,
  saveManifest,
  getTrackedFileBySource,
  getAllTrackedFiles
} from '../lib/manifest.js';

// Load manifest
const manifest = await loadManifest(tuckDir);

// Check if file is tracked
const tracked = await getTrackedFileBySource(tuckDir, '~/.zshrc');
if (tracked) {
  console.log(tracked.id, tracked.file);
}

// Add a file to manifest
manifest.files[fileId] = {
  source: collapsePath(sourcePath),
  destination: `files/${category}/${filename}`,
  checksum: await getFileChecksum(sourcePath),
  category,
  addedAt: new Date().toISOString(),
};

// Save changes
await saveManifest(manifest, tuckDir);
```

### Git Operations

```typescript
import {
  initRepo,
  commitChanges,
  hasRemote,
  pushChanges,
  getStatus
} from '../lib/git.js';

// Check status
const status = await getStatus(tuckDir);
if (status.modified.length > 0) {
  // Handle modified files
}

// Commit
await commitChanges(tuckDir, 'feat: add new configuration');

// Push if remote exists
if (await hasRemote(tuckDir)) {
  await pushChanges(tuckDir);
}
```

---

## Testing Guidelines

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('functionName', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it('should do expected behavior when given valid input', () => {
    const result = functionName(validInput);
    expect(result).toBe(expectedOutput);
  });

  it('should throw CustomError when given invalid input', () => {
    expect(() => functionName(invalidInput)).toThrow(CustomError);
  });
});
```

### Running Tests

```bash
pnpm test              # Run all tests once
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage report
```

---

## Build Commands

```bash
# Development
pnpm dev               # Watch mode build
pnpm build             # Production build
pnpm lint              # Run ESLint
pnpm lint:fix          # Fix linting issues
pnpm typecheck         # TypeScript check
pnpm format            # Format with Prettier

# Testing
pnpm test              # Run tests
pnpm test:coverage     # With coverage

# Running locally
node dist/index.js status
node dist/index.js --help
```

---

## Commit Message Format

Follow Conventional Commits for semantic versioning:

```
feat: add new feature (minor version bump)
fix: fix a bug (patch version bump)
docs: documentation only
style: formatting, no code change
refactor: restructure without behavior change
test: add or update tests
chore: maintenance tasks

BREAKING CHANGE: in footer triggers major bump
```

Examples:
```
feat: add restore command for backup recovery
fix: handle missing config file gracefully
docs: update CLAUDE.md with new patterns
refactor: extract file operations to lib/files.ts
test: add integration tests for sync command
chore: update dependencies
```

---

## Critical Safety Rules

### NEVER

1. Store secrets (API keys, passwords, tokens) in tracked files
2. Execute commands without confirming destructive actions
3. Overwrite files without creating backups
4. Force push to main branch
5. Skip tests or linting in PRs
6. Use `any` type without explicit justification
7. Ignore caught errors
8. Delete user files without confirmation
9. Assume path format (always use expandPath/collapsePath)
10. Generate code that could lose user data

### ALWAYS

1. Validate external input with Zod schemas
2. Use custom error classes from errors.ts
3. Provide helpful error messages with suggestions
4. Create backups before modifying tracked files
5. Show progress for long operations
6. Test on both macOS and Linux
7. Use ESM imports with .js extensions
8. Handle edge cases (empty files, missing dirs, permissions)
9. Pull from main before starting work
10. Run full test suite before committing

---

## File Categories

tuck auto-categorizes files:

| Category | Patterns |
|----------|----------|
| shell | .bashrc, .zshrc, .profile, etc. |
| git | .gitconfig, .gitignore_global |
| editors | .vimrc, .emacs, VS Code settings |
| terminal | .tmux.conf, .alacritty.yml |
| ssh | .ssh/config (never keys!) |
| misc | Everything else |

---

## Import Conventions

Always use `.js` extension for local imports (ESM requirement):

```typescript
// Correct
import { getTuckDir } from '../lib/paths.js';
import { prompts } from '../ui/index.js';
import type { TuckConfig } from '../types.js';

// Incorrect
import { getTuckDir } from '../lib/paths';
import { prompts } from '../ui';
```

---

## Error Handling Reference

```typescript
// Available error classes
import {
  NotInitializedError,      // Tuck directory not set up
  AlreadyInitializedError,  // Already initialized
  FileNotFoundError,        // File doesn't exist
  FileNotTrackedError,      // File not in manifest
  FileAlreadyTrackedError,  // File already being tracked
  GitError,                 // Git operation failed
  ConfigError,              // Configuration error
  ManifestError,            // Manifest corruption/issue
  PermissionError,          // Can't read/write file
} from '../errors.js';

// Usage
throw new FileNotFoundError(path);
throw new PermissionError(path, 'write');
throw new GitError('Failed to commit', 'git commit');
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Build | `pnpm build` |
| Test | `pnpm test` |
| Lint | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Run locally | `node dist/index.js` |

| Path Function | Purpose |
|---------------|---------|
| `getTuckDir()` | Get ~/.tuck path |
| `expandPath(p)` | Expand ~ to full path |
| `collapsePath(p)` | Collapse home to ~ |
| `pathExists(p)` | Check if path exists |

| UI Function | Purpose |
|-------------|---------|
| `prompts.intro(msg)` | Start command section |
| `prompts.outro(msg)` | End command section |
| `prompts.confirm(q)` | Yes/no confirmation |
| `prompts.spinner()` | Loading spinner |
| `logger.info/warn/error` | Styled logging |
