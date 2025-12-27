import { homedir } from 'os';
import { join } from 'path';

export const VERSION = '0.1.0';
export const DESCRIPTION = 'Modern dotfiles manager with a beautiful CLI';
export const APP_NAME = 'tuck';

export const HOME_DIR = homedir();
export const DEFAULT_TUCK_DIR = join(HOME_DIR, '.tuck');
export const MANIFEST_FILE = '.tuckmanifest.json';
export const CONFIG_FILE = '.tuckrc.json';
export const BACKUP_DIR = join(HOME_DIR, '.tuck-backups');
export const FILES_DIR = 'files';

export const MANIFEST_VERSION = '1.0.0';

export interface CategoryConfig {
  patterns: string[];
  icon: string;
}

export const CATEGORIES: Record<string, CategoryConfig> = {
  shell: {
    patterns: [
      '.zshrc',
      '.bashrc',
      '.bash_profile',
      '.zprofile',
      '.profile',
      '.aliases',
      '.zshenv',
      '.bash_aliases',
      '.inputrc',
    ],
    icon: '🐚',
  },
  git: {
    patterns: ['.gitconfig', '.gitignore_global', '.gitmessage', '.gitattributes'],
    icon: '📦',
  },
  editors: {
    patterns: [
      '.vimrc',
      '.config/nvim',
      '.emacs',
      '.emacs.d',
      '.config/Code',
      '.ideavimrc',
      '.nanorc',
    ],
    icon: '✏️',
  },
  terminal: {
    patterns: [
      '.tmux.conf',
      '.config/alacritty',
      '.config/kitty',
      '.wezterm.lua',
      '.config/wezterm',
      '.config/hyper',
      '.config/starship.toml',
    ],
    icon: '💻',
  },
  ssh: {
    patterns: ['.ssh/config'],
    icon: '🔐',
  },
  misc: {
    patterns: [],
    icon: '📄',
  },
};

export const COMMON_DOTFILES = [
  { path: '~/.zshrc', category: 'shell' },
  { path: '~/.bashrc', category: 'shell' },
  { path: '~/.bash_profile', category: 'shell' },
  { path: '~/.gitconfig', category: 'git' },
  { path: '~/.config/nvim', category: 'editors' },
  { path: '~/.vimrc', category: 'editors' },
  { path: '~/.tmux.conf', category: 'terminal' },
  { path: '~/.ssh/config', category: 'ssh' },
  { path: '~/.config/starship.toml', category: 'terminal' },
];
