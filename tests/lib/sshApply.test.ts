/**
 * Unit tests for the remote / SSH apply library.
 *
 * These cover the pure, network-free surface: target parsing + validation,
 * home-relative remote path derivation (and its injection guards), argv
 * construction for ssh/scp, and the plan builder against a temp (memfs) tuck dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  parseSshTarget,
  remoteRelativeFromSource,
  buildRemotePlan,
  sshDestination,
  buildSshCommand,
  buildScpCommand,
  pushEntryToRemote,
  buildBootstrapOneLiner,
  type SshTarget,
  type RemoteApplyEntry,
} from '../../src/lib/sshApply.js';
import { ValidationError } from '../../src/errors.js';

describe('parseSshTarget', () => {
  it('parses an ssh:// URL with user, host and port', () => {
    const t = parseSshTarget('ssh://me@box.example.com:2222');
    expect(t).toMatchObject({ user: 'me', host: 'box.example.com', port: 2222 });
    expect(t.display).toBe('me@box.example.com:2222');
  });

  it('parses a bare host', () => {
    const t = parseSshTarget('box');
    expect(t).toMatchObject({ user: undefined, host: 'box', port: undefined });
    expect(t.display).toBe('box');
  });

  it('parses user@host:port shorthand', () => {
    const t = parseSshTarget('deploy@10.0.0.5:22');
    expect(t).toMatchObject({ user: 'deploy', host: '10.0.0.5', port: 22 });
  });

  it('rejects a non-ssh scheme', () => {
    expect(() => parseSshTarget('http://box')).toThrow(ValidationError);
  });

  it('rejects a host that starts with a dash (would be read as an ssh flag)', () => {
    expect(() => parseSshTarget('-oProxyCommand=evil')).toThrow(ValidationError);
    expect(() => parseSshTarget('ssh://-badhost')).toThrow(ValidationError);
  });

  it('rejects hosts with shell metacharacters', () => {
    expect(() => parseSshTarget('box;rm -rf')).toThrow(ValidationError);
    expect(() => parseSshTarget('box$(whoami)')).toThrow(ValidationError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseSshTarget('box:99999')).toThrow(ValidationError);
  });

  it('rejects an empty target', () => {
    expect(() => parseSshTarget('   ')).toThrow(ValidationError);
  });

  it('rejects a remote path in the ssh target', () => {
    expect(() => parseSshTarget('ssh://box/etc/passwd')).toThrow(ValidationError);
  });
});

describe('remoteRelativeFromSource', () => {
  it('strips the home prefix from a ~/ source', () => {
    expect(remoteRelativeFromSource('~/.zshrc')).toBe('.zshrc');
    expect(remoteRelativeFromSource('~/.config/nvim/init.lua')).toBe('.config/nvim/init.lua');
  });

  it('handles $HOME-prefixed sources', () => {
    expect(remoteRelativeFromSource('$HOME/.gitconfig')).toBe('.gitconfig');
  });

  it('preserves dashes and dots in legitimate paths', () => {
    expect(remoteRelativeFromSource('~/.config/my-app/config.toml')).toBe(
      '.config/my-app/config.toml'
    );
  });

  it('returns null for the bare home directory', () => {
    expect(remoteRelativeFromSource('~')).toBeNull();
    expect(remoteRelativeFromSource('$HOME')).toBeNull();
  });

  it('returns null for absolute / out-of-home sources', () => {
    expect(remoteRelativeFromSource('/etc/passwd')).toBeNull();
    expect(remoteRelativeFromSource('relative/path')).toBeNull();
  });

  it('returns null for path traversal', () => {
    expect(remoteRelativeFromSource('~/../etc/passwd')).toBeNull();
  });

  it('returns null when a single quote would break remote shell quoting', () => {
    expect(remoteRelativeFromSource("~/.config/a'b")).toBeNull();
  });

  it('returns null for control characters', () => {
    expect(remoteRelativeFromSource('~/.config/a\nb')).toBeNull();
  });
});

describe('sshDestination / buildSshCommand / buildScpCommand', () => {
  const withUser: SshTarget = { user: 'me', host: 'box', port: 2222, display: 'me@box:2222' };
  const noUser: SshTarget = { host: 'box', display: 'box' };

  it('builds the [user@]host destination', () => {
    expect(sshDestination(withUser)).toBe('me@box');
    expect(sshDestination(noUser)).toBe('box');
  });

  it('builds ssh argv with the -p port flag', () => {
    expect(buildSshCommand(withUser, "mkdir -p '.config'")).toEqual([
      '-p',
      '2222',
      'me@box',
      "mkdir -p '.config'",
    ]);
  });

  it('omits the port flag when no port is set', () => {
    expect(buildSshCommand(noUser, 'mkdir -p x')).toEqual(['box', 'mkdir -p x']);
  });

  it('builds scp argv with the -P port flag and a single-quoted remote path', () => {
    expect(buildScpCommand(withUser, '/local/zshrc', '.zshrc')).toEqual([
      '-P',
      '2222',
      '/local/zshrc',
      "me@box:'.zshrc'",
    ]);
  });
});

describe('pushEntryToRemote', () => {
  const target: SshTarget = { host: 'box', display: 'box' };

  it('mkdirs the parent then scps the file via the injected runner', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = vi.fn(async (cmd: 'ssh' | 'scp', args: string[]) => {
      calls.push({ cmd, args });
    });
    const entry: RemoteApplyEntry = {
      source: '~/.config/nvim/init.lua',
      localPath: '/tuck/files/editor/nvim/init.lua',
      remoteRelative: '.config/nvim/init.lua',
      category: 'editor',
    };

    await pushEntryToRemote(target, entry, runner);

    expect(calls[0].cmd).toBe('ssh');
    expect(calls[0].args).toEqual(['box', "mkdir -p '.config/nvim'"]);
    expect(calls[1].cmd).toBe('scp');
    expect(calls[1].args).toEqual([
      '/tuck/files/editor/nvim/init.lua',
      "box:'.config/nvim/init.lua'",
    ]);
  });

  it('skips the mkdir when the file lands directly in remote home', async () => {
    const runner = vi.fn(async () => {});
    const entry: RemoteApplyEntry = {
      source: '~/.zshrc',
      localPath: '/tuck/files/shell/zshrc',
      remoteRelative: '.zshrc',
      category: 'shell',
    };

    await pushEntryToRemote(target, entry, runner);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('scp', ['/tuck/files/shell/zshrc', "box:'.zshrc'"]);
  });
});

describe('buildBootstrapOneLiner', () => {
  it('installs tuck and applies the source', () => {
    expect(buildBootstrapOneLiner('octocat')).toBe(
      'npm install -g @prnv/tuck && tuck apply octocat --yes'
    );
  });
});

describe('buildRemotePlan', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => vol.reset());

  const writeRepoFile = (rel: string, content = 'x'): void => {
    const abs = join(TEST_TUCK_DIR, rel);
    vol.mkdirSync(join(abs, '..'), { recursive: true });
    vol.writeFileSync(abs, content);
  };

  it('maps home-scoped regular files to remote home-relative entries', async () => {
    writeRepoFile('files/shell/zshrc');
    writeRepoFile('files/editor/nvim/init.lua');
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
        b: createMockTrackedFile({
          source: '~/.config/nvim/init.lua',
          destination: 'files/editor/nvim/init.lua',
        }),
      },
    });

    const plan = await buildRemotePlan(manifest, TEST_TUCK_DIR);

    expect(plan.entries.map((e) => e.remoteRelative)).toEqual([
      '.config/nvim/init.lua',
      '.zshrc',
    ]);
    expect(plan.entries[1].localPath).toBe(join(TEST_TUCK_DIR, 'files/shell/zshrc'));
  });

  it('skips repo-scoped entries', async () => {
    const manifest = createMockManifest({
      files: {
        r: createMockTrackedFile({
          source: 'myrepo-deadbeef:config/app.toml',
          destination: 'files/repos/myrepo-deadbeef/config/app.toml',
          scope: 'repo',
          repoKey: 'myrepo-deadbeef',
          repoRelative: 'config/app.toml',
        }),
      },
    });

    const plan = await buildRemotePlan(manifest, TEST_TUCK_DIR);

    expect(plan.entries).toHaveLength(0);
    expect(plan.skippedRepoScoped).toEqual(['myrepo-deadbeef:config/app.toml']);
  });

  it('skips directory entries (v1 pushes files only)', async () => {
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/editor/nvim'), { recursive: true });
    const manifest = createMockManifest({
      files: {
        d: createMockTrackedFile({
          source: '~/.config/nvim',
          destination: 'files/editor/nvim',
        }),
      },
    });

    const plan = await buildRemotePlan(manifest, TEST_TUCK_DIR);

    expect(plan.entries).toHaveLength(0);
    expect(plan.skippedDirectories).toEqual(['~/.config/nvim']);
  });

  it('reports a tracked file whose repo copy is missing on disk', async () => {
    const manifest = createMockManifest({
      files: {
        m: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
      },
    });

    const plan = await buildRemotePlan(manifest, TEST_TUCK_DIR);

    expect(plan.entries).toHaveLength(0);
    expect(plan.missing).toEqual(['~/.zshrc']);
  });

  it('filters by bundle', async () => {
    writeRepoFile('files/shell/zshrc');
    writeRepoFile('files/shell/bashrc');
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
          bundle: 'work',
        }),
        b: createMockTrackedFile({
          source: '~/.bashrc',
          destination: 'files/shell/bashrc',
          bundle: 'default',
        }),
      },
    });

    const plan = await buildRemotePlan(manifest, TEST_TUCK_DIR, 'work');

    expect(plan.entries.map((e) => e.source)).toEqual(['~/.zshrc']);
  });
});
