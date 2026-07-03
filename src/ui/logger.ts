/**
 * Logger utilities for tuck CLI
 * Provides consistent, styled logging output
 */

import logSymbols from 'log-symbols';
import figures from 'figures';
import { colors as c, indent as ind, divider, DIVIDER_WIDTH } from './theme.js';
import { isJsonMode } from '../lib/jsonOutput.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Logger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  step: (current: number, total: number, msg: string) => void;
  file: (action: 'add' | 'modify' | 'delete' | 'sync' | 'merge', path: string) => void;
  tree: (items: TreeItem[]) => void;
  blank: () => void;
  dim: (msg: string) => void;
  heading: (msg: string) => void;
  divider: () => void;
}

export interface TreeItem {
  name: string;
  isLast: boolean;
  indent?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Action Icons
// ─────────────────────────────────────────────────────────────────────────────

const fileIcons = {
  add: c.success(figures.tick),
  modify: c.warning('~'),
  delete: c.error(figures.cross),
  sync: c.brand(figures.arrowRight),
  merge: c.info('+'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Logger Implementation
// ─────────────────────────────────────────────────────────────────────────────

// The jsonOutput contract is "exactly one JSON object on stdout" for every
// `--json` invocation. Every logger method below writes human text to stdout, so
// in JSON mode the informational methods must be silenced entirely and the
// diagnostic ones (warning/error) redirected to stderr — otherwise a single
// stray log line corrupts the machine-readable envelope an agent/CI is parsing.
export const logger: Logger = {
  info: (msg: string) => {
    if (isJsonMode()) return;
    console.log(logSymbols.info, msg);
  },

  success: (msg: string) => {
    if (isJsonMode()) return;
    console.log(logSymbols.success, msg);
  },

  warning: (msg: string) => {
    // In JSON mode keep stdout clean for the envelope; surface the diagnostic on
    // stderr instead of dropping it (agents read stdout, humans read stderr).
    if (isJsonMode()) {
      console.error(logSymbols.warning, msg);
      return;
    }
    console.log(logSymbols.warning, msg);
  },

  error: (msg: string) => {
    if (isJsonMode()) {
      console.error(logSymbols.error, msg);
      return;
    }
    console.log(logSymbols.error, msg);
  },

  debug: (msg: string) => {
    if (isJsonMode()) return;
    if (process.env.DEBUG) {
      console.log(c.muted(figures.bullet), c.muted(msg));
    }
  },

  step: (current: number, total: number, msg: string) => {
    if (isJsonMode()) return;
    const counter = c.muted(`[${current}/${total}]`);
    console.log(counter, msg);
  },

  file: (action: 'add' | 'modify' | 'delete' | 'sync' | 'merge', path: string) => {
    if (isJsonMode()) return;
    const icon = fileIcons[action];
    console.log(`${ind()}${icon} ${c.brand(path)}`);
  },

  tree: (items: TreeItem[]) => {
    if (isJsonMode()) return;
    items.forEach(({ name, isLast, indent = 0 }) => {
      const indentation = ind(indent);
      const prefix = isLast ? figures.lineUpRight : figures.lineDownRightArc;
      console.log(c.muted(indentation + prefix + figures.line), name);
    });
  },

  blank: () => {
    if (isJsonMode()) return;
    console.log();
  },

  dim: (msg: string) => {
    if (isJsonMode()) return;
    console.log(c.muted(msg));
  },

  heading: (msg: string) => {
    if (isJsonMode()) return;
    console.log(c.brandBold(msg));
  },

  divider: () => {
    if (isJsonMode()) return;
    console.log(divider(DIVIDER_WIDTH));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting Helpers (re-exported from theme for convenience)
// ─────────────────────────────────────────────────────────────────────────────

export { formatPath, formatCategory, formatCount, formatStatus } from './theme.js';
