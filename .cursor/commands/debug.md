---
description: Debugging commands
---

# Debug Mode

Run with debug output enabled.

```bash
DEBUG=1 node dist/index.js status
```

# Verbose

Run with verbose logging.

```bash
node dist/index.js status --verbose
```

# Debug Build

Build with source maps for debugging.

```bash
pnpm build --sourcemap
```

# Node Inspect

Run with Node.js debugger.

```bash
node --inspect dist/index.js status
```

# Type Errors Only

Check types without other build steps.

```bash
pnpm typecheck
```

# Lint Only

Check for lint issues without fixing.

```bash
pnpm lint
```
