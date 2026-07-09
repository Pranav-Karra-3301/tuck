# Structured JSON Smart Merge

tuck can reconcile high-churn, tool-rewritten JSON config files **key-by-key**
instead of overwriting them wholesale. This is what makes syncing agent configs
(Claude Code `settings.json`, `.mcp.json`, …) across machines safe: two machines
can each mutate the same config and `tuck sync` unions their changes rather than
silently keeping whichever synced last.

## The problem it solves

Agent tools constantly rewrite their own configuration — Claude Code appends
permission entries, MCP servers get added, plugin lists grow. With a naive
push/pull, this happens:

1. Machine **A** adds a permission and syncs → the repo has A's version.
2. Machine **B**'s agent independently added a different permission locally.
3. Machine **B** runs `tuck sync`. It pulls A's version, then captures B's live
   file back into the repo — **silently discarding A's permission**.

A three-way merge, using the last-synced version as the common ancestor,
recovers **both** sides' additions and only stops for a genuine conflict (the
same key set to two different values).

## How it works

During `tuck sync`, when a merge-policy file was **modified locally** and the
pull brought a **new version of the same file**, tuck performs a three-way
merge:

- **base** — the repo copy captured immediately before the pull (the state this
  machine last synced from).
- **ours** — your current live file.
- **theirs** — the repo copy after the pull (the incoming version).

The merged result is written to **both** the live file and the repo copy, so the
two machines converge. A Time Machine snapshot of the live file is taken first,
so `tuck undo` can always recover the pre-merge version.

If a side is not valid JSON, tuck cannot smart-merge it and falls back to keeping
your local version (with a warning) — never a silent data loss.

## What gets a policy automatically

These filenames are treated as structured-merge files out of the box (safe
`union` arrays, `manual` conflict handling):

- `settings.json`, `settings.local.json` (Claude Code / editor settings)
- `.mcp.json`, `mcp.json` (Model Context Protocol servers)
- `.claude.json`

Everything else uses plain copy semantics unless you opt in.

## `tuck merge` — manage policies

```bash
# Show every file with an effective merge policy (auto or explicit)
tuck merge list

# Show one file's effective policy
tuck merge show ~/.claude/settings.json

# Opt a file into structured merge (defaults: json, arrays=union, conflict=manual)
tuck merge set ~/.config/app/config.json

# Tune the strategies
tuck merge set ~/.config/app/config.json --arrays concat --conflict theirs

# Remove an explicit policy (reverts to auto-detected default, or none)
tuck merge unset ~/.config/app/config.json
```

All subcommands accept `--json` for machine-readable output.

### Array strategies (`--arrays`)

| Value     | Behavior                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `union`   | Combine both sides, dropping deep-duplicate entries (default). Ideal for allowlists. |
| `concat`  | Append both sides verbatim, keeping duplicates.                          |
| `replace` | Treat a diverged array as a scalar conflict (resolved via `--conflict`). |

> Note: `union` combines both sides and does not attempt to honor a deletion
> made on only one side — a removed allowlist entry that the other machine still
> has will be re-added. This is the safe default for permission/plugin lists.

### Conflict resolution (`--conflict`)

Applies when both sides changed the **same scalar leaf** to different values (or
when an array is under `replace`):

| Value    | Behavior                                                          |
| -------- | ----------------------------------------------------------------- |
| `ours`   | Always keep the local value.                                      |
| `theirs` | Always take the incoming value.                                   |
| `manual` | Surface the conflict and stop instead of guessing (default).      |

With `manual`, an interactive `tuck sync` prompts you to keep local, take
incoming, or abort. A non-interactive sync (`--json` / `--yes`) exits with code
`3` and a `JSON_MERGE_CONFLICTS` error listing the conflicting JSON paths, so
automation can detect and report it.

## Example

`~/.claude/settings.json` on two machines, both starting from
`{ "permissions": { "allow": ["Read"] } }`:

- Machine A adds `WebFetch` → syncs.
- Machine B's agent adds `Bash(git:*)` locally, then runs `tuck sync`.

Result on both machines after B syncs:

```json
{
  "permissions": {
    "allow": ["Read", "Bash(git:*)", "WebFetch"]
  }
}
```

No data lost, no manual intervention.
