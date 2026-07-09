/**
 * Remote / SSH apply — push locally-tracked configs onto a remote box.
 *
 * `tuck apply --target ssh://[user@]host` (or `tuck apply --ssh host`) reads the
 * LOCAL tuck manifest and copies each tracked file's committed repo copy onto a
 * remote machine over ssh/scp, placing it at the same home-relative path on the
 * remote. This is the "get my agent configs (.claude / .cursor / .codex) onto
 * every server I SSH into" workflow.
 *
 * Design/safety notes:
 * - We never shell out through a shell: every ssh/scp invocation uses execFile
 *   with an argv array, so the LOCAL side cannot be command-injected.
 * - The remote destination is derived from the tracked file's home-relative
 *   source (`~/.zshrc` → `.zshrc`) and is always placed under the remote $HOME.
 *   Absolute / out-of-home / traversal paths are refused.
 * - The remote `mkdir -p` command IS interpreted by the remote shell, so its path
 *   is single-quoted and validated to contain no single quote or control
 *   character before use. The scp destination path is NOT shell-interpreted:
 *   since OpenSSH 9.0 scp speaks the SFTP protocol and takes the path verbatim,
 *   so it is passed UNQUOTED (quoting it would create a file whose name literally
 *   contains the quotes). The same no-quote/no-control-char validation is kept as
 *   defense-in-depth.
 * - ssh host/user/port components are strictly validated (no leading dash, no
 *   shell metacharacters) so a hostile value cannot be smuggled in as an ssh flag.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, posix } from 'path';
import { z } from 'zod';
import { isDirectory, pathExists } from './paths.js';
import { ValidationError } from '../errors.js';
import type { TuckManifestOutput } from '../schemas/manifest.schema.js';

const execFileAsync = promisify(execFile);

/** Per-operation timeout for a single ssh/scp child process (60s). */
export const SSH_OPERATION_TIMEOUT = 60_000;

/** Upper bound on buffered ssh/scp output so a hostile remote can't OOM us. */
export const SSH_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/** Package spec used by the documented remote bootstrap one-liner. */
export const TUCK_NPM_PACKAGE = '@prnv/tuck';

export interface SshTarget {
  /** Optional remote user (defaults to ssh's own default when absent). */
  user?: string;
  host: string;
  /** Optional non-standard port. */
  port?: number;
  /** Human display form, e.g. "me@box:2222". */
  display: string;
}

export interface RemoteApplyEntry {
  /** Display source from the manifest (e.g. "~/.zshrc"). */
  source: string;
  /** Absolute path to the committed repo copy to upload. */
  localPath: string;
  /** POSIX home-relative path on the remote (e.g. ".config/nvim/init.lua"). */
  remoteRelative: string;
  category: string;
}

export interface RemotePlan {
  entries: RemoteApplyEntry[];
  /** Repo-scoped sources skipped (no stable cross-machine remote home path). */
  skippedRepoScoped: string[];
  /** Directory entries skipped (v1 pushes regular files only). */
  skippedDirectories: string[];
  /** Non-home-relative / unsafe sources skipped. */
  skippedUnsafe: string[];
  /** Tracked entries whose committed repo copy is missing on disk. */
  missing: string[];
}

// A single ssh host/user label component: must start with an alphanumeric and
// contain only host-safe characters. This rejects a leading '-' (which ssh/scp
// would read as a flag) and every shell metacharacter.
const HOST_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const sshTargetSchema = z.object({
  user: z
    .string()
    .regex(HOST_COMPONENT, 'invalid ssh user')
    .optional(),
  host: z.string().regex(HOST_COMPONENT, 'invalid ssh host'),
  port: z.number().int().min(1).max(65535).optional(),
});

/**
 * Parse a target into a validated {@link SshTarget}.
 *
 * Accepts either an `ssh://[user@]host[:port]` URL (from `--target`) or a bare
 * `[user@]host` shorthand (from `--ssh`, or `--target` without a scheme).
 * A non-`ssh` scheme is rejected. Every component is validated with
 * {@link sshTargetSchema}, so a malformed or injection-shaped value throws a
 * {@link ValidationError} instead of reaching ssh/scp.
 */
