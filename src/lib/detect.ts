import { join, basename } from 'path';
import { readdir, stat } from 'fs/promises';
import { platform } from 'os';
import { pathExists, expandPath } from './paths.js';

const IS_MACOS = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

export interface DetectedFile {
  path: string;
  name: string;
  category: string;
  description: string;
  isDirectory: boolean;
  size?: number;
  sensitive?: boolean;
  exclude?: string[]; // Patterns to exclude within directories
}

export interface DetectionCategory {
  name: string;
  icon: string;
  description: string;
}

export const DETECTION_CATEGORIES: Record<string, DetectionCategory> = {
  shell: {
    name: 'Shell Configuration',
    icon: '🐚',
    description: 'Shell configs, aliases, functions, and environment',
  },
  git: {
    name: 'Git Configuration',
    icon: '📦',
    description: 'Git settings, aliases, and global ignores',
  },
  editors: {
    name: 'Editors & IDEs',
    icon: '✏️',
    description: 'Editor configurations and settings',
  },
  terminal: {
    name: 'Terminal & Multiplexers',
    icon: '💻',
    description: 'Terminal emulators and tmux/screen',
  },
  prompt: {
    name: 'Prompt & Theme',
    icon: '🎨',
    description: 'Shell prompts, themes, and color schemes',
  },
  cli: {
    name: 'CLI Tools',
    icon: '🔧',
    description: 'Command-line tool configurations',
  },
  languages: {
    name: 'Languages & Package Managers',
    icon: '📚',
    description: 'Programming language and package manager configs',
  },
  ssh: {
    name: 'SSH & Security',
    icon: '🔐',
    description: 'SSH config and GPG settings (no private keys)',
  },
  xdg: {
    name: 'XDG Config Apps',
    icon: '⚙️',
    description: 'Applications using ~/.config standard',
  },
  desktop: {
    name: 'Desktop & Window Managers',
    icon: '🖥️',
    description: 'Window managers and desktop environment configs',
  },
  scripts: {
    name: 'Scripts & Bins',
    icon: '📜',
    description: 'Custom scripts and local binaries',
  },
  macos: {
    name: 'macOS Specific',
    icon: '🍎',
    description: 'macOS-specific configurations',
  },
  misc: {
    name: 'Miscellaneous',
    icon: '📄',
    description: 'Other configuration files',
  },
};

/**
 * Comprehensive list of dotfiles to detect
 */
