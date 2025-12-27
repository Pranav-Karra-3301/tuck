---
description: Commands to run the tuck CLI
---

# Run

Run the built CLI (no arguments).

```bash
node dist/index.js
```

# Help

Show CLI help.

```bash
node dist/index.js --help
```

# Version

Show CLI version.

```bash
node dist/index.js --version
```

# Status

Run tuck status command.

```bash
node dist/index.js status
```

# Status JSON

Run status with JSON output.

```bash
node dist/index.js status --json
```

# List

List all tracked files.

```bash
node dist/index.js list
```

# Diff

Show differences between system and repository.

```bash
node dist/index.js diff
```

# Config

Show current configuration.

```bash
node dist/index.js config list
```

# Scan

Scan for dotfiles on the system.

```bash
node dist/index.js scan
```

# Apply

Apply dotfiles from a repository.

```bash
node dist/index.js apply <repo>
```

# Undo

Undo/restore from snapshots.

```bash
node dist/index.js undo --list
node dist/index.js undo --latest
```
