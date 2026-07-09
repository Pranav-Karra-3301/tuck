# tuck(1)

## NAME
tuck - Modern dotfiles manager with a beautiful CLI

## SYNOPSIS
tuck [command] [options]

## DESCRIPTION
tuck is a modern dotfiles manager that provides a beautiful CLI for managing your configuration files across machines.

## COMMANDS
* **init**: Initialize tuck
* **add**: Track new dotfiles
* **remove**: Stop tracking dotfiles
* **sync**: Sync all dotfile changes (pull, detect, scan, track, commit, push)
* **push**: Push changes to remote
* **pull**: Pull changes from remote
* **restore**: Restore dotfiles to the system
* **status**: Show current tracking status
* **list**: List all tracked files
* **diff**: Show differences between system and repository
* **config**: Manage tuck configuration
* **apply**: Apply dotfiles from a repository to this machine, or push locally-tracked configs onto a remote box with **--target ssh://[user@]host** (or **--ssh host**); **--print-bootstrap** prints a remote install-and-apply one-liner
* **undo**: Restore files from a Time Machine backup snapshot
* **scan**: Scan the system for dotfiles and select which to track
* **secrets**: Manage local secrets for placeholder replacement (incl. `secrets extract --mcp` to pull inline credentials out of MCP config files)
* **encryption**: Manage backup encryption (AES-256-GCM, password-based)
* **doctor**: Run repository health and safety diagnostics
* **verify**: Verify that the live system, repo, and manifest agree
* **bundle**: Manage bundles — logical groups of tracked files
* **context**: Track AI agent configs across home and per-repo scopes
* **mcp**: Model Context Protocol server — expose tuck to AI agents
* **preset**: Apply or publish curated bundles of dotfiles & agent configs
* **repo**: Manage machine-local repo bindings (repoKey → absolute root)

## OPTIONS
* **-h, --help**: Show help
* **-v, --version**: Show version

## FILES
* `~/.tuck`: Default tuck directory

## SEE ALSO
git(1), stow(1)