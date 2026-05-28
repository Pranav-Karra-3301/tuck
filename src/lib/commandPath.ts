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
