import { LineType } from '../styles/theme';

export type TerminalLine = {
  content: string;
  type: LineType;
  duration: number;
  isSpinner?: boolean;
  isTyping?: boolean;
};

// tuck init - shows auto-detection
export const initScript: TerminalLine[] = [
  { content: 'tuck init', type: 'input', duration: 20, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Scanning for dotfiles...', type: 'spinner', duration: 20, isSpinner: true },
  { content: '\u2713  Found 12 dotfiles', type: 'success', duration: 14 },
  { content: '', type: 'empty', duration: 6 },
  { content: '   $ shell: 4    \u2605 git: 2    \u203a editors: 3', type: 'dim', duration: 18 },
  { content: '   # terminal: 2    \u25cf misc: 1', type: 'dim', duration: 18 },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Initializing repository...', type: 'spinner', duration: 18, isSpinner: true },
  { content: '\u2713  Created ~/.tuck', type: 'success', duration: 12 },
  { content: '\u2713  Pushed to github.com/you/dotfiles', type: 'success', duration: 16 },
];

// tuck sync - THE hero command - make it very clear
export const syncScript: TerminalLine[] = [
  { content: 'tuck sync', type: 'input', duration: 18, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Pulling latest...', type: 'spinner', duration: 14, isSpinner: true },
  { content: '\u2713  Up to date', type: 'success', duration: 10 },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Detecting changes...', type: 'spinner', duration: 14, isSpinner: true },
  { content: '\u2713  3 files modified', type: 'success', duration: 10 },
  { content: '   ~ ~/.zshrc', type: 'yellow', duration: 10 },
  { content: '   ~ ~/.gitconfig', type: 'yellow', duration: 10 },
  { content: '   ~ ~/.vimrc', type: 'yellow', duration: 10 },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Committing...', type: 'spinner', duration: 12, isSpinner: true },
  { content: '\u2713  Committed', type: 'success', duration: 10 },
  { content: '\u25d0  Pushing...', type: 'spinner', duration: 12, isSpinner: true },
  { content: '\u2713  Pushed to origin/main', type: 'success', duration: 12 },
  { content: '', type: 'empty', duration: 8 },
  { content: '\u2713  All synced!', type: 'success', duration: 20 },
];

// tuck apply - get anyone's dotfiles
export const applyScript: TerminalLine[] = [
  { content: 'tuck apply mathiasbynens', type: 'input', duration: 28, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Fetching dotfiles...', type: 'spinner', duration: 16, isSpinner: true },
  { content: '\u2713  Downloaded 23 configs', type: 'success', duration: 12 },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Backing up your files...', type: 'spinner', duration: 14, isSpinner: true },
  { content: '\u2713  Backup created', type: 'success', duration: 10 },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Smart merging...', type: 'spinner', duration: 16, isSpinner: true },
  { content: '\u2713  Applied! Your customizations preserved.', type: 'success', duration: 18 },
];

// tuck secrets scan
export const secretsScript: TerminalLine[] = [
  { content: 'tuck secrets scan', type: 'input', duration: 22, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Scanning files...', type: 'spinner', duration: 14, isSpinner: true },
  { content: '\u2713  No secrets in tracked files', type: 'success', duration: 12 },
  { content: '\u25d0  Scanning git history...', type: 'spinner', duration: 14, isSpinner: true },
  { content: '\u2713  Git history clean', type: 'success', duration: 12 },
];

// tuck undo
export const undoScript: TerminalLine[] = [
  { content: 'tuck undo --latest', type: 'input', duration: 22, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '\u25d0  Restoring from snapshot...', type: 'spinner', duration: 16, isSpinner: true },
  { content: '\u2713  Restored from 2 hours ago', type: 'success', duration: 14 },
];

// tuck status
export const statusScript: TerminalLine[] = [
  { content: 'tuck status', type: 'input', duration: 16, isTyping: true },
  { content: '', type: 'empty', duration: 6 },
  { content: '  Tracking 9 files across 4 categories', type: 'output', duration: 14 },
  { content: '  \u2713 In sync with origin/main', type: 'success', duration: 12 },
  { content: '  Last sync: 5 minutes ago', type: 'dim', duration: 12 },
];