const DOTFILE_PATTERNS: Array<{
  path: string;
  category: string;
  description: string;
  sensitive?: boolean;
  exclude?: string[];
  platform?: 'darwin' | 'linux' | 'all';
}> = [
  // ==================== SHELL CONFIGURATION ====================
  // Bash
  { path: '~/.bashrc', category: 'shell', description: 'Bash interactive shell config' },
  { path: '~/.bash_profile', category: 'shell', description: 'Bash login shell config' },
  { path: '~/.bash_aliases', category: 'shell', description: 'Bash aliases' },
  { path: '~/.bash_functions', category: 'shell', description: 'Bash functions' },
  { path: '~/.bash_logout', category: 'shell', description: 'Bash logout script' },

  // Zsh
  { path: '~/.zshrc', category: 'shell', description: 'Zsh interactive shell config' },
  { path: '~/.zprofile', category: 'shell', description: 'Zsh login shell config' },
  { path: '~/.zshenv', category: 'shell', description: 'Zsh environment variables' },
  { path: '~/.zlogin', category: 'shell', description: 'Zsh login script' },
  { path: '~/.zlogout', category: 'shell', description: 'Zsh logout script' },
  { path: '~/.zsh', category: 'shell', description: 'Zsh configuration directory' },

  // Fish
  { path: '~/.config/fish/config.fish', category: 'shell', description: 'Fish shell config' },
  { path: '~/.config/fish/functions', category: 'shell', description: 'Fish functions' },
  { path: '~/.config/fish/completions', category: 'shell', description: 'Fish completions' },
  { path: '~/.config/fish/conf.d', category: 'shell', description: 'Fish config snippets' },

  // Generic shell
  { path: '~/.profile', category: 'shell', description: 'Generic shell profile' },
  { path: '~/.aliases', category: 'shell', description: 'Shell aliases' },
  { path: '~/.functions', category: 'shell', description: 'Shell functions' },
  { path: '~/.exports', category: 'shell', description: 'Environment exports' },
  { path: '~/.inputrc', category: 'shell', description: 'Readline configuration' },
  { path: '~/.hushlogin', category: 'shell', description: 'Suppress login message' },

  // ==================== GIT CONFIGURATION ====================
  { path: '~/.gitconfig', category: 'git', description: 'Git global configuration' },
  { path: '~/.gitignore_global', category: 'git', description: 'Global gitignore patterns' },
  { path: '~/.gitignore', category: 'git', description: 'Global gitignore (alt location)' },
  { path: '~/.gitmessage', category: 'git', description: 'Git commit message template' },
  { path: '~/.gitattributes', category: 'git', description: 'Git attributes' },
  { path: '~/.config/git/config', category: 'git', description: 'Git XDG config' },
  { path: '~/.config/git/ignore', category: 'git', description: 'Git XDG ignore' },
  { path: '~/.config/gh', category: 'git', description: 'GitHub CLI config' },
  { path: '~/.config/hub', category: 'git', description: 'Hub CLI config' },

  // ==================== EDITORS & IDES ====================
  // Vim/Neovim
  { path: '~/.vimrc', category: 'editors', description: 'Vim configuration' },
  { path: '~/.vim', category: 'editors', description: 'Vim directory', exclude: ['plugged', 'bundle', '.netrwhist'] },
  { path: '~/.config/nvim', category: 'editors', description: 'Neovim configuration' },
  { path: '~/.ideavimrc', category: 'editors', description: 'IdeaVim (JetBrains) config' },

  // Emacs
  { path: '~/.emacs', category: 'editors', description: 'Emacs configuration' },
  { path: '~/.emacs.d/init.el', category: 'editors', description: 'Emacs init file' },
  { path: '~/.doom.d', category: 'editors', description: 'Doom Emacs config' },
  { path: '~/.spacemacs', category: 'editors', description: 'Spacemacs config' },

  // VS Code
  { path: '~/.config/Code/User/settings.json', category: 'editors', description: 'VS Code settings', platform: 'linux' },
  { path: '~/.config/Code/User/keybindings.json', category: 'editors', description: 'VS Code keybindings', platform: 'linux' },
  { path: '~/.config/Code/User/snippets', category: 'editors', description: 'VS Code snippets', platform: 'linux' },
  { path: '~/Library/Application Support/Code/User/settings.json', category: 'editors', description: 'VS Code settings', platform: 'darwin' },
  { path: '~/Library/Application Support/Code/User/keybindings.json', category: 'editors', description: 'VS Code keybindings', platform: 'darwin' },
  { path: '~/Library/Application Support/Code/User/snippets', category: 'editors', description: 'VS Code snippets', platform: 'darwin' },

  // Cursor (VS Code fork)
  { path: '~/.config/Cursor/User/settings.json', category: 'editors', description: 'Cursor settings', platform: 'linux' },
  { path: '~/Library/Application Support/Cursor/User/settings.json', category: 'editors', description: 'Cursor settings', platform: 'darwin' },

  // Other editors
  { path: '~/.nanorc', category: 'editors', description: 'Nano configuration' },
  { path: '~/.config/micro', category: 'editors', description: 'Micro editor config' },
  { path: '~/.config/helix', category: 'editors', description: 'Helix editor config' },
  { path: '~/.sublime-text/Packages/User', category: 'editors', description: 'Sublime Text settings' },

  // ==================== TERMINAL & MULTIPLEXERS ====================
  // Tmux
  { path: '~/.tmux.conf', category: 'terminal', description: 'Tmux configuration' },
  { path: '~/.tmux', category: 'terminal', description: 'Tmux directory' },
  { path: '~/.config/tmux/tmux.conf', category: 'terminal', description: 'Tmux XDG config' },

  // Screen
  { path: '~/.screenrc', category: 'terminal', description: 'GNU Screen configuration' },

  // Terminal emulators
  { path: '~/.config/alacritty', category: 'terminal', description: 'Alacritty terminal config' },
  { path: '~/.config/kitty', category: 'terminal', description: 'Kitty terminal config' },
  { path: '~/.config/wezterm', category: 'terminal', description: 'WezTerm config' },
  { path: '~/.wezterm.lua', category: 'terminal', description: 'WezTerm config (alt)' },
  { path: '~/.config/hyper', category: 'terminal', description: 'Hyper terminal config' },
  { path: '~/.hyper.js', category: 'terminal', description: 'Hyper terminal config (alt)' },
  { path: '~/.config/foot', category: 'terminal', description: 'Foot terminal config' },
  { path: '~/.config/terminator', category: 'terminal', description: 'Terminator config' },
  { path: '~/.config/tilix', category: 'terminal', description: 'Tilix terminal config' },
  { path: '~/Library/Preferences/com.googlecode.iterm2.plist', category: 'terminal', description: 'iTerm2 preferences', platform: 'darwin' },

  // ==================== PROMPT & THEMES ====================
  { path: '~/.config/starship.toml', category: 'prompt', description: 'Starship prompt config' },
  { path: '~/.p10k.zsh', category: 'prompt', description: 'Powerlevel10k config' },
  { path: '~/.oh-my-zsh/custom', category: 'prompt', description: 'Oh My Zsh customizations' },
  { path: '~/.config/powerline', category: 'prompt', description: 'Powerline config' },
  { path: '~/.dir_colors', category: 'prompt', description: 'Directory colors' },
  { path: '~/.dircolors', category: 'prompt', description: 'Directory colors (alt)' },

  // ==================== CLI TOOLS ====================
  // Search & navigation
  { path: '~/.config/ripgrep', category: 'cli', description: 'Ripgrep config' },
  { path: '~/.ripgreprc', category: 'cli', description: 'Ripgrep config (alt)' },
  { path: '~/.rgrc', category: 'cli', description: 'Ripgrep config (short)' },
  { path: '~/.config/fd', category: 'cli', description: 'fd find config' },
  { path: '~/.fdignore', category: 'cli', description: 'fd ignore patterns' },
  { path: '~/.config/bat', category: 'cli', description: 'bat (better cat) config' },
  { path: '~/.config/lsd', category: 'cli', description: 'lsd (better ls) config' },
  { path: '~/.config/exa', category: 'cli', description: 'exa config' },
  { path: '~/.config/eza', category: 'cli', description: 'eza config' },

  // Fuzzy finders
  { path: '~/.fzf.zsh', category: 'cli', description: 'fzf Zsh integration' },
  { path: '~/.fzf.bash', category: 'cli', description: 'fzf Bash integration' },
  { path: '~/.config/fzf', category: 'cli', description: 'fzf config directory' },

  // Network tools
  { path: '~/.curlrc', category: 'cli', description: 'curl configuration' },
  { path: '~/.wgetrc', category: 'cli', description: 'wget configuration' },
  { path: '~/.netrc', category: 'cli', description: 'Network credentials', sensitive: true },
  { path: '~/.config/aria2', category: 'cli', description: 'aria2 download manager' },

  // System monitoring
  { path: '~/.config/htop', category: 'cli', description: 'htop config' },
  { path: '~/.config/btop', category: 'cli', description: 'btop config' },
  { path: '~/.config/bottom', category: 'cli', description: 'bottom config' },
  { path: '~/.config/glances', category: 'cli', description: 'Glances config' },

  // Other CLI tools
  { path: '~/.config/lazygit', category: 'cli', description: 'Lazygit config' },
  { path: '~/.config/lazydocker', category: 'cli', description: 'Lazydocker config' },
  { path: '~/.config/ranger', category: 'cli', description: 'Ranger file manager' },
  { path: '~/.config/lf', category: 'cli', description: 'lf file manager' },
  { path: '~/.config/yazi', category: 'cli', description: 'Yazi file manager' },
  { path: '~/.config/nnn', category: 'cli', description: 'nnn file manager' },
  { path: '~/.config/zoxide', category: 'cli', description: 'zoxide (smart cd)' },
  { path: '~/.config/atuin', category: 'cli', description: 'Atuin shell history' },
  { path: '~/.config/thefuck', category: 'cli', description: 'thefuck config' },
  { path: '~/.config/direnv', category: 'cli', description: 'direnv config' },
  { path: '~/.direnvrc', category: 'cli', description: 'direnv config (alt)' },
  { path: '~/.ackrc', category: 'cli', description: 'ack search config' },
  { path: '~/.agignore', category: 'cli', description: 'silver searcher ignore' },
  { path: '~/.editorconfig', category: 'cli', description: 'EditorConfig' },

  // ==================== LANGUAGES & PACKAGE MANAGERS ====================
  // Node.js
  { path: '~/.npmrc', category: 'languages', description: 'npm configuration' },
  { path: '~/.yarnrc', category: 'languages', description: 'Yarn configuration' },
  { path: '~/.config/yarn', category: 'languages', description: 'Yarn config directory' },
  { path: '~/.bunfig.toml', category: 'languages', description: 'Bun configuration' },
  { path: '~/.nvmrc', category: 'languages', description: 'nvm default version' },
  { path: '~/.node-version', category: 'languages', description: 'Node version file' },

  // Python
  { path: '~/.config/pip', category: 'languages', description: 'pip configuration' },
  { path: '~/.pip', category: 'languages', description: 'pip config (legacy)' },
  { path: '~/.pypirc', category: 'languages', description: 'PyPI configuration', sensitive: true },
  { path: '~/.python-version', category: 'languages', description: 'pyenv version' },
  { path: '~/.config/flake8', category: 'languages', description: 'Flake8 config' },
  { path: '~/.config/black', category: 'languages', description: 'Black formatter' },
  { path: '~/.config/ruff', category: 'languages', description: 'Ruff linter' },
  { path: '~/.pylintrc', category: 'languages', description: 'Pylint config' },
  { path: '~/.config/pypoetry', category: 'languages', description: 'Poetry config' },
  { path: '~/.config/pdm', category: 'languages', description: 'PDM config' },

  // Ruby
  { path: '~/.gemrc', category: 'languages', description: 'RubyGems configuration' },
  { path: '~/.irbrc', category: 'languages', description: 'IRB configuration' },
  { path: '~/.pryrc', category: 'languages', description: 'Pry configuration' },
  { path: '~/.ruby-version', category: 'languages', description: 'Ruby version file' },
  { path: '~/.bundle/config', category: 'languages', description: 'Bundler config' },

  // Rust
  { path: '~/.cargo/config.toml', category: 'languages', description: 'Cargo configuration' },
  { path: '~/.cargo/config', category: 'languages', description: 'Cargo config (legacy)' },
  { path: '~/.rustfmt.toml', category: 'languages', description: 'rustfmt config' },

  // Go
  { path: '~/.config/go', category: 'languages', description: 'Go configuration' },

  // Java/JVM
  { path: '~/.gradle/gradle.properties', category: 'languages', description: 'Gradle properties' },
  { path: '~/.m2/settings.xml', category: 'languages', description: 'Maven settings' },
  { path: '~/.sbt', category: 'languages', description: 'SBT config' },

  // Docker
  { path: '~/.docker/config.json', category: 'languages', description: 'Docker config' },

  // Kubernetes
  { path: '~/.kube/config', category: 'languages', description: 'kubectl config', sensitive: true },

  // Cloud
  { path: '~/.aws/config', category: 'languages', description: 'AWS CLI config' },
  { path: '~/.config/gcloud', category: 'languages', description: 'Google Cloud config' },

  // ==================== SSH & SECURITY ====================
  {
    path: '~/.ssh/config',
    category: 'ssh',
    description: 'SSH client configuration',
    sensitive: true,
  },
  {
    path: '~/.ssh/known_hosts',
    category: 'ssh',
    description: 'SSH known hosts',
  },
  {
    path: '~/.ssh/authorized_keys',
    category: 'ssh',
    description: 'Authorized SSH keys',
  },
  {
    path: '~/.ssh/rc',
    category: 'ssh',
    description: 'SSH connection script',
  },
  {
    path: '~/.gnupg/gpg.conf',
    category: 'ssh',
    description: 'GPG configuration',
    sensitive: true,
  },
  {
    path: '~/.gnupg/gpg-agent.conf',
    category: 'ssh',
    description: 'GPG agent configuration',
  },

  // ==================== XDG CONFIG APPS ====================
  { path: '~/.config/fontconfig', category: 'xdg', description: 'Font configuration' },
  { path: '~/.config/gtk-3.0', category: 'xdg', description: 'GTK3 settings' },
  { path: '~/.config/gtk-4.0', category: 'xdg', description: 'GTK4 settings' },
  { path: '~/.config/qt5ct', category: 'xdg', description: 'Qt5 settings' },
  { path: '~/.config/mimeapps.list', category: 'xdg', description: 'Default applications' },
  { path: '~/.config/user-dirs.dirs', category: 'xdg', description: 'XDG user directories' },
  { path: '~/.config/autostart', category: 'xdg', description: 'Autostart applications' },
  { path: '~/.config/environment.d', category: 'xdg', description: 'Environment variables' },
  { path: '~/.config/systemd/user', category: 'xdg', description: 'User systemd services', platform: 'linux' },
  { path: '~/.config/dunst', category: 'xdg', description: 'Dunst notifications', platform: 'linux' },
  { path: '~/.config/rofi', category: 'xdg', description: 'Rofi launcher', platform: 'linux' },
  { path: '~/.config/wofi', category: 'xdg', description: 'Wofi launcher', platform: 'linux' },

  // ==================== DESKTOP & WINDOW MANAGERS ====================
  // i3/sway
  { path: '~/.config/i3', category: 'desktop', description: 'i3 window manager', platform: 'linux' },
  { path: '~/.config/sway', category: 'desktop', description: 'Sway (Wayland i3)', platform: 'linux' },
  { path: '~/.config/i3status', category: 'desktop', description: 'i3status bar', platform: 'linux' },
  { path: '~/.config/i3status-rust', category: 'desktop', description: 'i3status-rust bar', platform: 'linux' },
  { path: '~/.config/waybar', category: 'desktop', description: 'Waybar', platform: 'linux' },
  { path: '~/.config/polybar', category: 'desktop', description: 'Polybar', platform: 'linux' },

  // Hyprland
  { path: '~/.config/hypr', category: 'desktop', description: 'Hyprland config', platform: 'linux' },

  // Other WMs
  { path: '~/.config/bspwm', category: 'desktop', description: 'bspwm config', platform: 'linux' },
  { path: '~/.config/sxhkd', category: 'desktop', description: 'sxhkd hotkeys', platform: 'linux' },
  { path: '~/.config/awesome', category: 'desktop', description: 'AwesomeWM config', platform: 'linux' },
  { path: '~/.config/openbox', category: 'desktop', description: 'Openbox config', platform: 'linux' },
  { path: '~/.config/qtile', category: 'desktop', description: 'Qtile config', platform: 'linux' },
  { path: '~/.config/herbstluftwm', category: 'desktop', description: 'herbstluftwm config', platform: 'linux' },

  // macOS window managers
  { path: '~/.yabairc', category: 'desktop', description: 'yabai config', platform: 'darwin' },
  { path: '~/.config/yabai', category: 'desktop', description: 'yabai config (XDG)', platform: 'darwin' },
  { path: '~/.skhdrc', category: 'desktop', description: 'skhd hotkeys', platform: 'darwin' },
  { path: '~/.config/skhd', category: 'desktop', description: 'skhd config (XDG)', platform: 'darwin' },
  { path: '~/.config/spacebar', category: 'desktop', description: 'spacebar config', platform: 'darwin' },
  { path: '~/.config/borders', category: 'desktop', description: 'borders config', platform: 'darwin' },
  { path: '~/.aerospace.toml', category: 'desktop', description: 'AeroSpace config', platform: 'darwin' },

  // Picom/Compton
  { path: '~/.config/picom', category: 'desktop', description: 'Picom compositor', platform: 'linux' },
  { path: '~/.config/picom.conf', category: 'desktop', description: 'Picom config (alt)', platform: 'linux' },

  // ==================== SCRIPTS & BINS ====================
  { path: '~/.local/bin', category: 'scripts', description: 'Local scripts and binaries' },
  { path: '~/bin', category: 'scripts', description: 'User bin directory' },
  { path: '~/.scripts', category: 'scripts', description: 'Custom scripts' },

  // ==================== MACOS SPECIFIC ====================
  { path: '~/.finicky.js', category: 'macos', description: 'Finicky browser picker', platform: 'darwin' },
  { path: '~/.config/karabiner', category: 'macos', description: 'Karabiner key remapping', platform: 'darwin' },
  { path: '~/.hammerspoon', category: 'macos', description: 'Hammerspoon automation', platform: 'darwin' },
  { path: '~/.config/raycast', category: 'macos', description: 'Raycast config', platform: 'darwin' },

  // ==================== MISCELLANEOUS ====================
  { path: '~/.config/neofetch', category: 'misc', description: 'Neofetch config' },
  { path: '~/.config/fastfetch', category: 'misc', description: 'Fastfetch config' },
  { path: '~/.config/onefetch', category: 'misc', description: 'Onefetch config' },
  { path: '~/.config/topgrade.toml', category: 'misc', description: 'Topgrade updater' },
  { path: '~/.config/youtube-dl', category: 'misc', description: 'youtube-dl config' },
  { path: '~/.config/yt-dlp', category: 'misc', description: 'yt-dlp config' },
  { path: '~/.config/mpv', category: 'misc', description: 'MPV media player' },
  { path: '~/.config/newsboat', category: 'misc', description: 'Newsboat RSS reader' },
  { path: '~/.config/cmus', category: 'misc', description: 'cmus music player' },
  { path: '~/.config/spotify-tui', category: 'misc', description: 'Spotify TUI' },
  { path: '~/.mailcap', category: 'misc', description: 'MIME type handlers' },
  { path: '~/.muttrc', category: 'misc', description: 'Mutt email client' },
  { path: '~/.config/mutt', category: 'misc', description: 'Mutt config directory' },
  { path: '~/.config/neomutt', category: 'misc', description: 'Neomutt config' },
  { path: '~/.Xresources', category: 'misc', description: 'X11 resources', platform: 'linux' },
  { path: '~/.Xmodmap', category: 'misc', description: 'X11 keymap', platform: 'linux' },
  { path: '~/.xinitrc', category: 'misc', description: 'X11 init script', platform: 'linux' },
  { path: '~/.xprofile', category: 'misc', description: 'X11 profile', platform: 'linux' },
];

