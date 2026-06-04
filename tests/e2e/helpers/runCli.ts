import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// tests/e2e/helpers → repo root is three levels up.
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const CLI_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; signalled / spawn failures are normalized to 1. */
  code: number;
}

export interface RunOptions {
  /** Temp HOME the child must treat as ~ (sets HOME + USERPROFILE). */
  home: string;
  /** Extra env (e.g. git identity, TUCK_PASSWORD). Merged over the base env. */
  env?: Record<string, string>;
  /** Working directory for the child (default: home). */
  cwd?: string;
  /** Pipe to child stdin. */
  input?: string;
  /** Override the implicit TUCK_TARGET_ROOT=home write sandbox (default: on). */
  sandbox?: boolean;
}

/**
 * Spawn `node dist/index.js <args>` with a sanitized, hermetic environment:
 *   - HOME/USERPROFILE → the temp home (relocates ~/.tuck, keystore, state dir);
 *   - TUCK_TARGET_ROOT → home (belt-and-suspenders write confinement);
 *   - CI=1, NO_UPDATE_NOTIFIER=1, non-TTY stdio → force non-interactive paths and
 *     suppress the update banner that would corrupt JSON;
 *   - EDITOR/GIT_EDITOR=true, GIT_TERMINAL_PROMPT=0 → any stray prompt exits fast.
 * NEVER rejects on non-zero exit: the test asserts on { code, stdout, stderr }.
 */
export const runCli = (args: string[], opts: RunOptions): Promise<RunResult> => {
  const { home, env = {}, cwd = home, input, sandbox = true } = opts;

  const childEnv: NodeJS.ProcessEnv = {
    // Minimal base (don't spread process.env — avoids leaking the operator's
    // real HOME/XDG/git config into the child and breaking hermeticity).
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot, // Windows: node needs this
    COMSPEC: process.env.COMSPEC, // Windows
    HOME: home,
    USERPROFILE: home, // Windows os.homedir()
    XDG_STATE_HOME: '', // force the state/keystore dir under HOME, not host XDG
    XDG_CONFIG_HOME: '',
    CI: '1',
    NO_UPDATE_NOTIFIER: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    EDITOR: 'true',
    VISUAL: 'true',
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    ...(sandbox ? { TUCK_TARGET_ROOT: home } : {}),
    ...env,
  };

  return new Promise((res) => {
    const child = execFile(
      process.execPath, // the same node running vitest
      [CLI_ENTRY, ...args],
      { cwd, env: childEnv, maxBuffer: 16 * 1024 * 1024, timeout: 55_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1 // signalled / spawn failure → treat as failure
              : 0;
        res({ stdout: String(stdout), stderr: String(stderr), code });
      }
    );
    if (input !== undefined) child.stdin?.end(input);
  });
};

/** Create a throwaway HOME under the OS temp dir; returns its absolute path. */
export const makeHome = (): Promise<string> => mkdtemp(join(tmpdir(), 'tuck-e2e-'));

export const cleanupHome = (home: string): Promise<void> => rm(home, { recursive: true, force: true });

export const homePath = (home: string, rel: string): string => join(home, rel);

export const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const readHomeFile = (home: string, rel: string): Promise<string> =>
  readFile(join(home, rel), 'utf-8');

/** Write a dotfile into the temp HOME before running `tuck add`. */
export const seedHomeFile = async (home: string, rel: string, content: string): Promise<string> => {
  const full = join(home, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
};

/** Parse the single-line JSON envelope tuck emits under --json (last non-empty line). */
export const parseEnvelope = (
  stdout: string
): { ok: boolean; command?: string; data?: Record<string, unknown>; error?: unknown } => {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  return JSON.parse(line);
};
