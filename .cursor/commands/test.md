---
description: Test commands for tuck
---

# Test

Run the full test suite.

```bash
pnpm test
```

# Test Watch

Run tests in watch mode (re-run on changes).

```bash
pnpm test:watch
```

# Test Coverage

Run tests with coverage report.

```bash
pnpm test:coverage
```

Coverage report will be in `coverage/` directory.

# Test Single File

Run tests for a specific file.

```bash
pnpm test tests/lib/paths.test.ts
```

# Test Pattern

Run tests matching a pattern.

```bash
pnpm test --grep "should handle"
```
