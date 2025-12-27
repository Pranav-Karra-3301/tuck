---
description: Steps to add a new feature
---

# Add New Command

Steps to add a new CLI command:

## 1. Create Command File

Create `src/commands/mycommand.ts`:

```typescript
import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError } from '../errors.js';

export const myCommand = new Command('mycommand')
  .description('What this command does')
  .option('-o, --option <value>', 'Option description')
  .action(async (options) => {
    const tuckDir = getTuckDir();

    try {
      await loadManifest(tuckDir);
    } catch {
      throw new NotInitializedError();
    }

    prompts.intro('tuck mycommand');
    // Implementation
    prompts.outro('Done!');
  });
```

## 2. Export from Index

Add to `src/commands/index.ts`:

```typescript
export { myCommand } from './mycommand.js';
```

## 3. Register Command

Add to `src/index.ts`:

```typescript
import { myCommand } from './commands/index.js';

program.addCommand(myCommand);
```

## 4. Add Tests

Create `tests/commands/mycommand.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('mycommand', () => {
  it('should do expected behavior', () => {
    // Test implementation
  });
});
```

## 5. Verify

```bash
pnpm build && node dist/index.js mycommand --help
```

# Add New Library Module

Steps to add a new library module:

## 1. Create Module

Create `src/lib/mymodule.ts`

## 2. Export from Index

Add to `src/lib/index.ts`:

```typescript
export * from './mymodule.js';
```

## 3. Add Tests

Create `tests/lib/mymodule.test.ts`

## 4. Run Tests

```bash
pnpm test tests/lib/mymodule.test.ts
```
