# `tuck settings` — versioned OS settings

`tuck settings` replaces the undocumented, silently-breaking `.macos` bootstrap
script that every dotfiles guide reinvents. Instead of hand-writing
`defaults write` incantations and hoping they still work three macOS releases
later, you:

1. **Capture** a setting by changing it in the GUI while tuck diffs the affected
   `defaults` domains and records the exact write command plus the macOS version
   it was captured on.
2. **Apply** the captured settings on another machine, with per-OS-version
   guards so a setting is skipped when the current OS is out of its supported
   range, and affected apps are restarted automatically.
3. Track a **manual-steps checklist** for things that can't be automated
   ("do-nothing scripting"): tuck shows the instruction, you confirm it's done,
   and tuck remembers that per machine.

macOS (`defaults`) is the only backend in v1. The module is backend-abstracted
(`src/lib/osSettings/`) so a Linux/dconf backend can be added later without
touching the command layer.

## Where data lives

| Artifact | Location | Committed? |
| --- | --- | --- |
| Captured settings + manual-step definitions | `~/.tuck/os-settings.json` | Yes — shared across machines |
| Manual-step completion (per machine) | platform state dir `.../tuck/os-settings-state.json` | No |
| Pre-apply domain backups | platform state dir `.../tuck/os-settings-backups/<timestamp>/` | No |

`os-settings.json` is picked up by `tuck sync`/`tuck push` like any other file in
the repo. The machine-local state and backups deliberately stay out of the repo.

## Commands

### `tuck settings capture [description]`

Interactive (diff) mode:

```bash
# Watch a specific domain (recommended — fast and precise)
tuck settings capture "Auto-hide the Dock" --domain com.apple.dock --restart Dock
# tuck snapshots the domain, prompts you to change the setting in System
# Settings, snapshots again, and records the diff as a `defaults write`.
```

If you omit `--domain`, tuck snapshots **all** domains before and after — slower,
but useful when you don't know which domain a toggle writes to.

Direct (non-interactive/scriptable) mode records a known key without diffing:

```bash
tuck settings capture \
  --domain com.apple.dock --key autohide --type boolean --value true \
  --restart Dock
```

Options:

- `-d, --domain <domain>` — domain to watch/record (repeatable; default: all)
- `-k, --key <key>` — preference key (direct mode)
- `-t, --type <boolean|integer|float|string|date>` — value type (direct mode)
- `--value <value>` — value to record (direct mode)
- `--delete` — record a key deletion instead of a write
- `-m, --description <text>` — human description
- `--min-version <v>` / `--max-version <v>` — inclusive OS-version guard for apply
- `--restart <apps>` — comma-separated apps to restart on apply (e.g. `Dock,Finder`)
- `-y, --yes` — skip confirmation prompts
- `--json` — machine-readable envelope

Only scalar `defaults` types (boolean/integer/float/string/date) are captured
automatically. If a change writes a complex container (dict/array) or opaque
data, tuck surfaces it and suggests recording a manual step instead.

### `tuck settings apply`

Replays tracked settings for the current OS, honoring each setting's version
guard, backing up every affected domain first, and restarting the apps each
applied setting declares.

```bash
tuck settings apply --dry-run   # preview: shows the exact defaults commands
tuck settings apply             # apply (asks for confirmation in a TTY)
```

Options:

- `--id <id>` — only apply this setting id (repeatable)
- `--dry-run` — show what would change without changing anything
- `--no-restart` — do not restart affected apps
- `-y, --yes` — skip the confirmation prompt
- `--json` — machine-readable envelope

Skipped settings (version guard failed) and pending manual steps are reported so
nothing is silently dropped.

### `tuck settings list`

Shows tracked settings and the manual-steps checklist, including whether each
manual step is done on this machine. `--json` emits the full manifest.

### `tuck settings remove <id>`

Untracks a captured setting. Find ids with `tuck settings list`.

### `tuck settings manual …`

- `tuck settings manual add "<title>" -i "<instructions>"` — add a manual step
- `tuck settings manual list` — list steps with per-machine completion
- `tuck settings manual done <id>` — mark done on this machine
- `tuck settings manual reset <id>` — mark not done on this machine

```bash
tuck settings manual add "Enable FileVault" \
  -i "System Settings → Privacy & Security → FileVault → Turn On"
tuck settings manual done macos__manual__enable-filevault
```

## Safety

- Every real apply writes a backup of each affected domain (`defaults export`)
  to the state dir before mutating it.
- Apply prompts for confirmation in an interactive terminal; use `-y/--yes` or
  `--json` for non-interactive runs, or `--dry-run` to preview.
- All `defaults`/`sw_vers`/`killall` calls pass arguments as discrete argv
  entries (never through a shell), so domain/key/value strings can't be
  interpreted as shell syntax.
