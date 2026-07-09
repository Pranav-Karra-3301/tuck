/**
 * Structured JSON output for agent / CI consumption.
 *
 * Every command that supports `--json` emits exactly one JSON object on stdout
 * (and only one). The envelope is stable across versions; field semantics may
 * grow but never shrink.
 *
 *   { ok: true,  command: "sync",  data: {...},  warnings?: [...] }
 *   { ok: false, command: "sync",  error: { code, message, hint?, suggestions?, exit_code } }
 *
 * Human-readable output (banners, spinners, colored logs) must be suppressed
 * when `json` is set. Use `isJsonMode()` from this module to gate any side
 * effect that writes to stdout/stderr from the UI layer.
 */

export interface JsonError {
  code: string;
  message: string;
  hint?: string;
  suggestions?: string[];
  exit_code: number;
  /** Raw git stderr/stdout for GIT_ERROR failures — the unclassified evidence. */
  git_output?: string;
}

export interface JsonEnvelopeOk<T> {
  ok: true;
  command: string;
  data: T;
  warnings?: string[];
}

export interface JsonEnvelopeErr {
  ok: false;
  command: string;
  error: JsonError;
  warnings?: string[];
}

export type JsonEnvelope<T> = JsonEnvelopeOk<T> | JsonEnvelopeErr;

let jsonMode = false;
let currentCommand = 'tuck';
const pendingWarnings: string[] = [];
// The envelope contract is "exactly one JSON object on stdout". This guard
// ensures a stray second emit (e.g. a success path that also hits an error
// handler) can never print a second object and corrupt the stream.
let hasEmitted = false;

/** Test-only: reset the single-emit guard between cases. */
export const __resetJsonEmitState = (): void => {
  hasEmitted = false;
  pendingWarnings.length = 0;
};

export const setJsonMode = (enabled: boolean, command?: string): void => {
  jsonMode = enabled;
  if (command) currentCommand = command;
  // Each command run is a fresh emit context (one process == one command in
  // production; in tests this resets the single-emit guard between cases).
  hasEmitted = false;
  pendingWarnings.length = 0;
};

export const isJsonMode = (): boolean => jsonMode;

export const getCurrentCommand = (): string => currentCommand;

export const addJsonWarning = (msg: string): void => {
  if (jsonMode) pendingWarnings.push(msg);
};

export const consumeJsonWarnings = (): string[] => {
  const w = pendingWarnings.slice();
  pendingWarnings.length = 0;
  return w;
};

export const emitJsonOk = <T>(data: T, command?: string): void => {
  if (hasEmitted) return;
  const env: JsonEnvelopeOk<T> = {
    ok: true,
    command: command ?? currentCommand,
    data,
  };
  const warnings = consumeJsonWarnings();
  if (warnings.length > 0) env.warnings = warnings;
  hasEmitted = true;
  process.stdout.write(JSON.stringify(env) + '\n');
};

export const emitJsonErr = (err: JsonError, command?: string): void => {
  if (hasEmitted) return;
  const env: JsonEnvelopeErr = {
    ok: false,
    command: command ?? currentCommand,
    error: err,
  };
  // Surface any warnings queued before the error instead of dropping them.
  const warnings = consumeJsonWarnings();
  if (warnings.length > 0) env.warnings = warnings;
  hasEmitted = true;
  process.stdout.write(JSON.stringify(env) + '\n');
};
