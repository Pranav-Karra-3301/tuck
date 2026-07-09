# Profiles / Tags

Profiles let one dotfiles repo serve machines with different needs — work vs
personal, a headless server, an ephemeral agent sandbox — by selecting a
**subset** of tracked files instead of applying everything.

## Model

- Every tracked file carries a `tags` list naming the profiles it belongs to.
- A file with **no tags is universal**: it applies under *every* profile (your
  shared/common set).
- A file with tags applies **only** under a matching profile.
- `tuck apply --profile <name>` materializes **universal + `<name>`-tagged**
  files, and nothing else.

Two kinds of state:

| State | Where it lives | Committed? |
| ----- | -------------- | ---------- |
| Profile registry + per-file tags | shared manifest (`~/.tuck/.tuckmanifest.json`) | yes — portable across machines |
| This machine's bound profile | off-repo state dir (`profile.json`) | **no** — each machine chooses its own |

Because the binding is machine-local, two machines cloning the same repo can
bind to different profiles and apply different subsets of the same manifest.

## Tagging files

```bash
# At add time (auto-registers the profile if new)
tuck add ~/.work-gitconfig --tag work
tuck add ~/.claude --tag agent            # repeatable: --tag a --tag b
tuck add ~/.foo --tag work,personal       # or comma-separated

# On existing tracked files
tuck profile tag work ~/.work-gitconfig id-or-source...
tuck profile untag work ~/.work-gitconfig
```

## Applying a subset

```bash
tuck apply you/dotfiles --profile work     # universal + work
tuck apply you/dotfiles --profile agent --yes   # headless
```

If `--profile` is omitted, `tuck apply` falls back to this machine's **bound**
profile. If neither is set, every file applies (legacy behavior — fully
backward compatible).

## Binding a machine

```bash
tuck profile bind work      # remembered for this machine
tuck apply you/dotfiles     # applies "work" automatically
tuck profile unbind         # clear the binding
```

`tuck profile bind` works even before the first `tuck apply` on a fresh machine
(pass `--force` to bind to a profile the repo hasn't declared yet).

## Status & leak detection

```bash
tuck status          # shows the bound profile + any cross-profile leaks
tuck profile show    # same, focused view (add --json for automation)
```

A **cross-profile leak** is a tracked file that belongs exclusively to *other*
profiles but is materialized on this machine's disk — e.g. a `work`-only file
present on a machine bound to `personal`. Universal files and files carrying the
bound profile are never leaks.

## Ephemeral environments (IDEAS 2.5)

For devcontainers, Codespaces, and SSH agent sandboxes, apply only the
agent-config subset — no secrets, no personal/work files:

```bash
tuck profile create agent
tuck profile tag agent ~/.claude ~/.codex

# Scaffold devcontainer.json + a Codespaces dotfiles bootstrap
tuck profile devcontainer .
```

This writes:

- `.devcontainer/devcontainer.json` — installs tuck and runs
  `tuck apply <repo> --profile agent --yes` on create.
- `install.sh` — the Codespaces dotfiles entrypoint; applies only the `agent`
  profile. Override the source with `TUCK_SOURCE` and the profile with
  `TUCK_PROFILE`.

## Command reference

| Command | Description |
| ------- | ----------- |
| `tuck profile list` | List profiles, file counts, and the bound profile |
| `tuck profile create <name> [-d desc]` | Register a new profile |
| `tuck profile rm <name> [-f]` | Remove a profile (strips its tag from files) |
| `tuck profile tag <profile> <path-or-id...>` | Tag tracked file(s) |
| `tuck profile untag <profile> <path-or-id...>` | Remove a profile tag |
| `tuck profile bind <name> [-f]` | Bind this machine (machine-local) |
| `tuck profile unbind` | Clear this machine's binding |
| `tuck profile show` | Show the bound profile and cross-profile leaks |
| `tuck profile devcontainer [dir] [-f]` | Scaffold ephemeral-env bootstrap files |

All subcommands accept `--json` for machine-readable output.

Related flags:

- `tuck add --tag <name...>` — tag files as you track them.
- `tuck apply --profile <name>` — apply a specific profile (else the bound one).
