# JSON-Key-Scoped Tracking

Track a **subtree** of a JSON file instead of the whole file.

```bash
tuck add ~/.claude.json --key mcpServers
```

tuck extracts only the value at the given key path into your repo. On
`tuck apply` / `tuck restore` that subtree is **deep-merged** back into the live
file, leaving every other key — OAuth tokens, session caches, conversation
history, and any other machine-managed state — untouched.

## Why

Some config files are monoliths that mix durable, shareable configuration with
per-machine state. `~/.claude.json`, for example, holds MCP server definitions
(worth syncing across machines) right next to OAuth tokens, startup counters,
and conversation history (must **never** be committed or copied between
machines). Whole-file tracking or symlinking is impossible for these files —
you would either leak secrets or clobber machine state. JSON-key tracking lets
you sync just the part you care about.

The same applies to `settings.json`-style files and any other mixed
config/state JSON.

## How it works

| Stage | Behavior |
| --- | --- |
| `tuck add <file> --key <path>` | Extracts the subtree at `<path>` and stores **only that subtree** in the repo (canonical, key-sorted JSON). The manifest records `jsonKey`. |
| `tuck status` / `tuck verify` | Compares only the tracked subtree of the live file against the repo copy. Editing an untracked key (e.g. rotating a token) is **not** reported as drift. |
| `tuck sync` | Re-extracts **only** the subtree from the live file back into the repo. Keys outside the tracked path are never captured or committed. |
| `tuck apply` / `tuck restore` | Deep-merges the repo subtree back into the live file at `<path>`, preserving every other key. |

### Deep-merge semantics

- **Objects** are merged recursively and key-wise: sibling keys inside the
  subtree that exist in the live file but not the repo copy are preserved.
- **Arrays** and **scalars** replace the value at the exact tracked path (they
  are opaque — element identity is undefined for config arrays).
- Only the value at the tracked path is ever touched. Everything else in the
  file is preserved.

### Key paths

Key paths are dot-delimited and address object properties:

```bash
tuck add ~/.config/app/config.json --key editor.settings
```

The leaf value may be any JSON type (object, array, or scalar); intermediate
nodes must be objects. Array indices are not addressable in this version.

## Secrets

The subtree — not the whole file — is scanned for secrets at `tuck add` time.
This is deliberate: a token that lives **outside** the tracked key can never
reach the repo, so it should not block tracking the safe subtree. Placeholders
inside the tracked subtree are resolved from your configured secret backend on
apply/restore, exactly like whole-file entries.

## Constraints

- The file must be **strict JSON** with a top-level object. Files with comments
  or trailing commas (JSONC) are rejected rather than silently corrupted.
- `--key` cannot be combined with `--symlink`, `--encrypt`, `--template`, or
  `--repo` (the repo copy must stay a plain, mergeable JSON subtree).
- The live file is rewritten as 2-space-indented JSON on apply/restore. Key
  **values** are preserved exactly; only whitespace formatting is normalized.

## Example

```bash
# Track just the MCP server config from Claude Code's monolithic config.
tuck add ~/.claude.json --key mcpServers
tuck sync

# On another machine, after cloning your dotfiles:
tuck apply <you>        # merges mcpServers in; your local token stays put
```
