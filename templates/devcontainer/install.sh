#!/usr/bin/env bash
#
# Codespaces dotfiles bootstrap for tuck's ephemeral "agent" profile.
#
# GitHub Codespaces (and compatible sandboxes) clone your dotfiles repo and run
# the executable named `install.sh` / `setup.sh` / `bootstrap` at its root. This
# entrypoint applies ONLY the agent-tagged subset of your tracked files — agent
# configs, no secrets, no personal/work dotfiles — so credentials and history
# never enter the ephemeral environment.
#
# Prerequisite: your files are tagged, e.g. `tuck profile tag agent ~/.claude`.
set -euo pipefail

PROFILE="${TUCK_PROFILE:-agent}"

echo "==> tuck: bootstrapping agent sandbox (profile: ${PROFILE})"

# Install tuck if it is not already on PATH (Node.js is expected in the image).
if ! command -v tuck >/dev/null 2>&1; then
  echo "==> tuck: installing via npm"
  npm install -g tuck-cli
fi

# Apply only the named profile, non-interactively. `--yes` assumes yes to all
# prompts; secrets are intentionally out of scope for ephemeral sandboxes.
#
# When Codespaces runs this script the dotfiles repo is already checked out in
# the current directory, so apply from ".". Override TUCK_SOURCE to apply from a
# remote (e.g. "your-user/dotfiles") instead.
SOURCE="${TUCK_SOURCE:-.}"

tuck apply "${SOURCE}" --profile "${PROFILE}" --yes

echo "==> tuck: agent profile applied"
