# Windows Support (Beta)

This branch contains experimental Windows support for tuck. It is currently in beta and needs testing on actual Windows machines.

## What's New

### Windows Path Handling

- Supports `~/`, `~\`, `$HOME/`, `$HOME\`, and `%USERPROFILE%` path prefixes
- Normalizes paths internally for cross-platform manifest compatibility
- Manifests use `~` prefix which expands correctly on both Unix and Windows

### Symlink Strategy

- **Directories**: Uses Windows junctions (no admin privileges required)
- **Files**: Uses symlinks (may require Developer Mode or Administrator)
- Clear error messages when permissions are insufficient

### Auto-Detected Windows Config Files

On Windows, `tuck scan` will automatically detect:

| Category  | File                                                                      |
| --------- | ------------------------------------------------------------------------- |
| Shell     | `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` (PS 7+)         |
| Shell     | `~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1` (PS 5.x) |
| Terminal  | Windows Terminal settings (`%LOCALAPPDATA%`)                              |
| Editors   | VS Code settings, keybindings, snippets (`%APPDATA%\Code`)                |
| Editors   | Cursor settings (`%APPDATA%\Cursor`)                                      |
| Git       | `~/.gitconfig`                                                            |
| SSH       | `~/.ssh/config`                                                           |
| Languages | `~/.npmrc`, `~/.cargo/config.toml`                                        |
| Prompt    | `~/.config/starship.toml`                                                 |

### Permissions

- `chmod` operations are skipped on Windows (different security model)
- SSH/GPG file permission fixes are no-ops on Windows

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm 9+
- Git

### Install Dependencies

```bash
git clone https://github.com/Pranav-Karra-3301/tuck.git
cd tuck
git checkout windows
pnpm install
```

### Build

```bash
pnpm build
```

### Run Tests

```bash
pnpm test
```

### Run Locally

```bash
# On Windows (PowerShell)
node dist/index.js --help
node dist/index.js init
node dist/index.js scan

# Add a file
node dist/index.js add $env:USERPROFILE\.gitconfig
```

## Testing Checklist

Please test the following scenarios on Windows and report issues:

### Basic Operations

- [ ] `tuck init` creates `~/.tuck` directory
- [ ] `tuck scan` detects Windows-specific config files
- [ ] `tuck add <file>` works with Windows paths
- [ ] `tuck status` shows tracked files correctly
- [ ] `tuck sync` commits changes
- [ ] `tuck list` shows files with proper paths

### Path Handling

- [ ] Paths with backslashes work (`~\.gitconfig`)
- [ ] Paths with forward slashes work (`~/.gitconfig`)
- [ ] `%USERPROFILE%` expansion works
- [ ] Mixed separators work (`~/.config\starship.toml`)

### Symlinks

- [ ] Directory symlinks/junctions work without admin
- [ ] File symlinks work (may need Developer Mode)
- [ ] Error messages are clear when permissions are denied

### Specific Files

- [ ] PowerShell profile detection works
- [ ] Windows Terminal settings detection works
- [ ] VS Code settings in `%APPDATA%` are detected
- [ ] Git config in home directory works

### Cross-Platform

- [ ] Manifest created on Windows can be read on Unix
- [ ] Manifest created on Unix can be read on Windows
- [ ] `tuck apply <user>` works to apply dotfiles from Unix repo

## Known Limitations

1. **Symlinks may require elevated privileges**: Windows symlinks for files require either:
   - Developer Mode enabled, OR
   - Running as Administrator
   - Directories use junctions which don't have this limitation

2. **No chmod support**: File permissions work differently on Windows (ACLs). Permission-related operations are skipped.

3. **Some Unix dotfiles won't exist**: Files like `.bashrc`, `.zshrc` won't exist on Windows unless you have WSL or Git Bash.

## Reporting Issues

When reporting issues, please include:

1. Windows version (e.g., Windows 11 23H2)
2. PowerShell version (`$PSVersionTable.PSVersion`)
3. Node.js version (`node --version`)
4. Full error message and stack trace
5. Steps to reproduce

Create issues at: https://github.com/Pranav-Karra-3301/tuck/issues

Tag issues with `windows-beta` label.

## Files Changed

This beta includes changes to:

| File                     | Description                                |
| ------------------------ | ------------------------------------------ |
| `src/lib/platform.ts`    | NEW: Platform detection and path utilities |
| `src/lib/paths.ts`       | Windows path expansion support             |
| `src/lib/files.ts`       | Junction support, skip chmod on Windows    |
| `src/lib/detect.ts`      | Windows dotfile patterns                   |
| `src/lib/backup.ts`      | Cross-platform path handling               |
| `src/lib/timemachine.ts` | Cross-platform path handling               |
| `src/lib/manifest.ts`    | Path normalization for comparison          |
| `src/lib/merge.ts`       | Cross-platform basename handling           |
| `src/commands/add.ts`    | Path normalization in security checks      |
| `src/commands/apply.ts`  | Skip chmod on Windows                      |
| `src/constants.ts`       | Windows common dotfiles                    |
