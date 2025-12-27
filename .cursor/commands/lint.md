---
description: Linting and formatting commands
---

# Lint

Run ESLint to check for issues.

```bash
pnpm lint
```

# Lint Fix

Automatically fix linting issues.

```bash
pnpm lint:fix
```

# Type Check

Run TypeScript type checking without building.

```bash
pnpm typecheck
```

# Format

Format code with Prettier.

```bash
pnpm format
```

# Check All

Run all code quality checks.

```bash
pnpm lint && pnpm typecheck && pnpm test
```

# Pre-commit Check

Full verification before committing.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
