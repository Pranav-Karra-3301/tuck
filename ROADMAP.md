<img src="public/Roadmap.png" alt="Roadmap" style="width:100%;">

# tuck Roadmap

> Future features and enhancements planned for tuck

This document outlines the planned features for future versions of tuck. Each feature is designed to make dotfiles management easier, safer, and more powerful.

---

## Version History

| Version | Status | Focus |
|---------|--------|-------|
| v1.0.0 | ✅ Released | Core functionality |
| v1.1.x | ✅ Released | GitHub integration, apply command, Time Machine backups |
| v1.2.x | ✅ Released | Auto-detect GitHub repos, basic diff command, security fixes |
| v1.3.0 | 🔜 Next | AI Agent & Beginner Experience |
| v1.4.0 | 📋 Planned | Validation & Health |
| v1.5.0 | 📋 Planned | Profiles System |
| v1.6.0 | 📋 Planned | Security & Diff Enhancements |
| v1.7.0 | 📋 Planned | Migration Tools & Backends |
| v2.0.0 | 🔮 Vision | Plugin Ecosystem & Cloud Sync |

---

## v1.3.0 — AI Agent & Beginner Experience

**Goal:** Make tuck the go-to tool for AI coding agents (Claude Code, Cursor, Aider, Windsurf) and terminal beginners alike. Lower the barrier to entry while providing powerful automation capabilities.

### 1. AI Agent Terminal Setup (`tuck agent-setup`)

#### Overview
One command to configure a terminal environment optimized for AI coding agents. These agents often run in non-interactive contexts and need specific configurations to work reliably.

#### Why This Matters
- AI agents like Claude Code run shell commands programmatically
- Default terminal configs assume interactive human use
- Missing configs cause silent failures or poor output
- Agents need consistent, predictable environments

#### Command

```bash
tuck agent-setup [agent]

# Supported agents:
tuck agent-setup claude-code    # Claude Code by Anthropic
tuck agent-setup cursor         # Cursor AI
tuck agent-setup aider          # Aider.chat
tuck agent-setup windsurf       # Codeium Windsurf
tuck agent-setup                # Auto-detect or generic setup

# Options:
--dry-run                       # Preview changes
--shell <bash|zsh|fish>         # Target shell (default: auto-detect)
--minimal                       # Essential configs only
--full                          # Include all optimizations
```

#### What It Configures

**Shell Environment:**
```bash
# ~/.zshrc additions for AI agents

# Disable interactive prompts that break automation
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export PIP_DISABLE_PIP_VERSION_CHECK=1
export NPM_CONFIG_UPDATE_NOTIFIER=false

# Better output for parsing
export TERM=xterm-256color
export FORCE_COLOR=1
export CLICOLOR=1

# Prevent pagers from blocking
export PAGER=cat
export GIT_PAGER=cat
export BAT_PAGER=cat

# Increase history for context
export HISTSIZE=50000
export SAVEHIST=50000

# Agent-specific markers (for log parsing)
export TUCK_AGENT_MODE=1
export TUCK_AGENT_NAME="claude-code"
```

**Git Configuration:**
```bash
# Better defaults for automated commits
git config --global init.defaultBranch main
git config --global push.autoSetupRemote true
git config --global core.autocrlf input
git config --global core.safecrlf warn
```

**tmux/screen Setup:**
- Create session persistence configs
- Configure for programmatic control
- Set up clean status lines

#### Agent-Specific Optimizations

**Claude Code:**
```bash
# Optimize for Claude's shell execution patterns
export CLAUDE_CODE_SHELL_TIMEOUT=300
alias cc='claude'  # Quick access
```

**Cursor:**
```bash
# Cursor-specific environment
export CURSOR_WORKSPACE_TRUST=1
```

#### Implementation Details

**Files to Create:**
- `src/commands/agent-setup.ts` — Main command
- `src/lib/agents/index.ts` — Agent configuration registry
- `src/lib/agents/claude-code.ts` — Claude Code specific configs
- `src/lib/agents/cursor.ts` — Cursor specific configs
- `src/lib/agents/common.ts` — Shared agent configurations

**Files to Modify:**
- `src/index.ts` — Register new command

---

### 2. One-Command Theme Installation (`tuck install`)

#### Overview
Install popular terminal themes, frameworks, and tools with a single command. No more following lengthy README instructions.