/**
 * Check if a path should be included for current platform
 */
const shouldIncludeForPlatform = (item: { platform?: string }): boolean => {
  if (!item.platform || item.platform === 'all') return true;
  if (item.platform === 'darwin' && IS_MACOS) return true;
  if (item.platform === 'linux' && IS_LINUX) return true;
  return false;
};

/**
 * Get file/directory size
 */
const getSize = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await stat(path);
    return stats.size;
  } catch {
    return undefined;
  }
};

/**
 * Check if path is a directory
 */
const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Scan system for existing dotfiles
 */
export const detectDotfiles = async (): Promise<DetectedFile[]> => {
  const detected: DetectedFile[] = [];

  for (const pattern of DOTFILE_PATTERNS) {
    // Skip if not for current platform
    if (!shouldIncludeForPlatform(pattern)) continue;

    const fullPath = expandPath(pattern.path);

    if (await pathExists(fullPath)) {
      const isDir = await isDirectory(fullPath);
      const size = await getSize(fullPath);

      detected.push({
        path: pattern.path,
        name: basename(pattern.path),
        category: pattern.category,
        description: pattern.description,
        isDirectory: isDir,
        size,
        sensitive: pattern.sensitive,
        exclude: pattern.exclude,
      });
    }
  }

  return detected;
};

