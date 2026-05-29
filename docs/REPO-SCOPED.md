# Repo-scoped tracking

tuck started as a `$HOME` dotfiles manager. Repo-scoped tracking generalizes it
to **any config file, anywhere** — including files that live *inside* a git
repository (a project's `.vscode/settings.json`, a `CLAUDE.md`, a
`.cursorrules`, an `.aider.conf.yml`). You track them once, sync them in your
tuck repo, and materialize them on another machine **even when that repo lives
at a different absolute path there**.

## The model

A repo-scoped file is identified by a **stable, machine-independent key**, not
an absolute path:

- `repoKey` — derived from the repo's canonical remote URL (so `git@github…`
  and `https://github…` for the same repo produce the *same* key on every
  machine), falling back to the first-commit hash, then a random suffix. Set it
  explicitly with `--repo-key <label>`.
- `repoRelative` — the file's path relative to the repo root
  (e.g. `.vscode/settings.json`).

The committed manifest stores **only** `(repoKey, repoRelative)` — never an
absolute path. Each machine keeps its own **machine-local registry**
(`repos.json` under the state dir, e.g. `~/Library/Application Support/tuck/`,
never committed) mapping `repoKey → absolute repo root`. So the same shared
manifest resolves to `/Users/you/work/app` on one machine and
`/home/you/projects/app` on another.

## Track a file in a repo

```sh
# auto-detect the enclosing git repo and track a file inside it
tuck add ./.vscode/settings.json --repo

# or point at the repo explicitly / pin the key
tuck add ~/work/app/CLAUDE.md --repo ~/work/app --repo-key app
```

This records a `scope: "repo"` entry, copies the file into
`~/.tuck/files/repos/<repoKey>/…`, and binds `repoKey → repo root` on this
machine. (Repo scope is copy-only — tuck won't symlink a working-tree file.)

## Use it on another machine

After cloning your tuck repo onto a new machine, repo-scoped files show up as
**`unknown-repo`** in `tuck verify` until you tell tuck where that repo lives:

```sh
tuck repo list                         # see bindings / which repos are known
tuck repo link app ~/projects/app      # bind repoKey -> this machine's path
tuck restore                           # now materializes the repo-scoped files
tuck verify --exit-code                # 0 when everything is in sync
```

`tuck restore --repo-root <dir>` binds-and-restores in one step. An unbound
repo file is always **skipped** (and listed in `--json` output) — tuck never
guesses a path.

```
tuck repo link <key> <path>    bind a repoKey to its root on this machine
tuck repo list                 list all bindings (--json supported)
tuck repo unlink <key>         remove a binding
```

## Composes with the sandbox

Repo-scoped writes honor `--root`/`TUCK_TARGET_ROOT` (see
[SANDBOXING.md](./SANDBOXING.md)): under a sandbox root, a repo file is
re-based to `<root>/repos/<repoKey>/<repoRelative>` by **stable identity** — the
real (possibly out-of-home) repo path is never used to place the file, so a
repo outside `$HOME` can never let a write escape the sandbox. An agent can
`tuck apply user/dotfiles --root /tmp/fakehome --yes` and preview repo-scoped
files safely.

## Safety

- The home-confinement guard for ordinary dotfiles is unchanged; repo files are
  confined to their bound repo root instead (no `..` escape, no absolute paths).
- The machine-local `repos.json` lives outside the tuck repo and is never
  committed, so absolute machine paths never leak into shared dotfiles.
