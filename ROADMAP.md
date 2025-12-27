# tuck Roadmap

> Future features and enhancements planned for tuck

This document outlines the planned features for future versions of tuck. Each feature is designed to make dotfiles management easier, safer, and more powerful.

---

## Version History

| Version | Status | Focus |
|---------|--------|-------|
| v1.0.0 | ✅ Released | Core functionality |
| v1.1.x | ✅ Released | GitHub integration, apply command, Time Machine backups |
| v1.2.0 | 🔜 Planned | Profiles system |
| v1.3.0 | 📋 Planned | Security & diff enhancements |
| v1.4.0 | 📋 Planned | Migration tools & backends |

---

## v1.2.0 — Profiles System

**Goal:** Support different configurations for different machines and contexts (work, personal, server, etc.)

### 1. Multi-Profile Support

#### Overview
Allow users to maintain separate sets of dotfiles for different machines or contexts. A developer might have different configurations for their work laptop, personal desktop, and cloud servers.

#### Directory Structure
```
~/.tuck/
├── profiles/
│   ├── default/          # Default profile (current behavior)
│   │   ├── files/
│   │   │   ├── shell/
│   │   │   ├── git/
│   │   │   └── ...
│   │   └── .tuckmanifest.json
│   ├── work/             # Work machine profile
│   │   ├── files/
│   │   └── .tuckmanifest.json
│   ├── personal/         # Personal machine profile
│   │   ├── files/
│   │   └── .tuckmanifest.json
│   └── server/           # Headless server profile
│       ├── files/
│       └── .tuckmanifest.json
├── .tuckrc.json          # Global config (includes active profile)
└── .profile-mapping.json # Machine hostname → profile mapping
```

#### Commands

```bash
# List all profiles
tuck profile list
# Output:
#   * default (active)
#     work
#     personal
#     server

# Create a new profile
tuck profile create <name>
# Options:
#   --from <profile>    Copy from existing profile
#   --empty             Start with no files

# Switch to a different profile
tuck profile switch <name>
# This will:
#   1. Create backup of current dotfiles
#   2. Apply files from the new profile
#   3. Update active profile in config

# Delete a profile
tuck profile delete <name>
# Options:
#   --force             Skip confirmation

# Show current profile
tuck profile current

# Compare two profiles
tuck profile diff <profile1> <profile2>
```

#### Auto-Detection
When running `tuck apply` or `tuck init` on a new machine:

1. Detect machine characteristics:
   - Hostname
   - OS (darwin, linux, windows)
   - Architecture (arm64, x64)
   - Environment variables (e.g., `$WORK_MACHINE`)

2. Check `.profile-mapping.json` for matches:
   ```json
   {
     "mappings": [
       { "hostname": "work-macbook", "profile": "work" },
       { "hostname": "home-*", "profile": "personal" },
       { "os": "linux", "profile": "server" }
     ]
   }
   ```

3. If match found, prompt for confirmation:
   ```
   Detected profile mapping: work
   Apply 'work' profile? [Y/n]
   ```

#### Implementation Details

**Files to Create:**
- `src/commands/profile.ts` — Profile management commands
- `src/lib/profiles.ts` — Profile utilities (create, switch, delete, list)
- `src/lib/profile-detection.ts` — Auto-detection logic

**Files to Modify:**
- `src/lib/manifest.ts` — Profile-aware manifest loading/saving
- `src/lib/config.ts` — Add active profile to config
- `src/lib/paths.ts` — Profile-aware path resolution
- `src/commands/add.ts` — Add files to active profile
- `src/commands/restore.ts` — Restore from active profile
- `src/commands/apply.ts` — Profile selection during apply

**Edge Cases to Handle:**
- Switching profiles with uncommitted changes
- Files that exist in one profile but not another
- Migrating existing single-profile setup to multi-profile
- Conflicts when same file tracked in multiple profiles

**Security Considerations:**
- Profile names should be validated (alphanumeric, hyphen, underscore only)
- Profile paths must be within `~/.tuck/profiles/` (prevent path traversal)
- Backup creation before any destructive profile operation