#### Why This Matters
- Installing Powerlevel10k requires multiple steps
- Oh My Zsh installation varies by system
- Beginners often make mistakes during setup
- Tuck can automate and track these installations

#### Command

```bash
tuck install <package>

# Themes
tuck install powerlevel10k      # Powerlevel10k theme
tuck install starship           # Starship prompt
tuck install pure               # Pure prompt

# Frameworks
tuck install oh-my-zsh          # Oh My Zsh
tuck install prezto             # Prezto framework
tuck install zinit              # Zinit plugin manager
tuck install antidote           # Antidote plugin manager

# Tools
tuck install fzf                # Fuzzy finder
tuck install zoxide             # Smart cd
tuck install eza                # Modern ls
tuck install bat                # Modern cat
tuck install delta              # Modern diff

# Bundles
tuck install modern-terminal    # All modern CLI tools
tuck install developer-setup    # Full dev environment

# Options
--dry-run                       # Preview changes
--no-backup                     # Skip backing up existing files
--force                         # Overwrite existing installations
```

#### Installation Flow

```bash
tuck install powerlevel10k

# Step 1: Check prerequisites
# "Checking prerequisites..."
# "✓ Zsh installed"
# "✓ Git installed"
# "⚠ Nerd Font not detected (optional but recommended)"

# Step 2: Show what will be installed
# "This will:"
# "  • Clone powerlevel10k to ~/.powerlevel10k"
# "  • Add source line to ~/.zshrc"
# "  • Create ~/.p10k.zsh configuration"
# "Continue? [Y/n]"

# Step 3: Create Time Machine snapshot
# "Creating backup snapshot..."

# Step 4: Install
# "Installing powerlevel10k..."
# "✓ Cloned repository"
# "✓ Updated ~/.zshrc"
# "✓ Created default configuration"

# Step 5: Track with tuck
# "Tracking installed files..."
# "✓ Added ~/.p10k.zsh to tuck"
# "✓ Added ~/.zshrc to tuck"

# Step 6: Next steps
# "Installation complete!"
# "Restart your terminal or run: source ~/.zshrc"
# "Configure theme: p10k configure"
```

#### Package Registry

```typescript
interface Package {
  name: string;
  description: string;
  category: 'theme' | 'framework' | 'tool' | 'bundle';
  shells?: ('zsh' | 'bash' | 'fish')[];

  // Prerequisites
  requires?: string[];           // Required packages
  recommends?: string[];         // Recommended packages
  conflicts?: string[];          // Conflicting packages

  // Installation
  install: InstallStep[];        // Installation steps
  verify: VerifyStep[];          // Verification steps

  // Tracked files
  trackedFiles: string[];        // Files to add to tuck
}
```

#### Built-in Packages

| Package | Description | Category |
|---------|-------------|----------|
| `powerlevel10k` | Instant prompt, rich customization | theme |
| `starship` | Cross-shell prompt in Rust | theme |
| `pure` | Minimal, fast prompt | theme |
| `oh-my-zsh` | Popular Zsh framework | framework |
| `zinit` | Fast, flexible plugin manager | framework |
| `fzf` | Fuzzy finder with shell integration | tool |
| `zoxide` | Smarter cd command | tool |
| `modern-terminal` | eza, bat, fd, ripgrep, delta | bundle |

#### Implementation Details

**Files to Create:**
- `src/commands/install.ts` — Main install command
- `src/lib/packages/index.ts` — Package registry
- `src/lib/packages/registry/*.ts` — Individual package definitions
- `src/lib/packages/installer.ts` — Installation logic

---

### 3. Guided Terminal Setup Wizard (`tuck setup`)

#### Overview
An interactive, beginner-friendly wizard that sets up a complete terminal environment from scratch. Think "create-react-app" but for your terminal.

#### Command

```bash
tuck setup

# Interactive wizard that asks:
# 1. What's your experience level? (beginner/intermediate/advanced)
# 2. What shell do you use? (detect or select)
# 3. Do you want a fancy prompt? (recommend based on level)
# 4. What tools do you primarily use? (git, node, python, etc.)
# 5. Do you use any AI coding agents?
# 6. Where should we back up your dotfiles? (GitHub recommended)

# Creates personalized dotfiles based on answers
```

#### Wizard Flow

