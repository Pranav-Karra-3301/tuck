# tuck ephemeral-environment templates

These files are shipped with tuck and scaffolded by:

```bash
tuck profile devcontainer [dir]
```

They implement the headless "agent" profile story (IDEAS 2.5): apply only the
agent-config subset of your dotfiles into a devcontainer, Codespace, or SSH
sandbox — no secrets, no personal/work files.

## Files

- **`.devcontainer/devcontainer.json`** — a devcontainer that installs tuck and
  runs `tuck apply <your-repo> --profile agent --yes` on create.
- **`install.sh`** — a Codespaces dotfiles bootstrap. Codespaces runs the
  executable named `install.sh` at the root of your dotfiles repo; this one
  applies only the `agent` profile.

## Prerequisites

Tag the files you want in ephemeral environments:

```bash
tuck profile create agent
tuck profile tag agent ~/.claude ~/.codex ~/.config/gh
```

Untagged (universal) files still apply under every profile. If you want a
sandbox to receive *only* agent files, avoid leaving broad universal files, or
tag them into the profiles that should carry them.