---

### 2. Machine-Specific Templates

#### Overview
Allow a single dotfile to contain conditional sections that are processed based on the current machine. This eliminates the need for separate profiles when differences are minor.

#### Syntax
Use a Handlebars-like syntax that's processed during `tuck restore`:

```bash
# ~/.zshrc

# Common configuration
export PATH="/usr/local/bin:$PATH"
export EDITOR="nvim"

# OS-specific configuration
{{#if macos}}
export HOMEBREW_PREFIX="/opt/homebrew"
eval "$(/opt/homebrew/bin/brew shellenv)"
{{/if}}

{{#if linux}}
export HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
{{/if}}

# Machine-specific configuration
{{#if hostname "work-macbook"}}
export CORP_PROXY="http://proxy.company.com:8080"
export NO_PROXY="localhost,127.0.0.1,.company.com"
{{/if}}

{{#if hostname "home-*"}}  # Supports glob patterns
export PERSONAL_API_KEY="{{env "PERSONAL_API_KEY"}}"
{{/if}}

# Architecture-specific
{{#if arch "arm64"}}
alias x86="arch -x86_64"
{{/if}}

# Profile-specific
{{#if profile "work"}}
source ~/.work-aliases
{{/if}}
```

#### Available Variables

| Variable | Description | Example Values |
|----------|-------------|----------------|
| `os` | Operating system | `darwin`, `linux`, `windows` |
| `arch` | CPU architecture | `arm64`, `x64` |
| `hostname` | Machine hostname | `work-macbook`, `home-desktop` |
| `profile` | Active tuck profile | `default`, `work`, `personal` |
| `env "VAR"` | Environment variable | Value of `$VAR` |
| `user` | Current username | `pranav` |
| `home` | Home directory | `/Users/pranav` |

#### Template Directives

```handlebars
{{#if <condition>}}
  Content if true
{{/if}}

{{#if <condition>}}
  Content if true
{{else}}
  Content if false
{{/if}}

{{#unless <condition>}}
  Content if false
{{/unless}}

{{var}}                    # Insert variable value
{{env "VAR_NAME"}}         # Insert environment variable
{{include "path/to/file"}} # Include another file
```

#### Commands

```bash
# Preview processed template for current machine
tuck template preview <file>

# Process all templates without restoring
tuck template render

# Validate template syntax
tuck template validate <file>

# List files with templates
tuck template list
```

#### Implementation Details

**Files to Create:**
- `src/lib/templates.ts` — Template parsing and processing engine
- `src/lib/template-vars.ts` — Variable resolution

**Files to Modify:**
- `src/commands/restore.ts` — Process templates before writing files
- `src/commands/diff.ts` — Show processed vs original in diffs

**Security Considerations:**
- **No arbitrary code execution** — Templates are declarative only
- **No file system access** — `{{include}}` limited to tracked files
- **Environment variable safety** — Option to mask sensitive env vars
- **Validation** — Parse templates before processing to catch errors

**Performance:**
- Templates are processed at restore time, not stored processed
- Caching of parsed templates during batch operations
- Lazy loading of template engine

---

## v1.3.0 — Security & Diff Enhancements

### 3. Encryption Support (age)

