/**
 * Build a stable, fully-qualified command path (e.g. "tuck config get") from a
 * Commander command node by walking up its parent chain to the root program.
 *
 * Used by the JSON-mode preAction hook so the envelope's `command` field is
 * accurate for subcommands — replacing the old "first non-flag argv token"
 * heuristic that broke for subcommands and mis-fired on option values.
 */
export interface CommandLike {
  name(): string;
  parent?: CommandLike | null;
}

export const buildCommandPath = (cmd: CommandLike, root = 'tuck'): string => {
  const parts: string[] = [];
  let current: CommandLike | null | undefined = cmd;
  while (current && current.name() !== root) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return [root, ...parts].join(' ');
};

/**
 * Cross-platform "is this executable on PATH?" check.
 *
 * Scans the PATH directories directly (rather than spawning `which`/`where` or
 * running `<bin> --version`, which vary per tool and can hang) so it works the
 * same on macOS, Linux, and Windows. On Windows every extension in PATHEXT is
 * tried. Returns false on any error — a bin we cannot resolve is simply absent.
 */
export const commandExists = async (bin: string): Promise<boolean> => {
  // An explicit path (absolute or containing a separator) is checked directly.
  const isWindows = process.platform === 'win32';
  const pathSep = isWindows ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(pathSep).filter((d) => d.length > 0);
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)
    : [''];

  const { access } = await import('fs/promises');
  const { join, isAbsolute } = await import('path');

  const candidates: string[] = [];
  if (isAbsolute(bin) || bin.includes('/') || (isWindows && bin.includes('\\'))) {
    for (const ext of exts) candidates.push(bin + ext);
  } else {
    for (const dir of dirs) {
      for (const ext of exts) candidates.push(join(dir, bin + ext));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Not here — keep looking.
    }
  }
  return false;
};
