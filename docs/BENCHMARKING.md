# Benchmarking Guide

This guide covers tuck's performance benchmarking infrastructure, how to run benchmarks, interpret results, and contribute performance improvements.

---

## Table of Contents

- [Why Performance Matters](#why-performance-matters)
- [Quick Start](#quick-start)
- [Performance Targets](#performance-targets)
- [Understanding Benchmark Output](#understanding-benchmark-output)
- [Known Bottlenecks & Optimization Opportunities](#known-bottlenecks--optimization-opportunities)
- [Writing New Benchmarks](#writing-new-benchmarks)
- [Benchmark Utilities Reference](#benchmark-utilities-reference)
- [Best Practices](#best-practices)

---

## Why Performance Matters

tuck is a CLI tool that users interact with frequently. Every command should feel instant:

- **`tuck status`** should complete in under 100ms
- **`tuck sync`** should handle 100+ files without noticeable delay
- **`tuck add`** should never block on checksum calculation

Slow CLI tools frustrate users and get abandoned. Our benchmarking suite ensures we catch performance regressions before they reach users.

---

## Quick Start

### Running All Benchmarks

```bash
pnpm bench
```

This runs all benchmark files in `tests/benchmarks/` and outputs results to the terminal and `benchmark-results.json`.

### Running Specific Benchmarks

```bash
# Run only scanner benchmarks
pnpm vitest bench --config vitest.bench.config.ts tests/benchmarks/scanner.bench.ts --run

# Run only manifest benchmarks
pnpm vitest bench --config vitest.bench.config.ts tests/benchmarks/manifest.bench.ts --run
```

### Watch Mode (for development)

```bash
pnpm bench:watch
```

---

## Performance Targets

These are the documented performance targets for critical operations:

| Module | Operation | Target | Current |
|--------|-----------|--------|---------|
| **Detect** | Full dotfile scan | < 500ms | ~6ms |
| **Detect** | Per-file categorization | < 1ms | ~0.002ms |
| **Checksum** | 1MB file | < 50ms | ~1ms |
| **Checksum** | 10MB file | < 200ms | ~9ms |
| **Checksum** | 100MB file | < 500ms | ~79ms |
| **Scanner** | 10KB file | < 50ms | ~0.6ms |
| **Scanner** | 100KB file | < 200ms | ~4ms |
| **Scanner** | ReDoS patterns | < 5s | ~0.02ms |
| **Manifest** | Load 100 files (cold) | < 10ms | ~2.9ms |
| **Manifest** | Load 1000 files (cold) | < 50ms | ~7.6ms |
| **Manifest** | Save manifest | < 20ms | ~4.2ms |
| **Git** | Status check | < 50ms | ~10ms |

---

## Understanding Benchmark Output

When you run `pnpm bench`, you'll see output like this:

```
 ✓ tests/benchmarks/scanner.bench.ts > Secret Scanner Benchmarks > scanContent 4305ms
     name                                             hz     min      max    mean     p75     p99
   · scan small content (100 lines) - clean    16,400.57  0.0436   3.3034  0.0610  0.0484  0.2914
   · scan medium content (1000 lines) - clean   2,087.74  0.2942  17.0214  0.4790  0.3385  4.3817
   · scan large content (10000 lines) - clean     238.87  2.8155  19.9420  4.1863  4.2469  17.8211

 BENCH  Summary

  scan small content (100 lines) - clean
    6.84x faster than scan medium content (1000 lines) - clean
    68.66x faster than scan large content (10000 lines) - clean
```

### Reading the Metrics

| Column | Meaning |
|--------|---------|
| `hz` | Operations per second (higher = faster) |
| `min` | Fastest execution time (ms) |
| `max` | Slowest execution time (ms) |
| `mean` | Average execution time (ms) |
| `p75` | 75th percentile (ms) |
| `p99` | 99th percentile (ms) |
| `rme` | Relative margin of error (%) |
| `samples` | Number of iterations run |

### What to Look For

- **High `rme`** (> 10%): Results are inconsistent, may need more samples
- **Large `max` vs `mean`**: Occasional slow runs, possible GC pauses
- **0 samples**: Benchmark failed silently (check for errors)
- **Comparison ratios**: The summary shows relative performance between benchmarks

---

## Known Bottlenecks & Optimization Opportunities

### 1. Cold Manifest Loads (Priority: HIGH)

**Current Performance**: ~7.6ms for 1000 files
**Location**: `src/lib/manifest.ts` - `loadManifest()`
**Cause**: Zod validation overhead on every cold load

**Why It Matters**: Every tuck command starts with loading the manifest. Users with many tracked files feel this delay.

**Optimization Approaches**:
```typescript
// Current: Full validation every time
const manifest = tuckManifestSchema.parse(JSON.parse(content));

// Option 1: Use safeParse with error handling
const result = tuckManifestSchema.safeParse(JSON.parse(content));
if (!result.success) throw new ManifestError(result.error);

// Option 2: Lazy validation (validate on access)
// Only validate files when accessed, not on load

// Option 3: Schema caching
// Pre-compile the Zod schema once at module load
```

**Impact**: Cache already provides 17,000x improvement. Further cold-load optimization would help first-run experience.

---

### 2. Git Process Spawning (Priority: MEDIUM)

**Current Performance**: ~10ms per git command
**Location**: `src/lib/git.ts`
**Cause**: Each git operation spawns a new process via simple-git

**Why It Matters**: `tuck sync` calls multiple git commands (status, add, commit). Process spawn overhead dominates.

**Optimization Approaches**:
```typescript
// Current: Multiple separate calls
await getStatus(dir);
await stageFiles(dir, files);
await commit(dir, message);

// Option 1: Batch operations where possible
// Use git's batch capabilities

// Option 2: Use lighter git commands
// git status --porcelain is faster than full status

// Option 3: Skip unnecessary checks
// If we just staged files, we know status changed
```

**Impact**: Could reduce typical sync from ~30ms to ~15ms.

---

### 3. Large Content Scanning (Priority: MEDIUM)

**Current Performance**: 10K lines in ~4ms (linear scaling)
**Location**: `src/lib/secrets/scanner.ts`
**Cause**: 60+ regex patterns checked against every line

**Why It Matters**: Large dotfiles (shell history, complex configs) slow down `tuck add`.

**Optimization Approaches**:
```typescript
// Current: All patterns on all files
scanContent(content, { patterns: ALL_SECRET_PATTERNS });

// Option 1: Category-specific patterns
// Only scan .aws files with AWS patterns
const patterns = getPatternsByFileType(filepath);
scanContent(content, { patterns });

// Option 2: Early exit on definite match
// Stop scanning after finding high-confidence secret

// Option 3: Pre-filter with fast regex
// Quick check before running expensive patterns
```

**Impact**: Cloud-only patterns are 10x faster than full scan.

---

### 4. Wide Directory Operations (Priority: LOW)

**Current Performance**: ~112ms for 500+ file copy
**Location**: `src/lib/files.ts` - `copyFileOrDir()`
**Cause**: Sequential file operations

**Optimization Approaches**:
```typescript
// Current: Sequential
for (const file of files) {
  await copyFile(file.src, file.dest);
}

// Option: Parallel with concurrency limit
import pLimit from 'p-limit';
const limit = pLimit(10); // 10 concurrent operations
await Promise.all(files.map(f => limit(() => copyFile(f.src, f.dest))));
```

**Impact**: 3x improvement seen in parallel checksum tests.

---

### 5. Large File Checksums (Priority: LOW)

**Current Performance**: 100MB in ~79ms (~1.27 GB/s)
**Location**: `src/lib/files.ts` - `getFileChecksum()`
**Cause**: Full file read into memory before hashing

**Optimization Approaches**:
```typescript
// Current: Read entire file
const content = await readFile(filepath);
return createHash('sha256').update(content).digest('hex');

// Option: Stream-based hashing for large files
if (fileSize > 10 * 1024 * 1024) { // > 10MB
  const hash = createHash('sha256');
  const stream = createReadStream(filepath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
```

**Impact**: Memory reduction for large files, slight speed improvement.

---

### What's Already Optimized

These areas are already well-optimized:

- **Manifest caching**: 17,000x faster with cache (implemented in `clearManifestCache()`)
- **Category detection**: 641K ops/sec - regex matching is very fast
- **Parallel checksums**: `Promise.all()` already supported

---

## Writing New Benchmarks

### Critical: Vitest Bench Limitation

> **WARNING**: Vitest bench has issues with variable sharing between `beforeAll()` and `bench()` functions due to thread isolation.
>
> All test fixtures **MUST** be created at module level (synchronously) or within each `bench()` call. **DO NOT** rely on `beforeAll` to set up variables that `bench()` will use.

### Correct Pattern

```typescript
import { describe, bench } from 'vitest';
import { createTempDir, generateDotfileContent } from './setup.js';

// ✅ CORRECT: Create fixtures at module level
const tempDir = createTempDir('my-bench-');
const testContent = generateDotfileContent(100);

describe('My Benchmarks', () => {
  // ✅ CORRECT: Use module-level variables
  bench('my operation', async () => {
    await myFunction(testContent);
  });
});
```

### Incorrect Pattern

```typescript
describe('My Benchmarks', () => {
  let tempDir: string;
  let testContent: string;

  // ❌ WRONG: Variables won't be shared with bench()
  beforeAll(() => {
    tempDir = createTempDir('my-bench-');
    testContent = generateDotfileContent(100);
  });

  bench('my operation', async () => {
    // tempDir and testContent will be undefined!
    await myFunction(testContent);
  });
});
```

### Benchmark File Template

```typescript
/**
 * [Module Name] benchmarks for tuck.
 *
 * Performance concerns:
 * - [List key concerns]
 *
 * Target performance:
 * - [Operation]: < [time]ms
 */

import { describe, bench, expect } from 'vitest';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { createTempDir, generateDotfileContent } from './setup.js';

// Import functions to benchmark
import { myFunction } from '../../src/lib/mymodule.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('mymodule-bench-');
const smallContent = generateDotfileContent(100);
const largeContent = generateDotfileContent(10000);

// ============================================================================
// Benchmarks
// ============================================================================

describe('My Module Benchmarks', () => {
  describe('myFunction', () => {
    bench('small input', () => {
      myFunction(smallContent);
    });

    bench('large input', () => {
      myFunction(largeContent);
    });
  });

  describe('Performance Requirements', () => {
    bench('should complete under 100ms', () => {
      const start = performance.now();
      myFunction(largeContent);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(100);
    });
  });
});
```

---

## Benchmark Utilities Reference

The `tests/benchmarks/setup.ts` file provides utilities for creating test fixtures:

### File Generation

```typescript
// Generate random binary file
generateRandomFile(path: string, sizeBytes: number): void

// Generate realistic dotfile content
generateDotfileContent(lines: number): string

// Generate file with embedded secrets (for scanner tests)
generateFileWithSecrets(path: string, secretCount: number): void

// Generate directory structure
generateDirectoryStructure(basePath: string, options?: {
  depth?: number;        // Default: 3
  filesPerDir?: number;  // Default: 5
  dirsPerLevel?: number; // Default: 3
  fileSize?: number;     // Default: 1024
}): { totalFiles: number; totalDirs: number; totalBytes: number }

// Generate mock manifest
generateLargeManifest(fileCount: number): object
```

### Measurement Utilities

```typescript
// Measure async function with warmup
const { result, metrics } = await measureAsync(
  'operation name',
  async () => myAsyncFunction(),
  { iterations: 100, warmup: 10 }
);

// Measure sync function
const { result, metrics } = measureSync(
  'operation name',
  () => mySyncFunction(),
  { iterations: 100, warmup: 10 }
);

// Assert performance requirements
assertPerformance(metrics, 50); // Must complete in < 50ms
assertThroughput(metrics, 1000); // Must achieve > 1000 ops/sec
```

### Cleanup Utilities

```typescript
// Create temp directory (auto-cleaned after tests)
const dir = createTempDir('prefix-');

// Create fixture with helper methods
const fixture = createBenchmarkFixture('mytest');
fixture.createFile('test.txt', 'content');
fixture.createDir('subdir');

// Manual cleanup
cleanupDir(path);
```

---

## Best Practices

### Before Submitting PRs

1. **Run benchmarks before and after changes**:
   ```bash
   pnpm bench > before.txt
   # Make changes
   pnpm bench > after.txt
   diff before.txt after.txt
   ```

2. **Watch for regressions**: If any benchmark is > 20% slower, investigate before merging.

3. **Add benchmarks for new features**: Any new module that handles files, git, or manifests should have benchmarks.

### Writing Good Benchmarks

1. **Test realistic inputs**: Use `generateDotfileContent()` for realistic file content.

2. **Test multiple sizes**: Always benchmark small, medium, and large inputs.

3. **Include assertions**: Use `expect(duration).toBeLessThan(X)` for critical paths.

4. **Document targets**: Add JSDoc comments explaining performance requirements.

### Interpreting Results

1. **Run multiple times**: Benchmark results vary. Run 3+ times and look for consistency.

2. **Watch for outliers**: High `max` values often indicate GC pauses or cold-start effects.

3. **Consider p99**: The 99th percentile matters more than mean for user experience.

4. **Compare ratios**: The "X faster than Y" comparisons are more stable than absolute numbers.

---

## CI/CD Integration

Benchmark results are saved to `benchmark-results.json`. In CI, you can:

1. **Archive results**: Save `benchmark-results.json` as a build artifact.

2. **Compare against baseline**: Parse JSON and compare against known-good values.

3. **Fail on regression**: Set thresholds and fail the build if exceeded.

Example CI check:
```bash
# Run benchmarks and check critical paths
pnpm bench
node -e "
  const results = require('./benchmark-results.json');
  const manifest = results.find(r => r.name.includes('manifest'));
  if (manifest && manifest.mean > 10) {
    console.error('Manifest load too slow:', manifest.mean, 'ms');
    process.exit(1);
  }
"
```

---

## Benchmark Files Overview

| File | Purpose | Key Metrics |
|------|---------|-------------|
| `scanner.bench.ts` | Secret detection | Pattern matching speed, ReDoS resistance |
| `manifest.bench.ts` | Manifest load/save | Cold vs cached load, query performance |
| `git.bench.ts` | Git operations | Command latency, repo size scaling |
| `files.bench.ts` | File operations | Copy, traverse, delete performance |
| `checksum.bench.ts` | File hashing | Throughput, parallel vs sequential |
| `detect.bench.ts` | Dotfile detection | Scan speed, category classification |

---

## Need Help?

- Check existing benchmark files for patterns
- Open an issue if you find a performance regression
- See [TESTING.md](./TESTING.md) for the full testing guide
