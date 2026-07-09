/**
 * Command-path builder unit tests.
 *
 * JSON-mode detection used to guess the command name as "the first non-flag
 * argv token", which breaks for subcommands (config get) and mis-fires on
 * option values. The Commander preAction hook instead walks the parsed command
 * tree; buildCommandPath turns that tree into a stable "tuck <a> <b>" string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { buildCommandPath, commandExists } from '../../src/lib/commandPath.js';

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

describe('commandExists', () => {
  const origPath = process.env.PATH;
  const origPlatform = process.platform;

  beforeEach(() => {
    vol.reset();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.PATH = '/usr/bin:/usr/local/bin';
  });

  afterEach(() => {
    process.env.PATH = origPath;
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  it('finds an executable present on a PATH directory', async () => {
    vol.mkdirSync('/usr/local/bin', { recursive: true });
    vol.writeFileSync('/usr/local/bin/brew', '#!/bin/sh\n');
    expect(await commandExists('brew')).toBe(true);
  });

  it('returns false when the executable is on no PATH directory', async () => {
    vol.mkdirSync('/usr/bin', { recursive: true });
    expect(await commandExists('definitely-not-here')).toBe(false);
  });

  it('checks an absolute path directly', async () => {
    vol.mkdirSync('/opt/tool/bin', { recursive: true });
    vol.writeFileSync('/opt/tool/bin/thing', '');
    expect(await commandExists('/opt/tool/bin/thing')).toBe(true);
    expect(await commandExists('/opt/tool/bin/missing')).toBe(false);
  });
});
