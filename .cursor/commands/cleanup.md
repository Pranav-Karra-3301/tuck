---
description: Cleanup and maintenance commands
---

# Clean Dist

Remove build artifacts.

```bash
rm -rf dist
```

# Clean Coverage

Remove coverage reports.

```bash
rm -rf coverage
```

# Clean All

Remove all generated files.

```bash
rm -rf dist coverage
```

# Clean Install

Remove node_modules and reinstall.

```bash
rm -rf node_modules pnpm-lock.yaml && pnpm install
```

# Prune Deps

Remove unused dependencies.

```bash
pnpm prune
```

# Update Deps

Update all dependencies interactively.

```bash
pnpm update --interactive
```

# Check Outdated

Check for outdated dependencies.

```bash
pnpm outdated
```

# Security Audit

Run security audit on dependencies.

```bash
pnpm audit
```
