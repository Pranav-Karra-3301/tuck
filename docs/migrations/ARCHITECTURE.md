# Migration Tools Architecture

> Comprehensive technical design for tuck's migration system (v1.4.0)

This document describes the architecture for migrating users from other dotfiles managers to tuck. The migration system is designed to be safe, reversible, and provide a smooth transition experience.

---

## Table of Contents

1. [Overview](#overview)
2. [Supported Tools](#supported-tools)
3. [Core Architecture](#core-architecture)
4. [Migration Interface](#migration-interface)
5. [Common Utilities](#common-utilities)
6. [Command Structure](#command-structure)
7. [Security Considerations](#security-considerations)
8. [Testing Strategy](#testing-strategy)

---

## Overview

### Goals

1. **Zero data loss** - Never delete or overwrite files without explicit user consent
2. **Transparent process** - Show exactly what will be imported before doing it
3. **Reversible** - Allow users to abort at any point and maintain their original setup
4. **Feature parity awareness** - Inform users about features that don't have direct equivalents

### Non-Goals

- Automatic conversion of complex templates (manual conversion guidance instead)
- Migration of git history (fresh start approach)
- Support for unmaintained or obscure tools

---

## Supported Tools

| Tool | Detection Path | Difficulty | Notes |
|------|---------------|------------|-------|
| chezmoi | `~/.local/share/chezmoi` | Medium | Templates need conversion |
| yadm | `~/.local/share/yadm/repo.git` | Medium | Alt files, encryption |
| GNU Stow | `~/dotfiles` or `~/.dotfiles` | Low | Symlink resolution |
| Bare Git Repo | `~/.cfg` or `~/.dotfiles.git` | Low | Alias detection |

---

## Core Architecture

### Directory Structure

```
src/
├── commands/
│   └── migrate.ts              # Main migrate command
├── lib/
│   └── migrate/
│       ├── index.ts            # Exports and types
│       ├── common.ts           # Shared utilities
│       ├── detector.ts         # Tool detection logic
│       ├── chezmoi.ts          # Chezmoi migrator
│       ├── yadm.ts             # Yadm migrator
│       ├── stow.ts             # GNU Stow migrator
│       └── bare.ts             # Bare git repo migrator
```

### Migration Flow

```
┌─────────────────┐
│   tuck migrate  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Auto-Detection  │──── No tool found ──▶ Error: Manual tool selection required
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Parse & Extract │──── Parse errors ──▶ Error: Show details, suggest fixes
│  Tracked Files  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Security Check  │──── Secrets found ──▶ Warning: Skip or require confirmation
│ (detect secrets)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Show Preview    │
│ (files to import)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ User Confirms?  │──── No ──▶ Cancel gracefully
└────────┬────────┘
         │ Yes
         ▼
┌─────────────────┐
│ Create Backup   │──── Backup fails ──▶ Error: Cannot proceed without backup
│ of Current State│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Import Files    │──── Import errors ──▶ Partial: Show what succeeded/failed
│ to Tuck Format  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Update Manifest │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Offer Cleanup   │──── User declines ──▶ Keep both (warn about conflicts)
│ of Old Tool     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Show Next Steps │
└─────────────────┘
```

---

## Migration Interface

### TypeScript Interface

```typescript
// src/lib/migrate/index.ts

/**
 * Information about a file to be migrated
 */
export interface MigratedFile {
  /** Original path in source tool's format */
  originalPath: string;

  /** Target path in home directory (e.g., ~/.zshrc) */
  targetPath: string;

  /** Absolute path to the actual file content */
  sourcePath: string;

  /** Detected category for tuck organization */
  category: string;

  /** Whether file contains template syntax */
  isTemplate: boolean;

  /** Template engine used (if applicable) */
  templateEngine?: 'chezmoi' | 'yadm' | 'jinja' | 'esh';

  /** Whether file is encrypted in source */
  isEncrypted: boolean;

  /** Tool-specific metadata */
  metadata: Record<string, unknown>;

  /** Warnings about this file */
  warnings: string[];
}

/**
 * Result of detecting a dotfiles tool
 */
export interface DetectionResult {
  /** The tool that was detected */
  tool: 'chezmoi' | 'yadm' | 'stow' | 'bare' | null;

  /** Path to the tool's data directory */
  path: string | null;

  /** Tool version if detectable */
  version?: string;

  /** Confidence level of detection */
  confidence: 'high' | 'medium' | 'low';

  /** Additional detection metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a migration operation
 */
export interface MigrationResult {
  /** Whether the migration was successful */
  success: boolean;

  /** Files that were successfully imported */
  imported: MigratedFile[];

  /** Files that failed to import */
  failed: Array<{
    file: MigratedFile;
    error: string;
  }>;

  /** Files that were skipped (e.g., user declined) */
  skipped: MigratedFile[];

  /** Warnings generated during migration */
  warnings: string[];

  /** Whether old tool setup was cleaned up */
  cleanedUp: boolean;
}

/**
 * Options for migration
 */
export interface MigrationOptions {
  /** Skip confirmation prompts */
  force?: boolean;

  /** Dry run - don't actually import */
  dryRun?: boolean;

  /** Don't offer to clean up old tool */
  keepOld?: boolean;

  /** Include encrypted files (requires decryption) */
  includeEncrypted?: boolean;

  /** Verbose output */
  verbose?: boolean;
}

/**
 * Base interface for all migrators
 */
export interface Migrator {
  /** Name of the tool this migrator handles */
  readonly name: string;

  /** Display name for UI */
  readonly displayName: string;

  /** Check if this tool is installed/present */
  detect(): Promise<DetectionResult>;

  /** Get list of files managed by this tool */
  getTrackedFiles(): Promise<MigratedFile[]>;

  /** Validate that migration is possible */
  validate(): Promise<{ valid: boolean; issues: string[] }>;

  /** Perform the actual migration */
  migrate(options: MigrationOptions): Promise<MigrationResult>;

  /** Clean up the old tool's configuration */
  cleanup(): Promise<void>;
}
```

---

## Common Utilities

### File: `src/lib/migrate/common.ts`

```typescript
/**
 * Shared utilities for all migrators
 */

/**
 * Resolve a path that may contain home directory references
 */
export function resolvePath(path: string): string;

/**
 * Convert a tool-specific path to a tuck target path
 * e.g., chezmoi's "dot_zshrc" → "~/.zshrc"
 */
export function normalizeTargetPath(path: string, tool: string): string;

/**
 * Detect if a file likely contains secrets
 * Uses patterns from src/commands/add.ts
 */
export function detectSensitiveFile(path: string): boolean;

/**
 * Detect if a file is a private key
 */
export function isPrivateKey(path: string): boolean;

/**
 * Read and validate that a path exists
 */
export function validatePath(path: string): Promise<boolean>;

/**
 * Create a backup of the current tuck state before migration
 */
export function createMigrationBackup(tuckDir: string): Promise<string>;

/**
 * Determine the appropriate category for a file
 * Reuses logic from src/lib/paths.ts
 */
export function categorizeFile(targetPath: string): string;

/**
 * Check if a file appears to be a template
 */
export function detectTemplate(
  content: string,
  tool: string
): { isTemplate: boolean; engine?: string };

/**
 * Parse common shell rc files to extract any inline secrets
 */
export function scanForInlineSecrets(content: string): string[];

/**
 * Format file list for display
 */
export function formatFileList(
  files: MigratedFile[],
  options?: { showWarnings?: boolean; groupByCategory?: boolean }
): string;

/**
 * Common XDG paths
 */
export const XDG_PATHS = {
  configHome: process.env.XDG_CONFIG_HOME || '~/.config',
  dataHome: process.env.XDG_DATA_HOME || '~/.local/share',
  cacheHome: process.env.XDG_CACHE_HOME || '~/.cache',
};
```

---

## Command Structure

### Main Command: `tuck migrate`

```bash
# Auto-detect and migrate
tuck migrate

# Migrate from specific tool
tuck migrate chezmoi
tuck migrate yadm
tuck migrate stow [stow-dir]
tuck migrate bare [git-dir]

# Options
tuck migrate --dry-run          # Preview without changes
tuck migrate --force            # Skip confirmations
tuck migrate --keep-old         # Don't offer cleanup
tuck migrate --include-encrypted # Include encrypted files
tuck migrate --verbose          # Detailed output
```

### Command Implementation Sketch

```typescript
// src/commands/migrate.ts

import { Command } from 'commander';
import { prompts, logger, withSpinner } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, createManifest } from '../lib/manifest.js';
import {
  detectTool,
  getMigrator,
  createMigrationBackup,
  type MigrationOptions,
} from '../lib/migrate/index.js';

export const migrateCommand = new Command('migrate')
  .description('Import dotfiles from another dotfiles manager')
  .argument('[tool]', 'Tool to migrate from (chezmoi, yadm, stow, bare)')
  .argument('[path]', 'Path to tool data (for stow/bare)')
  .option('--dry-run', 'Preview changes without applying')
  .option('--force', 'Skip confirmation prompts')
  .option('--keep-old', "Don't offer to remove old tool setup")
  .option('--include-encrypted', 'Include encrypted files')
  .option('--verbose', 'Show detailed output')
  .action(async (tool, path, options) => {
    await runMigrate(tool, path, options);
  });
```

---

## Security Considerations

### File Security Checks

1. **Private Key Detection**
   - NEVER import SSH private keys (`id_rsa`, `id_ed25519`, etc.)
   - Show clear error explaining why

2. **Sensitive File Warnings**
   - Detect files matching sensitive patterns
   - Require explicit confirmation for each
   - Log warning about private repository recommendation

3. **Encrypted File Handling**
   - Don't import encrypted files by default
   - Require `--include-encrypted` flag
   - Prompt for decryption if needed
   - Store decrypted content (tuck has its own encryption planned)

### Path Traversal Prevention

```typescript
// All imported paths must be validated
import { validateSafeSourcePath } from '../lib/paths.js';

// Before importing any file
validateSafeSourcePath(file.targetPath);
```

### Backup Requirements

- Create backup before ANY modifications
- Store backup metadata for potential rollback
- Verify backup was created successfully before proceeding

---

## Testing Strategy

### Unit Tests

```typescript
// tests/lib/migrate/chezmoi.test.ts

describe('ChezmoiMigrator', () => {
  describe('detect', () => {
    it('should detect chezmoi source directory', async () => {});
    it('should return null when chezmoi not present', async () => {});
  });

  describe('parseSourceFilename', () => {
    it('should parse dot_ prefix', () => {
      expect(parseSourceFilename('dot_zshrc')).toBe('.zshrc');
    });
    it('should parse executable_ prefix', () => {});
    it('should parse private_ prefix', () => {});
    it('should parse encrypted_ prefix', () => {});
    it('should handle .tmpl suffix', () => {});
    it('should handle nested directories', () => {});
  });

  describe('getTrackedFiles', () => {
    it('should list all managed files', async () => {});
    it('should detect templates', async () => {});
    it('should handle empty source directory', async () => {});
  });
});
```

### Integration Tests

```typescript
// tests/integration/migrate.test.ts

describe('tuck migrate', () => {
  describe('chezmoi migration', () => {
    beforeEach(async () => {
      // Set up fake chezmoi directory structure
    });

    it('should import simple dotfiles', async () => {});
    it('should preserve file permissions', async () => {});
    it('should skip encrypted files by default', async () => {});
    it('should create backup before migration', async () => {});
    it('should clean up chezmoi on request', async () => {});
  });
});
```

### Test Fixtures

Create test fixtures that mimic real dotfiles setups:

```
tests/fixtures/migrate/
├── chezmoi/
│   ├── dot_zshrc
│   ├── dot_gitconfig
│   ├── private_dot_ssh/
│   │   └── config
│   ├── dot_config/
│   │   └── nvim/
│   │       └── init.lua
│   └── run_once_install-packages.sh.tmpl
├── yadm/
│   ├── .zshrc
│   ├── .zshrc##os.Darwin
│   ├── .zshrc##os.Linux
│   └── .config/
│       └── yadm/
│           └── encrypt
├── stow/
│   ├── zsh/
│   │   └── .zshrc
│   ├── git/
│   │   └── .gitconfig
│   └── nvim/
│       └── .config/
│           └── nvim/
│               └── init.lua
└── bare/
    └── .cfg/  # bare git repo
```

---

## File Listing

Files to create for migration feature:

| File | Purpose |
|------|---------|
| `src/commands/migrate.ts` | Main migrate command |
| `src/lib/migrate/index.ts` | Exports and types |
| `src/lib/migrate/common.ts` | Shared utilities |
| `src/lib/migrate/detector.ts` | Tool detection logic |
| `src/lib/migrate/chezmoi.ts` | Chezmoi migrator |
| `src/lib/migrate/yadm.ts` | Yadm migrator |
| `src/lib/migrate/stow.ts` | GNU Stow migrator |
| `src/lib/migrate/bare.ts` | Bare git repo migrator |
| `tests/lib/migrate/*.test.ts` | Unit tests |
| `tests/integration/migrate.test.ts` | Integration tests |
| `tests/fixtures/migrate/*` | Test fixtures |

---

## Implementation Priority

1. **Phase 1: Core Infrastructure**
   - Migration interface and types
   - Common utilities
   - Detection system
   - Migrate command skeleton

2. **Phase 2: Simple Migrators**
   - Bare git repository (simplest)
   - GNU Stow (symlink resolution)

3. **Phase 3: Complex Migrators**
   - Yadm (alt files, encryption)
   - Chezmoi (templates, prefixes)

4. **Phase 4: Polish**
   - Comprehensive testing
   - Edge case handling
   - Documentation

---

## Related Documents

- [Chezmoi Migration Plan](./CHEZMOI.md)
- [Yadm Migration Plan](./YADM.md)
- [GNU Stow Migration Plan](./STOW.md)
- [Bare Git Repo Migration Plan](./BARE-GIT.md)
- [Edge Cases & Pitfalls](./EDGE-CASES.md)

---

*Last updated: December 2024*
