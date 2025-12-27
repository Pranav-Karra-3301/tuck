# CLAUDE.md - Claude Code Instructions for tuck

> This file provides context and instructions for Claude Code when working on the tuck project.

## Project Identity

**tuck** is a modern, beautiful dotfiles manager CLI built with TypeScript. It embodies the philosophy that developer tools should be:

- **Beautiful by default** — Every interaction should feel polished and intentional
- **Safe above all else** — Never lose data, always confirm destructive actions, create backups
- **Git-native** — Leverage git's power while abstracting its complexity
- **Zero-config to start** — Work out of the box, powerful when configured

### What tuck IS:
- A CLI tool for managing dotfiles across machines
- A git repository manager specialized for configuration files
- A cross-platform tool (macOS, Linux, Windows)
- A beautiful, modern terminal experience

### What tuck is NOT:
- A general-purpose backup tool
- A secrets manager (never store secrets in dotfiles)
- A system configuration manager
- A replacement for ansible/puppet/chef

---

## Technical Stack

```
Runtime:     Node.js 18+ (ESM modules)
Language:    TypeScript 5.x (strict mode)
Package Mgr: pnpm 9+
CLI:         Commander.js
Prompts:     @clack/prompts
Styling:     chalk, boxen, ora
Git:         simple-git
Files:       fs-extra
Validation:  zod
Testing:     Vitest
Build:       tsup
```

### Directory Structure

```
src/
├── commands/     # CLI command implementations (init, add, sync, etc.)
├── lib/          # Core library modules
│   ├── paths.ts      # Path utilities and resolution
│   ├── config.ts     # Configuration management
│   ├── manifest.ts   # File tracking manifest
│   ├── git.ts        # Git operations wrapper
│   ├── files.ts      # File system operations
│   ├── backup.ts     # Backup functionality
│   └── hooks.ts      # Pre/post hook execution
├── ui/           # Terminal UI components
│   ├── banner.ts     # ASCII art and boxes
│   ├── logger.ts     # Styled logging
│   ├── prompts.ts    # Interactive prompts
│   ├── spinner.ts    # Loading spinners
│   └── table.ts      # Table formatting
├── schemas/      # Zod validation schemas
├── constants.ts  # App constants
├── types.ts      # TypeScript types
├── errors.ts     # Custom error classes
└── index.ts      # Entry point
```

---

## Development Guidelines

### Code Philosophy

1. **Safety First**
   - Always validate user input
   - Create backups before destructive operations
   - Use confirmation prompts for dangerous actions
   - Never silently overwrite files
   - Handle errors gracefully with helpful messages

2. **Explicit Over Implicit**
   - Prefer verbose, clear code over clever one-liners
   - Name functions and variables descriptively
   - Document "why" not "what" in comments
   - Make state changes obvious

3. **User Experience**
   - Every command should have interactive and non-interactive modes
   - Provide helpful error messages with suggestions
   - Use spinners for long operations
   - Show progress for multi-step tasks
   - End successful operations with clear next steps

4. **Type Safety**
   - Use strict TypeScript everywhere
   - Validate external data with Zod schemas
   - Prefer `unknown` over `any`
   - Use branded types for paths when possible

### Code Style

```typescript
// DO: Explicit error handling with helpful messages
try {
  await copyFile(source, destination);
} catch (error) {
  throw new PermissionError(destination, 'write');
}

// DON'T: Silent failures or generic errors
await copyFile(source, destination).catch(() => {});

// DO: Interactive mode with confirmation
const confirmed = await prompts.confirm('Delete all backups?', false);
if (!confirmed) return;

// DON'T: Destructive actions without confirmation
await deleteAllBackups();

// DO: Expand paths consistently
const fullPath = expandPath('~/.zshrc');

// DON'T: Assume path format
const path = '~/.zshrc'; // Won't work with fs operations
```

---

## Common Tasks

### Adding a New Command

1. Create `src/commands/newcommand.ts`
2. Export command from `src/commands/index.ts`
3. Register in `src/index.ts`
4. Add tests in `tests/commands/newcommand.test.ts`

```typescript
// Template for new command
import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError } from '../errors.js';

export const newCommand = new Command('name')
  .description('What this command does')
  .option('-o, --option <value>', 'Option description')
  .action(async (options) => {
    const tuckDir = getTuckDir();

    // Verify initialized
    try {
      await loadManifest(tuckDir);
    } catch {
      throw new NotInitializedError();
    }

    // Implementation
  });
```

