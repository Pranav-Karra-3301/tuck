import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Read version from package.json at runtime
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, '..', 'package.json');
let VERSION_VALUE = '1.0.0'; // fallback
try {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  VERSION_VALUE = pkg.version;
} catch {
  // Fallback if package.json can't be read (e.g., bundled)
}
export const VERSION = VERSION_VALUE;
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
    icon: '$',
  },
  git: {
    patterns: ['.gitconfig', '.gitignore_global', '.gitmessage', '.gitattributes'],
    icon: '*',
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
    icon: '>',
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
    icon: '#',
  },
  ssh: {
    patterns: ['.ssh/config'],
    icon: '!',
  },
  misc: {
    patterns: [],
    icon: '-',
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
