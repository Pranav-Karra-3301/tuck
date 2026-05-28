/**
 * Command-path builder unit tests.
 *
 * JSON-mode detection used to guess the command name as "the first non-flag
 * argv token", which breaks for subcommands (config get) and mis-fires on
 * option values. The Commander preAction hook instead walks the parsed command
 * tree; buildCommandPath turns that tree into a stable "tuck <a> <b>" string.
 */
import { describe, it, expect } from 'vitest';
import { buildCommandPath } from '../../src/lib/commandPath.js';

const cmd = (name: string, parent?: unknown) => ({ name: () => name, parent });

describe('buildCommandPath', () => {
  it('returns "tuck" for the root program itself', () => {
    expect(buildCommandPath(cmd('tuck'))).toBe('tuck');
  });

  it('builds a top-level command path', () => {
    const root = cmd('tuck');
    expect(buildCommandPath(cmd('sync', root))).toBe('tuck sync');
  });

  it('builds a nested subcommand path', () => {
    const root = cmd('tuck');
    const config = cmd('config', root);
    expect(buildCommandPath(cmd('get', config))).toBe('tuck config get');
  });
});
