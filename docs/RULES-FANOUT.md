# Rules Fan-Out — one canonical file, many tool variants

`tuck rules` keeps a single canonical rules/instructions file (e.g. `AGENTS.md`)
as the source of truth and fans it out on demand into every tool-specific file
your AI agents look for:

| Tool key      | Destination                          |
| ------------- | ------------------------------------ |
| `claude`      | `CLAUDE.md`                          |
| `cursor`      | `.cursorrules`                       |
| `cursor-dir`  | `.cursor/rules/tuck.mdc`             |
| `windsurf`    | `.windsurfrules`                     |
| `copilot`     | `.github/copilot-instructions.md`    |
| `gemini`      | `GEMINI.md`                          |
| `agents`      | `AGENTS.md`                          |

No more copying the same paragraph into five files and losing track of which one
is canonical. tuck's repo-scoped tracking plus its template engine mean the whole
set stays in lockstep — globally (`$HOME`) or per repo — with per-tool overrides.

## Why

> Teams "copy the same paragraph into five files, forget which one is canonical,
> and six weeks later the agents are following conflicting orders."

tuck owns the canonical file and regenerates the rest, so drift is visible
(`tuck rules list`) and one command (`tuck rules apply`) reconciles it.

## Quick start

```bash
# Track a canonical rules file. Scope is auto-detected: inside a git repo →
# repo-scoped (variants land in the repo root); otherwise → home-scoped
# (variants land in $HOME). With no --tool, every applicable tool is selected.
tuck rules track ~/AGENTS.md

# See what's tracked and how each variant currently compares on disk.
tuck rules list

# Materialize (or symlink) each variant from the canonical source.
tuck rules apply
```

## Per-tool overrides via templating

The canonical file is rendered through tuck's template engine on `apply`, with a
`tool` variable bound to the target. Use it to include tool-specific sections
while keeping one source:

```md
# Team Rules

Always write tests before implementation.

{{#if tool == "cursor"}}
When editing, prefer `.cursor/rules` glob scoping.
{{/if}}

{{#if tool == "claude"}}
Follow the conventions in this repo's CLAUDE.md exactly.
{{/if}}
```

`CLAUDE.md` keeps only the `claude` block, `.cursorrules` keeps only the `cursor`
block, and so on. The same `{{var}}`, `{{var | default "x"}}`, `os`/`arch`/env
context and `# tuck:if` comment markers documented in
[TEMPLATES-AND-ENCRYPTION.md](./TEMPLATES-AND-ENCRYPTION.md) are available; pass
extra variables with `--var key=value`. Disable rendering entirely with
`--no-template` (the source is copied verbatim to every variant).

## Commands

### `tuck rules track <path>`

Designate a canonical rules file and its fan-out targets. Records the set in
`~/.tuck/rules.json`; writes **no** tool variants (that's `apply`).

| Flag                    | Meaning                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `-t, --tool <name...>`  | Fan-out targets (space- or comma-separated). Default: all applicable tools. |
| `--symlink`             | Symlink each variant at the source instead of materializing.  |
| `--no-template`         | Copy the source verbatim; do not render templates on apply.   |
| `--var <key=value...>`  | Extra template variables.                                     |
| `--json`                | Emit a JSON envelope.                                          |

The tool whose default destination *is* the canonical source is skipped
automatically (tracking `AGENTS.md` won't fan `agents` → `AGENTS.md` onto
itself). Re-running `track` on the same source updates its tool list in place.

### `tuck rules list`

Show every tracked set and, per tool, its status: `missing`, `in-sync`, `drift`
(materialized content differs from the current render), or `foreign` (a real file
where a symlink is expected, or vice-versa). `--json` for machine output.

### `tuck rules apply`

Materialize or symlink each variant from its canonical source.

| Flag          | Meaning                                                              |
| ------------- | ------------------------------------------------------------------- |
| `--id <id>`   | Only apply the set with this id (see `tuck rules list`).             |
| `--dry-run`   | Show what would change without writing.                             |
| `-f, --force` | Overwrite differing variants without confirmation.                  |
| `-y, --yes`   | Run non-interactively (undecided overwrites are skipped, not forced).|
| `--json`      | Emit a JSON envelope.                                               |

Safety:

- **Snapshot first.** Any existing variant that would change is captured in a
  Time Machine snapshot before it is touched (`tuck undo --latest` restores it).
- **Never clobber silently.** A variant that already matches is left untouched.
  A variant that differs is only overwritten with an interactive "yes" or
  `--force`; otherwise it is reported as `skipped (differs (declined))`.
- **Sandbox-aware.** All writes route through tuck's write context, so
  `tuck --root <dir> rules apply` confines every variant under `<dir>`.

`materialize` (the default) writes a real file and supports per-tool templating.
`symlink` links the variant at the canonical source: always byte-identical, so
per-tool overrides do **not** apply — pick it when every tool should read the
exact same bytes.

### `tuck rules untrack <id>`

Stop tracking a set. Add `--clean` to also delete the generated variants from
disk (confirmed unless `--yes`).

## Data model

`~/.tuck/rules.json` (validated by a zod schema on every load):

```json
{
  "version": "1",
  "sets": {
    "home__agents.md": {
      "source": "~/AGENTS.md",
      "scope": "home",
      "template": true,
      "tools": [
        { "tool": "claude", "strategy": "materialize" },
        { "tool": "cursor", "strategy": "materialize" }
      ],
      "variables": {},
      "added": "2026-07-09T00:00:00.000Z",
      "modified": "2026-07-09T00:00:00.000Z"
    }
  }
}
```

Repo-scoped sets additionally store the absolute `repoRoot` and identify the set
by a machine-independent key, so the same manifest works across machines.

## Notes & limitations

- `tuck rules apply` is its own explicit step. Wiring rule fan-out into the
  top-level `tuck apply` flow is a planned follow-up.
- A tool's destination can be overridden per set with a `path` field in
  `rules.json` (relative, non-escaping); a CLI flag for this is a follow-up.