export const parseSshTarget = (input: string): SshTarget => {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new ValidationError('ssh target', 'target is empty');
  }

  let user: string | undefined;
  let host: string;
  let port: number | undefined;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    // A scheme is present — only ssh:// is supported here.
    if (!raw.startsWith('ssh://')) {
      throw new ValidationError('ssh target', `unsupported scheme in "${raw}" (expected ssh://)`);
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationError('ssh target', `could not parse "${raw}"`);
    }
    host = url.hostname;
    user = url.username ? decodeURIComponent(url.username) : undefined;
    if (url.port) {
      port = Number(url.port);
    }
    if (url.pathname && url.pathname !== '/') {
      throw new ValidationError('ssh target', 'a remote path is not allowed in the ssh target');
    }
  } else {
    // Bare shorthand: [user@]host[:port].
    let rest = raw;
    const at = rest.indexOf('@');
    if (at !== -1) {
      user = rest.slice(0, at);
      rest = rest.slice(at + 1);
    }
    // Split a trailing :port, but leave bracketed IPv6 (unsupported here) to fail
    // validation rather than mis-parse.
    const colon = rest.lastIndexOf(':');
    if (colon !== -1) {
      const portStr = rest.slice(colon + 1);
      if (/^\d+$/.test(portStr)) {
        port = Number(portStr);
        rest = rest.slice(0, colon);
      }
    }
    host = rest;
  }

  const parsed = sshTargetSchema.safeParse({ user, host, port });
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'invalid ssh target';
    throw new ValidationError('ssh target', `${reason} (from "${raw}")`);
  }

  const display =
    (parsed.data.user ? `${parsed.data.user}@` : '') +
    parsed.data.host +
    (parsed.data.port ? `:${parsed.data.port}` : '');

  return { user: parsed.data.user, host: parsed.data.host, port: parsed.data.port, display };
};

/**
 * Convert a tracked file's home-relative source (`~/.zshrc`) into the POSIX
 * home-relative path used on the remote (`.zshrc`). Returns null for anything
 * that is not safely inside home: a bare `~`/`$HOME`, an absolute path, or a
 * path containing a `..` segment. The result is also rejected if it contains a
 * single quote or control character, since it is interpolated into a
 * single-quoted remote shell command.
 */
export const remoteRelativeFromSource = (source: string): string | null => {
  const norm = source.replace(/\\/g, '/').trim();

  let rel: string;
  if (norm === '~' || norm === '$HOME') {
    return null; // the home dir itself is not a file to push
  } else if (norm.startsWith('~/')) {
    rel = norm.slice(2);
  } else if (norm.startsWith('$HOME/')) {
    rel = norm.slice(6);
  } else {
    return null; // absolute or otherwise out-of-home
  }

  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments.includes('..')) return null;

  const result = segments.join('/');
  // Reject a single quote or any control character: the path is interpolated
  // into a single-quoted remote shell command (`mkdir -p '<path>'`); a quote or
  // newline would break out of that quoting. Spaces are safe inside quotes.
  if (result.includes("'")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(result)) return null;
  return result;
};

/**
 * Build the remote-apply plan from the LOCAL manifest.
 *
 * Home-scoped regular files become {@link RemoteApplyEntry}s targeting the same
 * home-relative path on the remote. Repo-scoped entries, directory entries, and
 * unsafe sources are collected into their respective skip lists (v1 pushes
 * regular home files only). Entries whose committed repo copy is missing on disk
 * are reported in `missing` and excluded.
 */
