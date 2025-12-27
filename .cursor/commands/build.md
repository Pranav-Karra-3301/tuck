---
description: Build commands for tuck
---

# Build

Build the project for production.

```bash
pnpm build
```

This compiles TypeScript and bundles with tsup, outputting to `dist/`.

# Dev

Start development build in watch mode.

```bash
pnpm dev
```

Watches for changes and rebuilds automatically.

# Clean Build

Remove build artifacts and rebuild.

```bash
rm -rf dist && pnpm build
```

# Verify Build

Build and verify the CLI works.

```bash
pnpm build && node dist/index.js --version && node dist/index.js --help
```
