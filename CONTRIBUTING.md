<img src="public/contribution guide.png" alt="Contribution Guide" style="width:100%;">

# Contributing to tuck

Thank you for your interest in contributing to tuck! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Code Guidelines](#code-guidelines)
- [Testing](#testing)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Release Process](#release-process)

---

## Code of Conduct

Please be respectful and constructive in all interactions. We're building a tool that helps developers, and we want the contribution process to be welcoming and positive for everyone.

---

## Getting Started

### Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org/)
- **pnpm 9+** — Install with `npm install -g pnpm`
- **Git** — [Download](https://git-scm.com/)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Pranav-Karra-3301/tuck.git
cd tuck

# Install dependencies
pnpm install

# Build the project
pnpm build

# Run tests
pnpm test

# Try it out
node dist/index.js --help
```

---

## Development Setup

### Recommended Editor Setup

We recommend VS Code with the following extensions:
- ESLint
- Prettier
- TypeScript and JavaScript Language Features

### Environment

```bash
# Development build (watch mode)
pnpm dev

# Run linting
pnpm lint

# Run type checking
pnpm typecheck

# Run tests in watch mode
pnpm test:watch
```

### Debugging

```bash
# Enable debug output
DEBUG=1 node dist/index.js status

# Verbose mode
node dist/index.js status --verbose
```

---

## Project Structure

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
│   ├── lib/             # Core library modules
│   │   ├── paths.ts     # Path utilities
│   │   ├── config.ts    # Configuration management
│   │   ├── manifest.ts  # File tracking manifest
│   │   ├── git.ts       # Git operations wrapper
│   │   ├── files.ts     # File system operations
│   │   ├── backup.ts    # Backup functionality
│   │   └── hooks.ts     # Pre/post lifecycle hooks
│   ├── ui/              # Terminal UI components
│   │   ├── banner.ts    # ASCII art and boxes
│   │   ├── logger.ts    # Styled logging
│   │   ├── prompts.ts   # Interactive prompts
│   │   ├── spinner.ts   # Loading spinners
│   │   └── table.ts     # Table formatting
│   ├── schemas/         # Zod validation schemas
│   │   ├── config.schema.ts
│   │   └── manifest.schema.ts
│   ├── constants.ts     # Application constants
│   ├── types.ts         # TypeScript type definitions
│   ├── errors.ts        # Custom error classes
│   └── index.ts         # CLI entry point
├── tests/               # Test files (mirrors src structure)
├── docs/                # Documentation
├── dist/                # Build output (generated)
├── .github/             # GitHub Actions workflows
├── CLAUDE.md            # Claude Code instructions
├── AGENTS.md            # AI coding assistant guidelines
└── .cursor/             # Cursor editor config
```

---

## Making Changes

### Workflow

1. **Sync with development**
   ```bash
   git checkout development
   git pull origin development
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feat/your-feature-name
   # or for fixes:
   git checkout -b fix/issue-description
   ```

3. **Make your changes**
   - Write code following our [Code Guidelines](#code-guidelines)
   - Add tests for new functionality
   - Update documentation if needed

4. **Verify your changes**
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

5. **Commit your changes**
   ```bash
   git add -A
   git commit -m "feat: add amazing new feature"
   ```

6. **Push and create PR**
   ```bash
   git push -u origin feat/your-feature-name
   ```
   Open your PR against `development`.

---

## Code Guidelines

### TypeScript

- Use **strict mode** — it's enabled in tsconfig.json
- **Never use `any`** — use `unknown` and narrow with type guards
- Use **explicit types** for function parameters and return values
- Use `.js` extension for all local imports (ESM requirement)

```typescript
// Good
import { getTuckDir } from '../lib/paths.js';

const processFile = async (path: string): Promise<void> => {
  // implementation
};

// Bad
import { getTuckDir } from '../lib/paths';

const processFile = async (path) => {
  // implementation
};
```

### Error Handling

> **Reference Guide**: See [docs/ERROR_CODES.md](docs/ERROR_CODES.md) for a complete list of error codes and their meanings.

- Use custom error classes from `src/errors.ts`
- Always provide helpful error messages
- Never silently swallow errors
- Use `errorToMessage()` from `src/lib/validation.ts` for safe error string extraction

```typescript
// Good
try {
  await copyFile(source, destination);
} catch (error) {
  throw new PermissionError(destination, 'write');
}

// Bad
await copyFile(source, destination).catch(() => {});
```

### User Safety

- **Always confirm** destructive operations
- **Always create backups** before modifying files
- **Never store secrets** in tracked files

```typescript
// Good
const confirmed = await prompts.confirm(
  'This will delete all backups. Continue?',
  false // Default to safe option
);
if (!confirmed) {
  prompts.cancel('Operation cancelled');
  return;
}
```

### UI Patterns

- Use `prompts.intro()` at command start
- Use `prompts.outro()` at command end
- Use spinners for operations over 100ms
- Show clear next steps after completion

```typescript
prompts.intro('tuck sync');

const spinner = prompts.spinner();
spinner.start('Syncing files...');
// ... work ...
spinner.stop('Synced 5 files');

prompts.note("Run 'tuck push' to upload changes", 'Next step');
prompts.outro('Done!');
```

---

## Testing

> **Comprehensive Guide**: See [docs/TESTING.md](docs/TESTING.md) for the full testing guide including test utilities, factories, and security testing patterns.

### Running Tests

```bash
# Run all tests
pnpm test

# Watch mode (re-run on changes)
pnpm test:watch

# With coverage report
pnpm test:coverage

# Run specific test categories
pnpm test:security      # Security tests only
pnpm test:integration   # Integration tests only
pnpm test:unit          # Unit tests only
```

### Performance Benchmarks

> **Detailed Guide**: See [docs/BENCHMARKING.md](docs/BENCHMARKING.md) for performance targets, bottleneck analysis, and optimization opportunities.

```bash
# Run all benchmarks
pnpm bench

# Before submitting PRs, check for performance regressions
pnpm bench > before.txt
# Make changes...
pnpm bench > after.txt
diff before.txt after.txt
```

### Writing Tests

Tests should be placed in the `tests/` directory, mirroring the `src/` structure.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { functionUnderTest } from '../src/lib/module.js';

describe('functionUnderTest', () => {
  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  it('should return expected result for valid input', () => {
    const result = functionUnderTest('valid-input');
    expect(result).toBe('expected-output');
  });

  it('should throw CustomError for invalid input', () => {
    expect(() => functionUnderTest(null)).toThrow(CustomError);
  });
});
```

### Test Guidelines

- Test both success paths and error paths
- Use temporary directories for file operations
- Mock external services when needed
- Aim for high coverage but prioritize meaningful tests
- Add security tests for any user-input handling
- Add benchmarks for performance-critical code paths

---

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) for automatic versioning.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | Minor |
| `fix` | Bug fix | Patch |
| `docs` | Documentation only | None |
| `style` | Code style (formatting) | None |
| `refactor` | Code restructuring | None |
| `perf` | Performance improvement | Patch |
| `test` | Adding/updating tests | None |
| `chore` | Maintenance tasks | None |

### Examples

```bash
# Feature (minor version bump: 0.1.0 -> 0.2.0)
git commit -m "feat: add restore command for backup recovery"

# Fix (patch version bump: 0.1.0 -> 0.1.1)
git commit -m "fix: handle missing config file gracefully"

# Breaking change (major version bump: 0.1.0 -> 1.0.0)
git commit -m "feat!: redesign configuration format

BREAKING CHANGE: Config files must be migrated to new format"

# Scoped commit
git commit -m "feat(sync): add progress indicator for large syncs"
```

---

## Pull Requests

### Before Submitting

1. **Sync with development** to avoid conflicts
   ```bash
   git fetch origin
   git rebase origin/development
   ```

2. **Run all checks**
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

3. **Update documentation** if you changed behavior

### PR Template

```markdown
## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update

## Checklist
- [ ] My code follows the project's code style
- [ ] I have added tests covering my changes
- [ ] All new and existing tests pass
- [ ] I have updated documentation as needed
- [ ] My commits follow conventional commit format
```

### Review Process

1. Create your PR against `development`
2. Wait for required CI checks to pass (mandatory for merges to `main`)
3. Request review from maintainers
4. Address feedback if any
5. Once approved, your PR will be merged into `development`
6. Maintainers merge `development` into `main` for releases; merging to `main` requires all checks/actions to be green

---

## Release Process

Releases are fully automated via semantic-release:

1. **Merges to main** (typically from `development`) trigger the release workflow
2. **Commit messages** determine version bump
3. **CHANGELOG.md** is automatically updated
4. **npm package** is published
5. **GitHub release** is created with binaries

### Version Bumping

| Commit Type | Version Bump | Example |
|-------------|--------------|---------|
| `fix:` | Patch (0.0.x) | 0.1.0 -> 0.1.1 |
| `feat:` | Minor (0.x.0) | 0.1.0 -> 0.2.0 |
| `BREAKING CHANGE` | Major (x.0.0) | 0.1.0 -> 1.0.0 |

---

## Getting Help

- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Documentation**: Check the `docs/` directory

---

## Recognition

Contributors will be recognized in:
- GitHub contributors list
- Release notes for significant contributions
- README.md acknowledgments section

Thank you for contributing to tuck!
