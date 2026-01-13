/**
 * Design System for tuck CLI
 * Centralized design tokens, colors, icons, and helpers
 */

import chalk from 'chalk';
import figures from 'figures';
import logSymbols from 'log-symbols';

// ─────────────────────────────────────────────────────────────────────────────
// Layout Constants
// ─────────────────────────────────────────────────────────────────────────────

export const TERMINAL_WIDTH = 100;
export const CONTENT_WIDTH = 80;
export const DIVIDER_WIDTH = 60;
export const INDENT = '  ';

// ─────────────────────────────────────────────────────────────────────────────
// Colors (semantic naming)
// ─────────────────────────────────────────────────────────────────────────────

export const colors = {
  // Brand
  brand: chalk.cyan,
  brandBold: chalk.bold.cyan,
  brandDim: chalk.dim.cyan,
  brandBg: chalk.bgCyan.black,

  // Status
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,

  // Text
  muted: chalk.dim,
  bold: chalk.bold,
  highlight: chalk.bold.white,

  // Direct color aliases (for compatibility)
  cyan: chalk.cyan,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
  dim: chalk.dim,
  white: chalk.white,
};

// Shorthand alias
export const c = colors;

// ─────────────────────────────────────────────────────────────────────────────
// Icons (with automatic Unicode fallbacks via figures)
// ─────────────────────────────────────────────────────────────────────────────

export const icons = {
  // Status icons (colored, from log-symbols)
  success: logSymbols.success,
  error: logSymbols.error,
  warning: logSymbols.warning,
  info: logSymbols.info,

  // Action icons (from figures - auto fallback)
  tick: figures.tick,
  cross: figures.cross,
  pointer: figures.pointer,
  arrowRight: figures.arrowRight,
  arrowDown: figures.arrowDown,
  arrowUp: figures.arrowUp,

  // Progress icons
  circle: figures.circle,
  circleFilled: figures.circleFilled,
  bullet: figures.bullet,
  ellipsis: figures.ellipsis,

  // File operations
  add: c.success(figures.tick),
  remove: c.error(figures.cross),
  modify: c.warning('~'),
  sync: c.brand(figures.arrowRight),

  // Tree/structure
  line: figures.line,
  corner: figures.lineDownRight,
  tee: figures.lineDownRightArc,

  // Category icons
  shell: '$',
  git: figures.star,
  editors: figures.pointer,
  terminal: '#',
  ssh: figures.warning,
  misc: figures.bullet,
};

// ─────────────────────────────────────────────────────────────────────────────
// Category Configuration (icons + colors)
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryStyle {
  icon: string;
  color: typeof chalk;
}

export const categoryStyles: Record<string, CategoryStyle> = {
  shell: { icon: '$', color: c.success },
  git: { icon: figures.star, color: c.warning },
  editors: { icon: figures.pointer, color: c.brand },
  terminal: { icon: '#', color: c.info },
  ssh: { icon: figures.warning, color: c.error },
  misc: { icon: figures.bullet, color: c.muted },
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a horizontal divider line */
export const divider = (width = DIVIDER_WIDTH): string => c.muted('─'.repeat(width));

/** Create indentation */
export const indent = (level = 1): string => INDENT.repeat(level);

/** Print a blank line */
export const spacer = (): void => {
  console.log();
};

// ─────────────────────────────────────────────────────────────────────────────
// Text Formatting Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format a file path with brand color */
export const formatPath = (path: string): string => c.brand(path);

/** Format a count with proper pluralization: "3 files" */
export const formatCount = (n: number, singular: string, plural?: string): string => {
  const word = n === 1 ? singular : plural || `${singular}s`;
  return `${c.bold(n.toString())} ${word}`;
};

/** Format a category with its icon */
export const formatCategory = (category: string): string => {
  const style = categoryStyles[category] || categoryStyles.misc;
  return `${style.color(style.icon)} ${category}`;
};

/** Format a status string with appropriate color */
export const formatStatus = (status: string): string => {
  switch (status) {
    case 'added':
      return c.success(status);
    case 'modified':
      return c.warning(status);
    case 'deleted':
      return c.error(status);
    default:
      return c.muted(status);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Message Helpers (concise, consistent)
// ─────────────────────────────────────────────────────────────────────────────

/** Format a hint message (dimmed, for secondary info) */
export const hint = (message: string): string => c.muted(message);

/** Format a command suggestion */
export const cmd = (command: string): string => c.brand(`'${command}'`);

/** Print a section header */
export const sectionHeader = (title: string): void => {
  console.log();
  console.log(c.brandBold(title));
  console.log(divider());
};

// ─────────────────────────────────────────────────────────────────────────────
// Progress Display Modes
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressMode = 'detailed' | 'compact' | 'minimal';

/** Determine the best progress display mode based on item count */
export const getProgressMode = (itemCount: number): ProgressMode => {
  if (itemCount <= 20) return 'detailed';
  if (itemCount <= 100) return 'compact';
  return 'minimal';
};

// ─────────────────────────────────────────────────────────────────────────────
// Box Styles (for boxen)
// ─────────────────────────────────────────────────────────────────────────────

export const boxStyles = {
  /** Compact header box */
  header: {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round' as const,
    borderColor: 'cyan' as const,
  },

  /** Standard info box */
  info: {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round' as const,
    borderColor: 'cyan' as const,
  },

  /** Success box */
  success: {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round' as const,
    borderColor: 'green' as const,
  },

  /** Error box */
  error: {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round' as const,
    borderColor: 'red' as const,
  },
};