### Adding a New Library Module

1. Create `src/lib/newmodule.ts`
2. Export from `src/lib/index.ts`
3. Add tests in `tests/lib/newmodule.test.ts`

### Running Tests

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage
```

### Building

```bash
pnpm build             # Production build
pnpm dev               # Watch mode build
node dist/index.js     # Run locally
```

---

## Git Workflow

### Commit Messages

Follow [Conventional Commits](https://conventionalcommits.org):

```
feat: add new command for X
fix: resolve issue with Y
docs: update README
refactor: simplify Z logic
test: add tests for W
chore: update dependencies
```

### Branch Strategy

- `main` — Production-ready code, protected
- `feat/*` — New features
- `fix/*` — Bug fixes
- `docs/*` — Documentation updates

### Pull Requests

1. Always pull from main before starting work
2. Create feature branch
3. Make changes with atomic commits
4. Run `pnpm lint && pnpm typecheck && pnpm test`
5. Push and create PR
6. Wait for CI to pass

---

## Critical Rules

### NEVER Do These

1. **Never store secrets** — No API keys, passwords, or tokens in tracked files
2. **Never force push to main** — History is sacred
3. **Never skip tests** — All PRs must pass CI
4. **Never use `any` type** — Use `unknown` and narrow
5. **Never ignore errors** — Handle or propagate explicitly
6. **Never delete without backup** — Always offer recovery path
7. **Never assume paths** — Always use `expandPath()` and `collapsePath()`

### Always Do These

1. **Always validate input** — Use Zod schemas for external data
2. **Always confirm destructive actions** — Use `prompts.confirm()`
3. **Always provide feedback** — Spinners, progress, success messages
4. **Always handle edge cases** — Empty files, missing directories, permissions
5. **Always test on macOS and Linux** — Cross-platform is essential
6. **Always document public APIs** — JSDoc for exported functions

---

## Error Handling

Use custom error classes from `src/errors.ts`:

```typescript
// Available error types
NotInitializedError     // Tuck not set up
AlreadyInitializedError // Trying to init twice
FileNotFoundError       // File doesn't exist
FileNotTrackedError     // File not in manifest
FileAlreadyTrackedError // File already tracked
GitError                // Git operation failed
ConfigError             // Configuration issue
ManifestError           // Manifest corruption
PermissionError         // Can't read/write
```

All errors include:
- Human-readable message
- Error code for programmatic handling
- Suggestions for resolution

---

## Testing Strategy

### Unit Tests
- Test individual functions in isolation
- Mock file system operations with memfs
- Focus on edge cases

### Integration Tests
- Test command workflows end-to-end
- Use temporary directories
- Verify git state after operations

### Test Naming
```typescript
describe('functionName', () => {
  it('should do X when Y', () => {});
  it('should throw Z error when W', () => {});
});
```

---

## UI Guidelines

### Colors
- **Cyan** — Primary brand color, headings, emphasis
- **Green** — Success states, confirmations
- **Yellow** — Warnings, modifications
- **Red** — Errors, deletions
- **Dim/Gray** — Secondary info, paths, hints

### Feedback Patterns
```typescript
// Starting operation
prompts.intro('tuck sync');

// Progress
const spinner = prompts.spinner();
spinner.start('Syncing files...');
spinner.stop('Files synced');

// Success
prompts.log.success('Synced 5 files');

// Next steps
prompts.note("Run 'tuck push' to upload", 'Next step');

// Completion
prompts.outro('Done!');
```

---

## Debugging

```bash
# Enable debug output
DEBUG=1 node dist/index.js status

# Verbose logging
node dist/index.js status --verbose
```

Check `logger.debug()` calls for debug output.

---

## Performance Considerations

1. **Lazy loading** — Don't import everything at startup
2. **Parallel operations** — Use `Promise.all` for independent tasks
3. **Caching** — Config and manifest are cached per session
4. **Streaming** — For large file operations (future)

---

## Release Process

Releases are automated via semantic-release:

1. Merge to `main`
2. CI runs tests
3. semantic-release analyzes commits
4. Version bumped based on commit types
5. CHANGELOG updated
6. npm package published
7. GitHub release created
8. Binaries built and attached

---

## Getting Help

- Run `tuck --help` for CLI help
- Check `docs/` for documentation
- Open GitHub issue for bugs
- See CONTRIBUTING.md for contribution guide
