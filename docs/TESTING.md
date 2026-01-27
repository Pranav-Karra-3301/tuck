# Testing Guide

This guide covers tuck's testing infrastructure, how to run tests, write new tests, and follow testing best practices.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Test Infrastructure Overview](#test-infrastructure-overview)
- [Test Categories](#test-categories)
- [Writing Tests](#writing-tests)
- [Test Utilities Reference](#test-utilities-reference)
- [Security Testing](#security-testing)
- [Type Safety Best Practices](#type-safety-best-practices)
- [Common Pitfalls & Solutions](#common-pitfalls--solutions)

---

## Quick Start

### Running Tests

```bash
# Run all tests (unit + integration + security)
pnpm test

# Watch mode for development
pnpm test:watch

# Generate coverage report
pnpm test:coverage

# Run specific test categories
pnpm test:security      # Security tests only
pnpm test:integration   # Integration tests only
pnpm test:unit          # Unit tests only

# Run benchmarks (performance tests)
pnpm bench
```

### Running Specific Tests

```bash
# Run tests matching a pattern
pnpm test -- --grep "manifest"

# Run a specific test file
pnpm test tests/lib/manifest.test.ts

# Run with verbose output
pnpm test -- --reporter=verbose
```

### Checking Coverage

```bash
pnpm test:coverage
# View HTML report at coverage/index.html
```

---

## Test Infrastructure Overview

### Test Framework

- **Vitest**: Fast, ESM-native test runner (v1.2.0)
- **memfs**: In-memory filesystem for isolated tests
- **vi**: Vitest's mocking utilities

### Configuration Files

| File | Purpose |
|------|---------|
| `vitest.config.ts` | Main test configuration |
| `vitest.bench.config.ts` | Benchmark-specific configuration |
| `tests/setup.ts` | Global test setup (mocks, constants) |
| `tests/utils/testHelpers.ts` | High-level test utilities |
| `tests/utils/factories.ts` | Mock object factories |

### Key Architecture Decisions

1. **Virtual Filesystem**: All tests use `memfs` to avoid touching the real filesystem. This prevents accidental data loss and ensures test isolation.

2. **Mock Home Directory**: `process.env.HOME` is set to `/test-home` during tests.

3. **Automatic Cleanup**: `vol.reset()` runs after each test to ensure no cross-test pollution.

4. **Real Git Mocking**: Git operations are mocked via `vi.mock('simple-git')` with realistic return values.

---

## Test Categories

### Unit Tests (`tests/lib/`, `tests/commands/`)

Test individual functions and modules in isolation.

```bash
pnpm test:unit
```

**What they test**:
- Individual library functions (`manifest.ts`, `files.ts`, `git.ts`)
- Command handlers (`add.ts`, `sync.ts`, `init.ts`)
- Utility functions (`paths.ts`, `validation.ts`)

**Characteristics**:
- Fast execution (< 5ms per test)
- Mocked dependencies
- Pure function testing

### Integration Tests (`tests/integration/`)

Test complete workflows end-to-end.

```bash
pnpm test:integration
```

**What they test**:
- Full init → add → sync workflows
- Backup and restore cycles
- Multi-file operations
- Error recovery scenarios

**Characteristics**:
- Slower execution (may involve multiple operations)
- Test complete user workflows
- Verify component interactions

### Security Tests (`tests/security/`)

Test security-critical functionality.

```bash
pnpm test:security
```

**Categories**:
| File | What It Tests |
|------|---------------|
| `path-traversal.test.ts` | Directory escape prevention |
| `secret-redaction.test.ts` | Secret masking in output |
| `input-validation.test.ts` | User input sanitization |
| `redos.test.ts` | Regex DoS prevention |
| `permissions.test.ts` | File permission handling |

### Benchmark Tests (`tests/benchmarks/`)

Test performance characteristics. See [BENCHMARKING.md](./BENCHMARKING.md) for details.

```bash
pnpm bench
```

---

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';

// Import the function to test
import { myFunction } from '../../src/lib/mymodule.js';

describe('myFunction', () => {
  beforeEach(() => {
    vol.reset(); // Clean filesystem
  });

  afterEach(() => {
    vi.restoreAllMocks(); // Clean mocks
  });

  it('should handle basic input', async () => {
    // Arrange
    vol.fromJSON({
      '/test-home/.zshrc': 'export PATH="$PATH:/usr/local/bin"',
    });

    // Act
    const result = await myFunction('/test-home/.zshrc');

    // Assert
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('should throw on invalid input', async () => {
    await expect(myFunction(null)).rejects.toThrow('Invalid input');
  });
});
```

### Using Test Helpers

The `testHelpers.ts` module provides high-level utilities:

```typescript
import {
  initTestTuck,
  createTestDotfile,
  getTestManifest,
  testFileExists,
} from '../utils/testHelpers.js';

describe('My Feature', () => {
  beforeEach(async () => {
    // Set up complete tuck environment
    await initTestTuck();
  });

  it('should track a file', async () => {
    // Create a test dotfile
    await createTestDotfile('.zshrc', 'export PATH="$PATH"');

    // Your test logic here...

    // Verify manifest was updated
    const manifest = await getTestManifest();
    expect(Object.keys(manifest.files)).toHaveLength(1);

    // Verify file exists
    expect(await testFileExists('.zshrc')).toBe(true);
  });
});
```

### Using Factories

The `factories.ts` module provides mock object generators:

```typescript
import {
  createMockConfig,
  createMockManifest,
  createMockTrackedFile,
  COMMON_TEST_FILES,
} from '../utils/factories.js';

describe('Manifest Operations', () => {
  it('should handle large manifests', () => {
    const manifest = createMockManifest({
      files: {
        file1: createMockTrackedFile({ source: '~/.zshrc' }),
        file2: createMockTrackedFile({ source: '~/.bashrc' }),
        file3: createMockTrackedFile({ source: '~/.gitconfig' }),
      },
    });

    expect(Object.keys(manifest.files)).toHaveLength(3);
  });

  it('should use common test files', () => {
    // Pre-built test file definitions
    const zshrc = COMMON_TEST_FILES.zshrc;
    expect(zshrc.source).toBe('~/.zshrc');
    expect(zshrc.category).toBe('shell');
  });
});
```

### Testing Error Handling

```typescript
import { FileNotFoundError, PermissionError } from '../../src/errors.js';

it('should throw FileNotFoundError for missing files', async () => {
  await expect(readTestFile('nonexistent.txt')).rejects.toThrow(FileNotFoundError);
});

it('should include helpful error messages', async () => {
  try {
    await readTestFile('nonexistent.txt');
  } catch (error) {
    expect(error).toBeInstanceOf(FileNotFoundError);
    expect(error.message).toContain('nonexistent.txt');
    expect(error.suggestion).toBeDefined();
  }
});
```

### Testing Async Operations

```typescript
it('should handle concurrent operations', async () => {
  const operations = [
    createTestDotfile('.file1', 'content1'),
    createTestDotfile('.file2', 'content2'),
    createTestDotfile('.file3', 'content3'),
  ];

  await Promise.all(operations);

  expect(await testFileExists('.file1')).toBe(true);
  expect(await testFileExists('.file2')).toBe(true);
  expect(await testFileExists('.file3')).toBe(true);
});
```

---

## Test Utilities Reference

### Constants (`tests/setup.ts`)

```typescript
// Test environment paths
TEST_HOME = '/test-home'
TEST_TUCK_DIR = '/test-home/.tuck'
TEST_FILES_DIR = '/test-home/.tuck/files'

// Platform-specific versions (for Windows compatibility)
TEST_HOME_NATIVE = 'C:\\test-home' // or '/test-home' on Unix
```

### Test Helpers (`tests/utils/testHelpers.ts`)

```typescript
// Initialize complete tuck environment
await initTestTuck(options?: {
  config?: Partial<TuckConfig>;
  manifest?: Partial<TuckManifest>;
});

// Create test dotfiles
await createTestDotfile(name: string, content: string, options?: {
  nested?: boolean;
});

// Read files and JSON
const content = await readTestFile(path);
const data = await readTestJson(path);

// Check file existence
const exists = await testFileExists(path);

// Get current state
const manifest = await getTestManifest();
const config = await getTestConfig();

// Snapshot entire filesystem
const snapshot = getTestFilesystem();

// Reset environment
await resetTestEnv();
```

### Factories (`tests/utils/factories.ts`)

```typescript
// Create mock configuration
const config = createMockConfig({
  syncStrategy: 'symlink',
  autoCommit: false,
});

// Create mock manifest
const manifest = createMockManifest({
  machine: 'test-machine',
});

// Create mock tracked file
const file = createMockTrackedFile({
  source: '~/.vimrc',
  category: 'editors',
});

// Create manifest with multiple files
const manifest = createMockManifestWithFiles([
  { source: '~/.zshrc', category: 'shell' },
  { source: '~/.gitconfig', category: 'git' },
]);

// Pre-built common test files
COMMON_TEST_FILES.zshrc
COMMON_TEST_FILES.bashrc
COMMON_TEST_FILES.gitconfig
COMMON_TEST_FILES.vimrc
COMMON_TEST_FILES.tmux
```

---

## Security Testing

### Path Traversal Tests

Tests that verify tuck prevents directory escape attacks:

```typescript
describe('Path Traversal Prevention', () => {
  it('should reject paths with ../', async () => {
    await expect(
      validateSafeSourcePath('~/../../../etc/passwd')
    ).rejects.toThrow();
  });

  it('should reject null bytes', async () => {
    await expect(
      validateSafeSourcePath('~/.zshrc\0.txt')
    ).rejects.toThrow();
  });

  it('should normalize paths correctly', async () => {
    const result = await validateSafeSourcePath('~/.config/../.zshrc');
    expect(result).toBe(expandPath('~/.zshrc'));
  });
});
```

### Secret Redaction Tests

Tests that verify secrets are never exposed:

```typescript
describe('Secret Redaction', () => {
  it('should redact secrets in scan results', () => {
    const results = scanContent('AWS_KEY=AKIAIOSFODNN7EXAMPLE');

    for (const match of results) {
      expect(match.redactedValue).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(match.redactedValue).toContain('***');
    }
  });

  it('should redact secrets in error messages', () => {
    const error = new SecretsDetectedError(['AWS_KEY=AKIAIOSFODNN']);
    expect(error.message).not.toContain('AKIAIOSFODNN');
  });
});
```

### Input Validation Tests

Tests that verify user input is sanitized:

```typescript
describe('Input Validation', () => {
  it('should reject null and undefined', () => {
    expect(() => validatePath(null)).toThrow();
    expect(() => validatePath(undefined)).toThrow();
  });

  it('should reject control characters', () => {
    expect(() => validateFilename('file\x00name')).toThrow();
    expect(() => validateFilename('file\nname')).toThrow();
  });

  it('should reject path separators in filenames', () => {
    expect(() => validateFilename('dir/file')).toThrow();
    expect(() => validateFilename('dir\\file')).toThrow();
  });
});
```

---

## Type Safety Best Practices

### Use Zod for External Data

```typescript
import { z } from 'zod';

// Define schema
const userInputSchema = z.object({
  path: z.string().min(1),
  category: z.enum(['shell', 'git', 'editors', 'terminal', 'misc']),
});

// Validate input
const result = userInputSchema.safeParse(input);
if (!result.success) {
  throw new ValidationError(result.error.message);
}
const validatedInput = result.data; // Fully typed!
```

### Prefer `unknown` over `any`

```typescript
// ❌ Bad: any allows anything
function processData(data: any) {
  return data.value; // No type checking!
}

// ✅ Good: unknown requires narrowing
function processData(data: unknown) {
  if (typeof data === 'object' && data !== null && 'value' in data) {
    return (data as { value: string }).value;
  }
  throw new Error('Invalid data');
}
```

### Use Branded Types for Paths

```typescript
// Define branded type
type ExpandedPath = string & { __brand: 'ExpandedPath' };

// Function that requires expanded path
function readFile(path: ExpandedPath): Promise<string> {
  // Path is guaranteed to be expanded
}

// Expansion function returns branded type
function expandPath(path: string): ExpandedPath {
  const expanded = path.replace(/^~/, os.homedir());
  return expanded as ExpandedPath;
}
```

### Validate at Boundaries

```typescript
// Validate user input at the entry point
export async function addCommand(filepath: string): Promise<void> {
  // Validate immediately
  const validPath = validatePath(filepath);
  const safePath = await validateSafeSourcePath(validPath);

  // Now we can trust the path
  await trackFile(safePath);
}
```

---

## Common Pitfalls & Solutions

### Pitfall: Tests Sharing State

**Problem**: Tests fail randomly because they share filesystem state.

```typescript
// ❌ Bad: No cleanup between tests
describe('My Tests', () => {
  it('creates a file', () => {
    vol.fromJSON({ '/test-home/.zshrc': 'content' });
  });

  it('expects empty filesystem', () => {
    // FAILS! .zshrc still exists from previous test
    expect(vol.toJSON()).toEqual({});
  });
});
```

**Solution**: Reset filesystem in `beforeEach`.

```typescript
// ✅ Good: Clean state for each test
describe('My Tests', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('creates a file', () => {
    vol.fromJSON({ '/test-home/.zshrc': 'content' });
  });

  it('expects empty filesystem', () => {
    // PASSES! Filesystem was reset
    expect(vol.toJSON()).toEqual({});
  });
});
```

### Pitfall: Mocks Not Cleaned Up

**Problem**: Mocks from one test affect another.

```typescript
// ❌ Bad: Mock persists to next test
it('test one', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Test...
});

it('test two', () => {
  console.log('hello'); // Still mocked!
});
```

**Solution**: Restore mocks in `afterEach`.

```typescript
// ✅ Good: Mocks cleaned up
afterEach(() => {
  vi.restoreAllMocks();
});
```

### Pitfall: Testing Implementation Details

**Problem**: Tests break when refactoring even if behavior is unchanged.

```typescript
// ❌ Bad: Tests internal structure
it('should use Map internally', () => {
  const cache = new ManifestCache();
  expect(cache._internal.map).toBeInstanceOf(Map);
});
```

**Solution**: Test behavior, not implementation.

```typescript
// ✅ Good: Tests behavior
it('should cache loaded manifests', async () => {
  const first = await loadManifest(dir);
  const second = await loadManifest(dir);
  expect(first).toBe(second); // Same reference = cached
});
```

### Pitfall: Async Errors Not Caught

**Problem**: Async errors don't fail the test.

```typescript
// ❌ Bad: Promise rejection not caught
it('should throw on invalid input', () => {
  expect(asyncFunction(null)).rejects.toThrow(); // Missing await!
});
```

**Solution**: Always `await` async assertions.

```typescript
// ✅ Good: Properly awaited
it('should throw on invalid input', async () => {
  await expect(asyncFunction(null)).rejects.toThrow();
});
```

### Pitfall: Path Handling Across Platforms

**Problem**: Tests pass on Unix but fail on Windows.

```typescript
// ❌ Bad: Hardcoded Unix paths
expect(result.path).toBe('/test-home/.zshrc');
```

**Solution**: Use path utilities or test constants.

```typescript
// ✅ Good: Platform-aware
import { TEST_HOME_NATIVE } from '../setup.js';
import { join } from 'path';

expect(result.path).toBe(join(TEST_HOME_NATIVE, '.zshrc'));
```

---

## Test File Organization

```
tests/
├── setup.ts              # Global setup (mocks, constants)
├── utils/
│   ├── testHelpers.ts    # High-level test utilities
│   └── factories.ts      # Mock object factories
├── lib/                  # Unit tests for library modules
│   ├── manifest.test.ts
│   ├── files.test.ts
│   ├── git.test.ts
│   └── ...
├── commands/             # Command handler tests
│   ├── add.test.ts
│   ├── sync.test.ts
│   └── ...
├── integration/          # End-to-end workflow tests
│   ├── full-workflow.test.ts
│   └── backup-restore-cycle.test.ts
├── security/             # Security-focused tests
│   ├── path-traversal.test.ts
│   ├── secret-redaction.test.ts
│   └── ...
├── benchmarks/           # Performance benchmarks
│   ├── setup.ts          # Benchmark utilities
│   ├── scanner.bench.ts
│   └── ...
└── fixtures/             # Test data files
```

---

## Need Help?

- Check existing tests for patterns
- See [BENCHMARKING.md](./BENCHMARKING.md) for performance testing
- Open an issue for test infrastructure questions