#### Overview
Safely store sensitive dotfiles (SSH config, API tokens, credentials) in the repository using modern encryption. Uses [age](https://age-encryption.org/) for its simplicity and security.

#### Why age?
- Simple, modern, audited encryption
- No complex key management like GPG
- Small, focused tool (single binary)
- Supports password-based and key-based encryption

#### Flow

```bash
# Add a file with encryption
tuck add ~/.ssh/config --encrypt

# What happens:
# 1. If no age key exists, generate one:
#    → Saved to ~/.tuck/.age-key (gitignored)
#    → Show key backup instructions
# 2. Encrypt file before storing in repo
# 3. Mark file as encrypted in manifest

# Restore decrypts automatically
tuck restore
# → Prompts for key if not found locally
# → Decrypts files during restore

# Re-encrypt with new key
tuck encrypt rotate

# Export key for backup or transfer
tuck encrypt export
# → Outputs age secret key for secure storage

# Import key on new machine
tuck encrypt import
# → Prompts to paste or provide key file
```

#### Manifest Format

```json
{
  "files": {
    "ssh_config": {
      "source": "~/.ssh/config",
      "destination": "files/ssh/config.age",
      "category": "ssh",
      "encrypted": true,
      "encryptedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

#### Key Management Options

1. **Key-based (default)**
   - Auto-generate age key on first encrypted file
   - Store in `~/.tuck/.age-key` (gitignored)
   - User responsible for backing up key

2. **Password-based**
   ```bash
   tuck add ~/.ssh/config --encrypt --password
   # → Prompts for password
   # → Uses age's scrypt-based password encryption
   ```

3. **Recipient-based (advanced)**
   ```bash
   tuck add ~/.ssh/config --encrypt --recipient age1...
   # → Encrypt to specific age public key
   # → Useful for team dotfiles
   ```

#### Commands

```bash
# Encrypt a tracked file
tuck encrypt <file>

# Decrypt a file (usually automatic on restore)
tuck decrypt <file>

# List encrypted files
tuck encrypt list

# Rotate encryption key
tuck encrypt rotate
# → Re-encrypts all files with new key
# → Outputs new key for backup

# Export secret key
tuck encrypt export
# → Prints key to stdout (pipe to secure storage)

# Import secret key
tuck encrypt import [key-file]
# → Imports from file or prompts for paste
```

#### Implementation Details

**Files to Create:**
- `src/lib/encryption.ts` — Age wrapper (encrypt, decrypt, key management)
- `src/lib/age.ts` — Low-level age CLI interaction

**Files to Modify:**
- `src/commands/add.ts` — Add `--encrypt` flag
- `src/commands/restore.ts` — Auto-decrypt during restore
- `src/lib/manifest.ts` — Track encryption status
- `src/lib/files.ts` — Handle encrypted file operations

**Dependencies:**
- Requires `age` CLI installed (`brew install age` / `apt install age`)
- Detect and prompt for installation if missing

**Security Considerations:**
- **Key storage**: `.age-key` must be in `.gitignore`
- **Key backup**: Prompt user to backup key on generation
- **Memory safety**: Clear decrypted content from memory after use
- **Permissions**: Encrypted source files get restrictive permissions (0600)
- **Audit logging**: Log encryption/decryption operations

---

### 4. Enhanced Diff Viewer

#### Overview
Improve the diff viewing experience with better formatting, syntax highlighting, and interactive features.

#### Features

**Side-by-Side View**
```bash
tuck diff --side-by-side
# or
tuck diff -s

# Output:
# ┌─ ~/.zshrc (local) ──────────────┬─ ~/.zshrc (repo) ───────────────┐
# │ export PATH="/usr/local/bin:... │ export PATH="/usr/local/bin:... │
# │ export EDITOR="vim"             │ export EDITOR="nvim"            │  ← changed
# │                                 │ export VISUAL="nvim"            │  ← added
# │ alias ll="ls -la"               │ alias ll="ls -la"               │
# └─────────────────────────────────┴─────────────────────────────────┘
```

**Syntax Highlighting**
```bash
tuck diff --color
# Highlights based on file type:
# - Shell scripts (.zshrc, .bashrc)
# - JSON (.json)
# - YAML (.yml, .yaml)
# - TOML (.toml)
# - Vim script (.vimrc)
# - Lua (.lua)
```

**Interactive Mode**
```bash
tuck diff --interactive
# or
tuck diff -i

# Shows each hunk and prompts:
# [a]ccept | [r]eject | [s]kip | [v]iew context | [q]uit
```

**Statistics**
```bash
tuck diff --stat
# Output:
# ~/.zshrc       | 12 +++++---
# ~/.gitconfig   |  3 ++-
# ~/.vimrc       | 45 ++++++++++++++++++++++++-----
#
# 3 files changed, 42 insertions(+), 18 deletions(-)
```

**Word-Level Diff**
```bash
tuck diff --word-diff
# Shows changes at word level instead of line level
# Useful for config files with long lines
```

#### Commands

```bash
# Basic diff (current behavior, enhanced)
tuck diff [file]

# Options:
tuck diff --side-by-side, -s    # Side-by-side view
tuck diff --color               # Syntax highlighting (default: on)
tuck diff --no-color            # Disable colors
tuck diff --interactive, -i     # Interactive hunk selection
tuck diff --stat                # Show statistics only
tuck diff --word-diff           # Word-level diff
tuck diff --context <n>         # Lines of context (default: 3)
tuck diff --unified             # Traditional unified diff
```

#### Implementation Details

**Files to Create:**
- `src/ui/diff.ts` — Diff rendering utilities
- `src/lib/syntax.ts` — Syntax highlighting for common file types

**Files to Modify:**
- `src/commands/diff.ts` — Add new options and rendering modes

**Dependencies:**
- Consider using `diff` library for better diff algorithms
- Syntax highlighting can use simple regex-based approach (no heavy deps)

**No Security Implications:**
- Read-only operation
- No external network calls
- No file modifications

---

## v1.4.0 — Migration & Backends

### 5. Migration Tools

#### Overview
Make it easy for users of other dotfiles managers to switch to tuck by automatically detecting and importing their configurations.

#### Supported Tools

**chezmoi**
```bash
tuck migrate chezmoi

# Detection:
# - Looks for ~/.local/share/chezmoi
# - Parses .chezmoi.toml.tmpl for config

# Migration:
# 1. List tracked files from chezmoi
# 2. Show preview of what will be imported
# 3. Copy actual dotfiles (not templates) to tuck
# 4. Convert template variables where possible
# 5. Offer to remove chezmoi setup
```

**yadm**
```bash
tuck migrate yadm

# Detection:
# - Looks for ~/.local/share/yadm/repo.git
# - Or ~/.yadm directory

# Migration:
# 1. List files tracked by yadm
# 2. Handle yadm's alt files (##os.Linux, etc.)
# 3. Convert to tuck format
# 4. Handle encrypted files (prompt for yadm decrypt first)
```

**GNU Stow**
```bash
tuck migrate stow [stow-dir]

# Detection:
# - Looks for ~/dotfiles or ~/.dotfiles with stow structure
# - Identifies packages by directory structure

# Migration:
# 1. Detect stow packages
# 2. Unstow (remove symlinks)
# 3. Copy actual files to tuck
# 4. Re-apply via tuck restore
```

**Bare Git Repository**
```bash
tuck migrate bare [git-dir]

# Detection:
# - Common patterns: ~/.cfg, ~/.dotfiles.git

# Migration:
# 1. List tracked files from bare repo
# 2. Copy to tuck structure
# 3. Preserve git history (optional)
```

#### Universal Migration Flow

```bash
tuck migrate <tool>

# Step 1: Detection
# "Detected chezmoi installation at ~/.local/share/chezmoi"
# "Found 24 tracked files"

# Step 2: Preview
# "The following files will be imported:"
# "  ~/.zshrc"
# "  ~/.gitconfig"
# "  ~/.config/nvim/init.lua"
# "  ... (21 more)"

# Step 3: Confirmation
# "Import these files to tuck? [Y/n]"

# Step 4: Import
# "Importing files..."
# "✓ Imported 24 files"

# Step 5: Cleanup (optional)
# "Remove chezmoi installation? [y/N]"

# Step 6: Next steps
# "Migration complete!"
# "Run 'tuck status' to see imported files"
# "Run 'tuck sync' to commit to repository"
```

#### Implementation Details

**Files to Create:**
- `src/commands/migrate.ts` — Main migration command
- `src/lib/migrate/chezmoi.ts` — Chezmoi importer
- `src/lib/migrate/yadm.ts` — Yadm importer
- `src/lib/migrate/stow.ts` — Stow importer
- `src/lib/migrate/bare.ts` — Bare repo importer
- `src/lib/migrate/common.ts` — Shared utilities

**Security Considerations:**
- Validate all imported file paths (prevent path traversal)
- Don't auto-import encrypted files without user consent
- Preserve file permissions during import
- Create backup before removing old tool's setup

---

### 6. Flexible Storage Backends

#### Overview
Support different storage backends beyond GitHub, including GitLab, self-hosted git servers, and local-only mode.

#### Supported Backends

**GitHub (default)**
```bash
tuck init
# → Auto-detects gh CLI
# → Creates repo via GitHub API
# → Uses SSH or HTTPS based on preference
```

**GitLab**
```bash
tuck init --backend gitlab

# Or with glab CLI:
# → Auto-detects glab CLI
# → Creates repo via GitLab API
# → Supports gitlab.com and self-hosted

# Configuration:
tuck config set backend.gitlab.url "https://gitlab.company.com"
```

**Local Only**
```bash
tuck init --local

# No remote configured
# Git repo for version history only
# Good for:
# - Privacy-conscious users
# - Air-gapped machines
# - Testing
```

**Custom Git Remote**
```bash
tuck init --remote git@custom.server:user/dotfiles.git

# Works with any git server:
# - Gitea
# - Gogs
# - Bitbucket
# - Self-hosted
```

#### Backend Detection & Setup

```bash
tuck init

# 1. Check for CLI tools:
#    - gh (GitHub)
#    - glab (GitLab)

# 2. If authenticated, offer auto-create:
#    "Detected GitHub CLI. Create repository automatically? [Y/n]"
#    "Detected GitLab CLI. Create repository automatically? [Y/n]"

# 3. If neither, offer options:
#    "How would you like to set up your remote?"
#    > GitHub (manual URL)
#    > GitLab (manual URL)
#    > Other git server
#    > Local only (no remote)
```

#### Implementation Details

**Files to Create:**
- `src/lib/backends/index.ts` — Backend interface and registry
- `src/lib/backends/github.ts` — GitHub backend (refactored from github.ts)
- `src/lib/backends/gitlab.ts` — GitLab backend
- `src/lib/backends/generic.ts` — Generic git remote backend
- `src/lib/backends/local.ts` — Local-only backend

**Files to Modify:**
- `src/commands/init.ts` — Backend selection during init
- `src/commands/push.ts` — Backend-aware push
- `src/commands/pull.ts` — Backend-aware pull
- `src/lib/config.ts` — Store backend configuration

**Backend Interface:**
```typescript
interface Backend {
  name: string;

  // Detection
  isAvailable(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;

  // Repository operations
  createRepo(options: CreateRepoOptions): Promise<RepoInfo>;
  repoExists(name: string): Promise<boolean>;
  getRepoInfo(name: string): Promise<RepoInfo | null>;

  // URL generation
  getRemoteUrl(repo: RepoInfo): Promise<string>;

  // User info
  getUser(): Promise<UserInfo>;
}
```

---

## Contributing

Want to help implement these features? Here's how:

1. **Pick a feature** from this roadmap
2. **Open an issue** to discuss implementation approach
3. **Fork and implement** following the patterns in CLAUDE.md
4. **Submit a PR** with tests

### Priority Order

If you're looking to contribute, these are ordered by impact and complexity:

1. **Enhanced Diff Viewer** — Low complexity, high UX impact
2. **Profiles System** — Medium complexity, high value for power users
3. **Encryption Support** — Medium complexity, important for security
4. **Migration Tools** — Medium complexity, helps adoption
5. **Templates** — Higher complexity, powerful but niche
6. **Backends** — Higher complexity, limited audience

---

## Timeline

No fixed dates — tuck is developed as time permits. Features are released when they're ready, stable, and well-tested.

**Guiding Principles:**
- Quality over speed
- Security over convenience
- Simplicity over features
- User experience over developer convenience

---

*Last updated: December 2024*
