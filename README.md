<div align="center">
  <img src="public/tuck.png" alt="tuck logo" width="200">
</div>

# tuck

> Modern dotfiles manager with a beautiful CLI

[![npm version](https://img.shields.io/npm/v/@prnv/tuck.svg)](https://www.npmjs.com/package/@prnv/tuck)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Pranav-Karra-3301/tuck/actions/workflows/ci.yml/badge.svg)](https://github.com/Pranav-Karra-3301/tuck/actions/workflows/ci.yml)

## Features

- **Beautiful CLI** - Gorgeous prompts, spinners, and colors powered by @clack/prompts
- **Git-native** - Uses git under the hood but abstracts complexity
- **Organized** - Auto-categorizes your dotfiles (shell, git, editors, terminal, etc.)
- **Safe** - Never overwrites without confirmation, always creates backups
- **Fast** - Written in TypeScript, runs on Node.js 18+
- **Cross-platform** - Works on macOS and Linux

## Installation

```bash
# npm
npm install -g @prnv/tuck

# pnpm
pnpm add -g @prnv/tuck

# yarn
yarn global add @prnv/tuck

# Homebrew (macOS)
brew tap pranav-karra-3301/tuck
brew install tuck
```

## Quick Start

```bash
# Initialize tuck (interactive)
tuck init

# Or initialize with a remote repository
tuck init --from git@github.com:username/dotfiles.git

# Add your dotfiles
tuck add ~/.zshrc ~/.gitconfig ~/.config/nvim

# Sync changes to repository
tuck sync

# Push to remote
tuck push
```

## Commands

| Command | Description |
|---------|-------------|
| `tuck init` | Initialize tuck repository |
| `tuck add <paths>` | Track new dotfiles |
| `tuck remove <paths>` | Stop tracking dotfiles |
| `tuck sync` | Sync changes to repository |
| `tuck push` | Push to remote |
| `tuck pull` | Pull from remote |
| `tuck restore` | Restore dotfiles to system |
| `tuck status` | Show tracking status |
| `tuck list` | List tracked files |
| `tuck diff` | Show changes |
| `tuck config` | Manage configuration |

## How It Works

Tuck stores your dotfiles in `~/.tuck` (configurable), organized by category:

```
~/.tuck/
├── files/
│   ├── shell/      # .zshrc, .bashrc, etc.
│   ├── git/        # .gitconfig, .gitignore_global
│   ├── editors/    # .vimrc, nvim config
│   ├── terminal/   # .tmux.conf, alacritty config
│   ├── ssh/        # ssh config
│   └── misc/       # everything else
├── .tuckmanifest.json  # Tracks all managed files
├── .tuckrc.json        # Tuck configuration
└── README.md
```

When you run `tuck add ~/.zshrc`:
1. The file is copied to `~/.tuck/files/shell/zshrc`
2. An entry is added to the manifest with the source path and checksum
3. Run `tuck sync` to commit and `tuck push` to upload

When setting up a new machine:
```bash
tuck init --from git@github.com:username/dotfiles.git
tuck restore --all
```

## Configuration

Tuck can be configured via `~/.tuck/.tuckrc.json`:

```json
{
  "repository": {
    "path": "~/.tuck",
    "defaultBranch": "main",
    "autoCommit": true,
    "autoPush": false
  },
  "files": {
    "strategy": "copy",
    "backupOnRestore": true,
    "backupDir": "~/.tuck-backups"
  },
  "ui": {
    "colors": true,
    "emoji": true,
    "verbose": false
  }
}
```

### File Strategies

- **copy** (default): Files are copied to the repository. Changes in your system don't affect the repo until you run `tuck sync`.
- **symlink**: Files in your system are replaced with symlinks to the repository. Changes are immediate.

## Restoring on a New Machine

```bash
# Option 1: Clone and restore in one step
tuck init --from git@github.com:username/dotfiles.git
tuck restore --all

# Option 2: Clone manually
git clone git@github.com:username/dotfiles.git ~/.tuck
tuck restore --all
```

## Hooks

Run custom commands before/after sync or restore:

```json
{
  "hooks": {
    "preSync": "echo 'About to sync...'",
    "postSync": "echo 'Sync complete!'",
    "preRestore": "echo 'Backing up...'",
    "postRestore": "source ~/.zshrc"
  }
}
```

## Development

```bash
# Clone the repository
git clone https://github.com/Pranav-Karra-3301/tuck.git
cd tuck

# Install dependencies
pnpm install

# Build
pnpm build

# Run locally
node dist/index.js --help

# Run tests
pnpm test

# Lint
pnpm lint
```

## License

MIT - see [LICENSE](LICENSE)