```
╭──────────────────────────────────────────────────────────────╮
│                                                              │
│        ✨ Welcome to tuck terminal setup wizard ✨           │
│                                                              │
│  We'll help you create a beautiful, productive terminal      │
│  in just a few minutes.                                      │
│                                                              │
╰──────────────────────────────────────────────────────────────╯

◆ What's your terminal experience level?
│ ○ Beginner — I'm new to the command line
│ ● Intermediate — I use the terminal regularly
│ ○ Advanced — I customize everything myself
└

◆ What kind of development do you do?
│ ◻ Web development (JavaScript/TypeScript)
│ ◼ Backend development (Python, Go, Rust)
│ ◼ Mobile development (iOS, Android, React Native)
│ ◻ DevOps / Cloud
│ ◼ Data Science / ML
└

◆ Do you use any AI coding agents?
│ ◼ Claude Code
│ ◻ Cursor
│ ◻ Aider
│ ◻ None / Not sure
└
```

#### Generated Configuration

Based on user answers, generates a personalized setup:

**For Beginners:**
- Simple, clean prompt (Starship with minimal config)
- Helpful aliases with descriptions
- Safety aliases (rm -i, mv -i)
- Git aliases explained
- Syntax highlighting and suggestions enabled

**For Intermediate:**
- Powerlevel10k with balanced config
- Useful plugins (zsh-autosuggestions, syntax-highlighting)
- Git shortcuts and status in prompt
- fzf integration
- Modern CLI tools (eza, bat, fd)

