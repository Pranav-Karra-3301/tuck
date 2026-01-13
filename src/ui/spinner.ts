/**
 * Spinner utilities for tuck CLI
 * Uses @clack/prompts spinner as the primary implementation
 * Provides backward-compatible API with enhanced methods
 */

import * as p from '@clack/prompts';
import logSymbols from 'log-symbols';
import { colors as c } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SpinnerInstance {
  start: (text?: string) => void;
  stop: () => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  warn: (text?: string) => void;
  info: (text?: string) => void;
  text: (text: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Spinner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a spinner instance using @clack/prompts
 * Provides ora-compatible API for backward compatibility
 */
export const createSpinner = (initialText?: string): SpinnerInstance => {
  const spinner = p.spinner();
  let currentText = initialText || '';
  let started = false;

  return {
    start: (text?: string) => {
      currentText = text || currentText || 'Loading...';
      spinner.start(currentText);
      started = true;
    },

    stop: () => {
      if (started) {
        spinner.stop(currentText);
        started = false;
      }
    },

    succeed: (text?: string) => {
      if (started) {
        spinner.stop(c.success(text || currentText));
        started = false;
      } else {
        console.log(logSymbols.success, c.success(text || currentText));
      }
    },

    fail: (text?: string) => {
      if (started) {
        spinner.stop(c.error(text || currentText));
        started = false;
      } else {
        console.log(logSymbols.error, c.error(text || currentText));
      }
    },

    warn: (text?: string) => {
      if (started) {
        spinner.stop(c.warning(text || currentText));
        started = false;
      } else {
        console.log(logSymbols.warning, c.warning(text || currentText));
      }
    },

    info: (text?: string) => {
      if (started) {
        spinner.stop(c.info(text || currentText));
        started = false;
      } else {
        console.log(logSymbols.info, c.info(text || currentText));
      }
    },

    text: (text: string) => {
      currentText = text;
      if (started) {
        spinner.message(text);
      }
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// With Spinner Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute an async function with a spinner
 * Automatically shows success/failure based on result
 */
export const withSpinner = async <T>(
  text: string,
  fn: () => Promise<T>,
  options?: {
    successText?: string;
    failText?: string;
  }
): Promise<T> => {
  const spinner = createSpinner(text);
  spinner.start();

  try {
    const result = await fn();
    spinner.succeed(options?.successText || text);
    return result;
  } catch (error) {
    spinner.fail(options?.failText || text);
    throw error;
  }
};
