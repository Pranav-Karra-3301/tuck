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
}

export type JsonEnvelope<T> = JsonEnvelopeOk<T> | JsonEnvelopeErr;

let jsonMode = false;
let currentCommand = 'tuck';
const pendingWarnings: string[] = [];

export const setJsonMode = (enabled: boolean, command?: string): void => {
  jsonMode = enabled;
  if (command) currentCommand = command;
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
  const env: JsonEnvelopeOk<T> = {
    ok: true,
    command: command ?? currentCommand,
    data,
  };
  const warnings = consumeJsonWarnings();
  if (warnings.length > 0) env.warnings = warnings;
  process.stdout.write(JSON.stringify(env) + '\n');
};

export const emitJsonErr = (err: JsonError, command?: string): void => {
  const env: JsonEnvelopeErr = {
    ok: false,
    command: command ?? currentCommand,
    error: err,
  };
  process.stdout.write(JSON.stringify(env) + '\n');
};