/**
 * Group detected files by category
 */
export const groupByCategory = (
  files: DetectedFile[]
): Record<string, DetectedFile[]> => {
  const grouped: Record<string, DetectedFile[]> = {};

  for (const file of files) {
    if (!grouped[file.category]) {
      grouped[file.category] = [];
    }
    grouped[file.category].push(file);
  }

  return grouped;
};

/**
 * Get SSH files that are safe to backup (no private keys)
 */
export const getSafeSSHFiles = async (): Promise<string[]> => {
  const sshDir = expandPath('~/.ssh');
  const safeFiles: string[] = [];

  if (!(await pathExists(sshDir))) {
    return safeFiles;
  }

  try {
    const entries = await readdir(sshDir);

    for (const entry of entries) {
      // Skip private keys and other sensitive files
      if (
        entry.endsWith('.pub') ||
        entry === 'config' ||
        entry === 'known_hosts' ||
        entry === 'authorized_keys' ||
        entry === 'rc' ||
        entry === 'environment'
      ) {
        safeFiles.push(join('~/.ssh', entry));
      }
    }
  } catch {
    // Ignore errors
  }

  return safeFiles;
};

/**
 * Format file size for display
 */
export const formatSize = (bytes: number | undefined): string => {
  if (bytes === undefined) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

/**
 * Get count of files in each category
 */
export const getCategoryCounts = (
  files: DetectedFile[]
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const file of files) {
    counts[file.category] = (counts[file.category] || 0) + 1;
  }

  return counts;
};
