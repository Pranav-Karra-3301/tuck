/**
 * Agent / non-interactive mode control.
 *
 * tuck is `@clack/prompts`-heavy, which is a hazard for agents and CI: a command
 * that hits a prompt with no human present would block forever (or read EOF and
 * silently "succeed"). This module centralizes the two orthogonal signals an
 * agent-native CLI needs:
 *
 *   1. Non-interactive mode — the CLI must NEVER prompt. Any code that would
 *      prompt must instead fail fast with a typed error. This is true when the
 *      caller passes `--non-interactive`, when `--json` is set (a prompt would
 *      corrupt the single-object stdout contract), or when stdin is not a TTY
 *      (no human to answer).
 *
 *   2. Color / ANSI suppression — machine consumers want clean, ANSI-free text.
 *      We force `chalk.level = 0` for JSON mode, non-interactive mode, an
 *      explicit `NO_COLOR`, or a non-TTY stdout, while still honoring an explicit
 *      `FORCE_COLOR` from the operator.
 *
 * `--yes` is deliberately NOT part of non-interactive detection: it means
 * "auto-confirm prompts" (answer yes) rather than "never prompt". Commands read
 * their own `--yes` flag to skip a specific confirmation.
 */

import chalk from 'chalk';
import { isJsonMode } from './jsonOutput.js';

// Set from the parsed `--non-interactive` global option (see src/index.ts). We
// keep this as module state — mirroring jsonOutput — because the prompts layer
// needs to read it without threading options through every call site.
let nonInteractiveFlag = false;

/** Set by the CLI entrypoint once the global `--non-interactive` flag is parsed. */
export const setNonInteractive = (enabled: boolean): void => {
  nonInteractiveFlag = enabled;
};

/** True only when the explicit `--non-interactive` flag was passed. */
export const isNonInteractiveFlagSet = (): boolean => nonInteractiveFlag;

/**
 * True when the CLI must never present an interactive prompt: an explicit
 * `--non-interactive`, JSON mode (prompting would corrupt the envelope), or a
 * non-TTY stdin (no human to answer). Callers that would prompt should throw a
 * typed error instead when this returns true.
 */
export const isNonInteractive = (): boolean =>
  nonInteractiveFlag || isJsonMode() || !process.stdin.isTTY;

/**
 * Configure ANSI color output for the current run. Idempotent; safe to call
 * multiple times (e.g. once from the early argv scan and again from preAction
 * once options are authoritatively parsed).
 *
 * Precedence:
 *   1. An explicit truthy `FORCE_COLOR` always wins (operator opted in).
 *   2. Otherwise color is suppressed for JSON mode, `--non-interactive`,
 *      `NO_COLOR`, or a non-TTY stdout.
 */
export const configureColor = (): void => {
  const forceColor = process.env.FORCE_COLOR;
  const forceColorEnabled =
    forceColor !== undefined && forceColor !== '' && forceColor !== '0' && forceColor !== 'false';
  if (forceColorEnabled) return;

  const suppress =
    isJsonMode() ||
    nonInteractiveFlag ||
    (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') ||
    !process.stdout.isTTY;

  if (suppress) {
    chalk.level = 0;
  }
};