export const buildRemotePlan = async (
  manifest: TuckManifestOutput,
  tuckDir: string,
  bundle?: string
): Promise<RemotePlan> => {
  const entries: RemoteApplyEntry[] = [];
  const skippedRepoScoped: string[] = [];
  const skippedDirectories: string[] = [];
  const skippedUnsafe: string[] = [];
  const missing: string[] = [];

  for (const file of Object.values(manifest.files)) {
    if (bundle && (file.bundle ?? 'default') !== bundle) {
      continue;
    }

    if (file.scope === 'repo') {
      skippedRepoScoped.push(file.source);
      continue;
    }

    const remoteRelative = remoteRelativeFromSource(file.source);
    if (remoteRelative === null) {
      skippedUnsafe.push(file.source);
      continue;
    }

    const localPath = join(tuckDir, file.destination);
    if (!(await pathExists(localPath))) {
      missing.push(file.source);
      continue;
    }

    if (await isDirectory(localPath)) {
      skippedDirectories.push(file.source);
      continue;
    }

    entries.push({
      source: file.source,
      localPath,
      remoteRelative,
      category: file.category,
    });
  }

  // Stable ordering for deterministic plans/output.
  entries.sort((a, b) => a.remoteRelative.localeCompare(b.remoteRelative));

  return { entries, skippedRepoScoped, skippedDirectories, skippedUnsafe, missing };
};

/** The `[user@]host` destination passed to ssh/scp. */
export const sshDestination = (target: SshTarget): string =>
  target.user ? `${target.user}@${target.host}` : target.host;

/**
 * Build the argv for an `ssh` invocation running a remote shell command.
 * The port flag for ssh is `-p`.
 */
export const buildSshCommand = (target: SshTarget, remoteCommand: string): string[] => {
  const args: string[] = [];
  if (target.port) args.push('-p', String(target.port));
  args.push(sshDestination(target), remoteCommand);
  return args;
};

/**
 * Build the argv for an `scp` upload of a single local file to a remote
 * home-relative path. The port flag for scp is `-P` (capital).
 *
 * The remote path is passed UNQUOTED. Since OpenSSH 9.0 (the default on all
 * modern macOS/Linux) scp uses the SFTP protocol, where the remote path is taken
 * verbatim rather than expanded by a remote shell — there is no shell on the
 * execFile→scp→sftp-server path. Single-quoting it (as the legacy SCP protocol
 * required) would create a remote file whose name literally contains the quote
 * characters, silently writing to the wrong destination. `remoteRelative` has
 * already been validated (no single quote, no control character) as
 * defense-in-depth.
 */
export const buildScpCommand = (
  target: SshTarget,
  localPath: string,
  remoteRelative: string
): string[] => {
  const args: string[] = [];
  if (target.port) args.push('-P', String(target.port));
  args.push(localPath, `${sshDestination(target)}:${remoteRelative}`);
  return args;
};

/**
 * Runner abstraction so the command layer (and tests) can inject a fake ssh/scp.
 * The default implementation shells out via execFile with a timeout and a
 * bounded output buffer.
 */
export type RemoteRunner = (command: 'ssh' | 'scp', args: string[]) => Promise<void>;

export const defaultRemoteRunner: RemoteRunner = async (command, args) => {
  await execFileAsync(command, args, {
    timeout: SSH_OPERATION_TIMEOUT,
    maxBuffer: SSH_MAX_BUFFER,
  });
};

/**
 * Push a single planned entry to the remote: create its parent directory tree
 * (idempotent `mkdir -p`), then scp the file into place. The remote parent path
 * is single-quoted; entries were validated to contain no single quote.
 */
export const pushEntryToRemote = async (
  target: SshTarget,
  entry: RemoteApplyEntry,
  runner: RemoteRunner = defaultRemoteRunner
): Promise<void> => {
  const parent = posix.dirname(entry.remoteRelative);
  if (parent && parent !== '.') {
    await runner('ssh', buildSshCommand(target, `mkdir -p '${parent}'`));
  }
  await runner('scp', buildScpCommand(target, entry.localPath, entry.remoteRelative));
};

/**
 * The documented remote bootstrap one-liner: install tuck on a fresh box and
 * apply a dotfiles source in one shot. Complements the push flow for machines
 * you can reach but don't want to push to from your laptop.
 */
export const buildBootstrapOneLiner = (source: string): string =>
  `npm install -g ${TUCK_NPM_PACKAGE} && tuck apply ${source} --yes`;