**For Advanced:**
- Minimal base config (they'll customize)
- Plugin manager (zinit) for flexibility
- Performance profiling setup
- Key binding suggestions
- Full customization access

---

### 4. Recipe System (`tuck recipe`)

#### Overview
Pre-built, curated configuration bundles that users can browse, preview, and apply. Like a "dotfiles cookbook" with tested recipes.

#### Command

```bash
# Browse available recipes
tuck recipe list
tuck recipe list --category shell
tuck recipe search "git aliases"

# Preview a recipe
tuck recipe show <recipe-name>
tuck recipe preview <recipe-name>

# Apply a recipe
tuck recipe apply <recipe-name>
tuck recipe apply <recipe-name> --dry-run
tuck recipe apply <recipe-name> --merge    # Merge with existing
tuck recipe apply <recipe-name> --replace  # Replace existing

# Share your config as a recipe
tuck recipe create <recipe-name>
tuck recipe publish <recipe-name>  # Future: community registry
```

#### Built-in Recipes

```
╭────────────────────────────────────────────────────────────────────╮
│ Available Recipes                                                  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🐚 Shell                                                           │
│   git-power-aliases     50+ productivity-boosting git aliases      │
│   navigation-plus       Smart cd, directory bookmarks, fzf nav     │
│   safety-first          Confirmations for dangerous commands       │
│   history-enhanced      Better history search and management       │
│                                                                    │
│ 📝 Editor                                                          │
│   vim-essentials        Sensible Vim defaults for modern use       │
│   neovim-minimal        Clean Neovim config with LSP               │
│   vscode-terminal       VS Code integrated terminal tweaks         │
│                                                                    │
│ 🔧 Git                                                             │
│   git-config-pro        Professional Git configuration             │
│   git-hooks-quality     Pre-commit hooks for code quality          │
│   git-aliases-compact   Short, memorable git aliases               │
│                                                                    │
│ 🤖 AI Agents                                                       │
│   claude-code-ready     Optimized for Claude Code                  │
│   cursor-optimized      Cursor AI environment                      │
│   agent-universal       Works with any AI coding agent             │
│                                                                    │
│ 📦 Bundles                                                         │
│   developer-complete    Full development environment               │
│   minimalist            Clean, fast, essential-only                │
│   power-user            Everything for productivity                │
│                                                                    │
╰────────────────────────────────────────────────────────────────────╯
```

#### Recipe Format

```yaml
# .tuck/recipes/git-power-aliases.yaml
name: git-power-aliases
description: 50+ productivity-boosting git aliases
author: tuck-team
version: 1.0.0
category: shell
tags: [git, productivity, aliases]

# What this recipe provides
provides:
  - type: shell-aliases
    count: 52
  - type: shell-functions
    count: 8
  - type: git-config
    count: 15

# Files this recipe creates/modifies
files:
  - path: ~/.config/tuck/aliases/git.zsh
    action: create
  - path: ~/.gitconfig
    action: merge
    section: alias

# Preview content
preview: |
  # Git aliases included:
  alias g='git'
  alias gs='git status -sb'
  alias gc='git commit'
  alias gco='git checkout'
  alias gb='git branch'
  alias gp='git push'
  alias gl='git pull'
  alias gd='git diff'
  alias gds='git diff --staged'
  # ... and 43 more

# Actual content
content:
  aliases/git.zsh: |
    # Git Power Aliases
    # Generated by tuck recipe: git-power-aliases

    alias g='git'
    alias gs='git status -sb'
    # ... full content
```

---

## v1.4.0 — Validation & Health

**Goal:** Proactively detect issues with dotfiles before they cause problems. Validate syntax, check dependencies, and ensure configurations are healthy.

### 5. Dotfile Validation (`tuck validate`)

#### Overview
Syntax-check and lint dotfiles to catch errors before they break your shell. Support common config file formats with clear error messages.

#### Why This Matters
- A syntax error in .zshrc can make terminals unusable
- JSON/YAML config errors are hard to spot
- Users often don't discover issues until something breaks
- AI agents can generate malformed configs

#### Command

```bash
# Validate all tracked files
tuck validate

# Validate specific file
tuck validate ~/.zshrc
tuck validate ~/.gitconfig

# Validate with auto-fix suggestions
tuck validate --fix

# Validate in CI/pre-commit
tuck validate --strict  # Exit code 1 on any issue

# Output formats
tuck validate --format json
tuck validate --format github  # GitHub Actions annotations
```

#### Validation Output

```
╭─────────────────────────────────────────────────────────────────╮
│ tuck validate                                                   │
╰─────────────────────────────────────────────────────────────────╯

Validating 12 tracked files...

✓ ~/.zshrc
  └─ Shell syntax: valid
  └─ Shellcheck: 2 suggestions (style)

✗ ~/.gitconfig
  │ Line 15: Invalid section name '[alais]' (did you mean 'alias'?)
  │ Line 23: Unknown config key 'autoCRLF' (did you mean 'autocrlf'?)
  └─ 2 errors, 0 warnings

✓ ~/.config/starship.toml
  └─ TOML syntax: valid
  └─ Schema: valid Starship config

⚠ ~/.ssh/config
  │ Line 8: Deprecated option 'DSAAuthentication'
  │ Line 12: Weak key algorithm 'ssh-rsa' (recommend ed25519)
  └─ 0 errors, 2 warnings

───────────────────────────────────────────────────────────────────
Summary: 12 files, 2 errors, 4 warnings

Run 'tuck validate --fix' to auto-fix 2 issues
```

#### Supported Formats

| File Type | Validators |
|-----------|------------|
| `.zshrc`, `.bashrc` | bash -n, shellcheck |
| `.gitconfig` | git config --check, known keys |
| `.ssh/config` | ssh -G validation, security audit |
| `.json` files | JSON parse, optional schema |
| `.yaml`, `.yml` | YAML parse, optional schema |
| `.toml` | TOML parse |
| `.vimrc`, `init.vim` | vim -c 'source %' -c 'qa' |
| `.tmux.conf` | tmux source-file syntax |

#### Auto-Fix Capabilities

```bash
tuck validate --fix

# Fixable issues:
# ✓ Fix trailing whitespace
# ✓ Fix missing newline at EOF
# ✓ Fix common typos (e.g., 'alais' → 'alias')
# ✓ Update deprecated options
# ✓ Fix JSON/YAML formatting

# Non-fixable issues (just reported):
# ⚠ Security recommendations
# ⚠ Logic errors
# ⚠ Missing dependencies
```

---

### 6. Health Check Command (`tuck doctor`)

#### Overview
Comprehensive diagnostic tool that checks the overall health of your dotfiles setup, terminal configuration, and tuck installation.

#### Command

```bash
tuck doctor

# Check specific areas
tuck doctor --check shell
tuck doctor --check git
tuck doctor --check ssh
tuck doctor --check security

# Output format
tuck doctor --json
```

#### Doctor Output

```
╭──────────────────────────────────────────────────────────────────╮
│ 🩺 tuck doctor                                                   │
╰──────────────────────────────────────────────────────────────────╯

System Information
├─ OS: macOS 14.2 (arm64)
├─ Shell: zsh 5.9
├─ Terminal: iTerm2 3.4.23
└─ tuck: v1.4.0

─────────────────────────────────────────────────────────────────

✓ Tuck Installation
  ├─ Config directory: ~/.tuck
  ├─ Manifest: 24 files tracked
  ├─ Git repository: healthy
  └─ Remote: synced with origin

✓ Shell Configuration
  ├─ ~/.zshrc: valid syntax
  ├─ Startup time: 0.42s (good)
  ├─ Plugins: 8 loaded
  └─ Aliases: 156 defined

⚠ Git Configuration
  │ Warning: user.email not set globally
  │ Suggestion: git config --global user.email "you@example.com"
  ├─ user.name: ✓ configured
  ├─ core.editor: ✓ nvim
  └─ push.default: ⚠ not set (recommend 'current')

✗ SSH Configuration
  │ Error: Permission 0644 on ~/.ssh/id_ed25519 too open
  │ Fix: chmod 600 ~/.ssh/id_ed25519
  ├─ Keys: 3 found
  ├─ Config: valid syntax
  └─ Agent: ⚠ not running

✓ Security Audit
  ├─ No secrets in tracked files
  ├─ SSH keys not tracked (good)
  └─ File permissions: proper

─────────────────────────────────────────────────────────────────

Summary: 3 passed, 1 warning, 1 error
Run 'tuck doctor --fix' to auto-fix 1 issue
```

#### Health Checks Performed

**Shell Health:**
- Syntax validation
- Startup time profiling
- Plugin compatibility
- Duplicate aliases/functions
- PATH issues (missing, duplicates, order)

**Git Health:**
- Required configs (user.name, user.email)
- Recommended configs
- Hook scripts validity
- Credential helper setup

**SSH Health:**
- Key file permissions (must be 0600)
- Config file permissions
- Known hosts validity
- Agent running status
- Key algorithm recommendations

**Security Audit:**
- Scan for secrets in tracked files
- Check for exposed API keys
- Verify sensitive files not tracked
- Permission audit on config files

---

### 7. Dependency Tracking (`tuck deps`)

#### Overview
Track what external tools and dependencies your dotfiles require. Warn when configs reference missing tools, and help install missing dependencies.

#### Why This Matters
- Dotfiles often reference tools that may not be installed
- Moving to a new machine breaks configs silently
- No easy way to know "what do I need to install?"
- AI agents may not know what tools are available

#### Command

```bash
# Analyze dependencies in tracked dotfiles
tuck deps

# Check if all dependencies are installed
tuck deps check

# Install missing dependencies
tuck deps install

# List dependencies for specific file
tuck deps show ~/.zshrc

# Export as Brewfile or script
tuck deps export --format brewfile > Brewfile
tuck deps export --format script > install-deps.sh
tuck deps export --format apt > packages.txt
```

#### Output

```
╭──────────────────────────────────────────────────────────────────╮
│ tuck deps                                                        │
╰──────────────────────────────────────────────────────────────────╯

Analyzing dependencies in 24 tracked files...

Required Tools (found in your dotfiles)
├─ Shell Tools
│  ├─ ✓ fzf          (v0.44.0)  ~/.zshrc, ~/.config/fzf/config
│  ├─ ✓ zoxide       (v0.9.2)   ~/.zshrc
│  ├─ ✓ eza          (v0.17.0)  ~/.zshrc (aliased as ls)
│  └─ ✗ bat          (missing)  ~/.zshrc (aliased as cat)
│
├─ Git Tools
│  ├─ ✓ git          (v2.43.0)  ~/.gitconfig, ~/.zshrc
│  ├─ ✓ delta        (v0.16.5)  ~/.gitconfig
│  └─ ✓ gh           (v2.40.1)  ~/.zshrc
│
├─ Editor Tools
│  ├─ ✓ nvim         (v0.9.4)   ~/.config/nvim/*, ~/.zshrc
│  └─ ✓ code         (v1.85.0)  ~/.zshrc
│
└─ Other
   ├─ ✓ starship     (v1.16.0)  ~/.config/starship.toml
   ├─ ✓ tmux         (v3.3a)    ~/.tmux.conf
   └─ ⚠ ripgrep      (v14.0)    ~/.zshrc (optional, fallback exists)

─────────────────────────────────────────────────────────────────

Summary: 11 dependencies, 10 installed, 1 missing

Missing: bat
  Referenced in: ~/.zshrc line 45
  Install with: brew install bat

Run 'tuck deps install' to install missing dependencies
```

---

## v1.5.0 — Profiles System

**Goal:** Support different configurations for different machines and contexts (work, personal, server, etc.)

### 8. Multi-Profile Support

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

### 9. Machine-Specific Templates

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

## v1.6.0 — Security & Diff Enhancements

### 10. Encryption Support (age)

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

### 11. Enhanced Diff Viewer

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

## v1.7.0 — Migration & Backends

### 12. Migration Tools

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

### 13. Flexible Storage Backends

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

## v2.0.0 — Vision: Plugin Ecosystem & Beyond

**Goal:** Transform tuck from a dotfiles manager into an extensible terminal configuration platform. This is the long-term vision for where tuck could evolve.

### 14. Shell Startup Optimization (`tuck optimize`)

#### Overview
Profile and optimize shell startup time. Many users have slow-loading terminals without knowing why.

#### Command

```bash
# Profile shell startup
tuck optimize profile
# Output: Detailed breakdown of what's slow

# Get recommendations
tuck optimize suggest
# Output: Specific suggestions to speed up startup

# Auto-optimize
tuck optimize --apply
# Implements safe optimizations automatically
```

#### Analysis Output

```
╭──────────────────────────────────────────────────────────────────╮
│ 🚀 Shell Startup Analysis                                        │
╰──────────────────────────────────────────────────────────────────╯

Total startup time: 1.847s (target: <0.5s)

Breakdown:
├─ Plugin loading         842ms (45.6%)
│  ├─ zsh-syntax-highlighting    312ms ⚠️
│  ├─ zsh-autosuggestions        156ms
│  ├─ fzf-tab                    234ms ⚠️
│  └─ others                     140ms
├─ nvm initialization      423ms (22.9%) ⚠️
├─ conda initialization    312ms (16.9%) ⚠️
├─ starship prompt         156ms (8.4%)
└─ other                   114ms (6.2%)

Recommendations:
1. [HIGH] Lazy-load nvm (saves ~400ms)
   Add to .zshrc: export NVM_LAZY=1
2. [HIGH] Lazy-load conda (saves ~300ms)
   Use conda's lazy activation
3. [MED] Defer syntax-highlighting
   Load after prompt is displayed
```

---

### 15. Keybinding Analysis (`tuck keys`)

#### Overview
Analyze terminal keybindings to find conflicts, suggest improvements, and help users discover powerful shortcuts they're not using.

#### Command

```bash
# Show all keybindings
tuck keys list

# Find conflicts
tuck keys conflicts

# Get suggestions based on usage
tuck keys suggest

# Import keybindings from preset
tuck keys apply vim-mode
tuck keys apply emacs-mode
```

#### Conflict Detection Output

```
╭──────────────────────────────────────────────────────────────────╮
│ 🔑 Keybinding Analysis                                           │
╰──────────────────────────────────────────────────────────────────╯

⚠️ Conflicts Detected (3)

1. Ctrl+R
   ├─ fzf: fzf-history-widget (active)
   └─ zsh: history-incremental-search-backward (shadowed)
   Suggestion: Keep fzf (more powerful)

2. Ctrl+T
   ├─ fzf: fzf-file-widget (active)
   └─ tmux: new-window (when in tmux)
   Suggestion: Remap tmux to Ctrl+Shift+T

3. Ctrl+G
   ├─ zoxide: zi (active)
   └─ git: (common alias in many setups)
   Suggestion: Use 'z' for zoxide, keep Ctrl+G for git

Unused powerful shortcuts:
• Ctrl+X Ctrl+E — Edit command in $EDITOR
• Alt+. — Insert last argument
• Ctrl+U — Delete to beginning of line
```

---

### 16. Plugin Ecosystem

#### Overview
A system for creating, sharing, and discovering tuck plugins that extend its functionality.

#### Features

**Plugin Discovery:**
```bash
# Browse plugins
tuck plugin search "git"
tuck plugin browse --category productivity

# Install plugin
tuck plugin install @community/git-extras
tuck plugin install ./my-local-plugin

# Manage plugins
tuck plugin list
tuck plugin update
tuck plugin remove @community/git-extras
```

**Plugin Types:**
- **Commands** — New tuck commands
- **Validators** — Custom file validators
- **Packages** — Installable terminal tools
- **Recipes** — Configuration bundles
- **Hooks** — Custom pre/post actions

**Plugin Format:**
```typescript
// tuck-plugin.json
{
  "name": "@community/git-extras",
  "version": "1.0.0",
  "description": "Extra git commands and aliases",
  "type": "recipe",
  "main": "index.ts",
  "commands": ["git-extras"],
  "provides": {
    "aliases": 25,
    "functions": 8
  }
}
```

---

### 17. Cross-Machine Real-Time Sync

#### Overview
Optional real-time synchronization across machines without manual git operations.

#### Features

```bash
# Enable sync daemon
tuck sync --daemon

# Status shows sync state
tuck status
# Output includes:
# Sync: ✓ Real-time (3 machines connected)
# Last sync: 2 minutes ago

# Conflict resolution
tuck sync conflicts
# Shows any files with conflicts, offers resolution
```

**How It Works:**
- Background daemon watches for file changes
- Uses WebSocket connection to sync service (optional, self-hostable)
- Automatic conflict detection and resolution
- Falls back to git for offline use

---

### 18. Web Dashboard

#### Overview
A beautiful web interface for managing dotfiles, viewing history, and configuring tuck.

#### Features

```bash
# Start local dashboard
tuck dashboard

# Opens browser to localhost:3847
```

**Dashboard Capabilities:**
- Visual file browser with syntax highlighting
- Diff viewer with side-by-side comparison
- Commit history timeline
- Multi-machine status overview
- Configuration editor
- Recipe browser and installer

---

### 19. Team/Organization Support

#### Overview
Share dotfiles across teams with proper access controls and customization.

#### Features

```bash
# Create team
tuck team create acme-corp

# Share dotfiles with team
tuck team share --file ~/.gitconfig --team acme-corp

# Apply team dotfiles
tuck team apply acme-corp

# Override team settings locally
tuck team customize acme-corp ~/.gitconfig
```

**Use Cases:**
- Company-standard git configuration
- Shared development environment setup
- Onboarding new team members
- Consistent tooling across the organization

---

### 20. AI-Assisted Configuration

#### Overview
Use AI to help configure, troubleshoot, and optimize dotfiles.

#### Features

```bash
# Explain what a config does
tuck ai explain ~/.zshrc

# Get help with an error
tuck ai fix "zsh: command not found: nvim"

# Generate config based on description
tuck ai generate "fast zsh prompt with git status"

# Optimize configuration
tuck ai optimize ~/.zshrc --goal speed
```

**Privacy-First:**
- Runs locally using small LLMs (llama.cpp)
- Optional cloud mode for more capability
- Never sends sensitive data

---

## Contributing

Want to help implement these features? Here's how:

1. **Pick a feature** from this roadmap
2. **Open an issue** to discuss implementation approach
3. **Fork and implement** following the patterns in CLAUDE.md
4. **Submit a PR** with tests

### Priority Order

If you're looking to contribute, these are ordered by impact and complexity:

**Quick Wins (Low complexity, high impact):**
1. **Dotfile Validation** (`tuck validate`) — Catch errors before they break shells
2. **Health Check** (`tuck doctor`) — Comprehensive diagnostics
3. **Enhanced Diff Viewer** — Better visualization

**High Value Features:**
4. **AI Agent Setup** (`tuck agent-setup`) — Growing AI agent adoption
5. **One-Command Install** (`tuck install`) — Beginner-friendly tool installation
6. **Recipe System** — Shareable configurations
7. **Dependency Tracking** (`tuck deps`) — Know what tools your configs need

**Power User Features:**
8. **Profiles System** — Multi-machine configurations
9. **Encryption Support** — Secure sensitive configs
10. **Shell Optimization** (`tuck optimize`) — Speed up terminal startup
11. **Keybinding Analysis** (`tuck keys`) — Find conflicts, discover shortcuts

**Ecosystem Growth:**
12. **Migration Tools** — Import from chezmoi, yadm, stow
13. **Templates** — Machine-specific config generation
14. **Backends** — GitLab, self-hosted, local-only
15. **Plugin System** — Extensible architecture

---

## Timeline

No fixed dates — tuck is developed as time permits. Features are released when they're ready, stable, and well-tested.

**Guiding Principles:**
- Quality over speed
- Security over convenience
- Simplicity over features
- User experience over developer convenience

---

*Last updated: December 2025*
