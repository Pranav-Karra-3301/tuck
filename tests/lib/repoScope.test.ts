/**
 * Repo registry + identity unit tests.
 *
 * Repo-scoped tracking resolves a stable, machine-INDEPENDENT repoKey to an
 * absolute repo root via a MACHINE-LOCAL, off-repo registry (repos.json under
 * the state dir). The key must be identical across machines (derived from the
 * canonicalized remote URL), and the registry must never throw on bad input.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import {
  loadReposRegistry,
  bindRepo,
  resolveRepoRoot,
  getReposRegistryPath,
  canonicalRemoteUrl,
  repoKeyFromIdentity,
  resolveLiveTarget,
  slugifyPath,
  repoScopeKey,
  findGitRoot,
} from '../../src/lib/repoScope.js';

beforeEach(() => {
  vol.reset();
  vol.mkdirSync('/test-home', { recursive: true });
});

describe('repos registry', () => {
  it('returns an empty registry when none exists', async () => {
    const reg = await loadReposRegistry();
    expect(reg.repos).toEqual({});
  });

  it('binds a repoKey to a root and resolves it back', async () => {
    await bindRepo('proj-abcd1234', '/Users/me/work/proj', { remoteUrl: 'git@github.com:me/proj.git' });
    // The registry stores a MACHINE-LOCAL absolute root via resolve(); on Windows
    // that becomes a drive-prefixed native path. resolve() is a no-op on POSIX.
    expect(await resolveRepoRoot('proj-abcd1234')).toBe(resolve('/Users/me/work/proj'));
  });

  it('stores the registry off-repo (under the state dir, not ~/.tuck)', async () => {
    await bindRepo('k', '/tmp/x');
    const p = getReposRegistryPath();
    expect(vol.existsSync(p)).toBe(true);
    expect(p).not.toContain('/.tuck/');
  });

  it('returns null for an unknown repoKey (never guesses)', async () => {
    expect(await resolveRepoRoot('not-bound')).toBeNull();
  });

  it('treats a malformed registry as empty rather than throwing', async () => {
    const p = getReposRegistryPath();
    // Use path.dirname (not a /-only regex): getReposRegistryPath() returns a
    // native path, which uses backslashes on Windows — a forward-slash regex
    // would no-op there, mkdir the full repos.json path as a directory, and
    // make the later writeFileSync hit EISDIR.
    vol.mkdirSync(dirname(p), { recursive: true });
    vol.writeFileSync(p, '{ not valid json');
    const reg = await loadReposRegistry();
    expect(reg.repos).toEqual({});
  });
});

describe('canonicalRemoteUrl', () => {
  it('canonicalizes ssh and https of the same repo to the same value', () => {
    const ssh = canonicalRemoteUrl('git@github.com:user/dots.git');
    const https = canonicalRemoteUrl('https://github.com/user/dots');
    expect(ssh).toBe(https);
    expect(ssh).toBe('github.com/user/dots');
  });

  it('normalizes ssh:// form too', () => {
    expect(canonicalRemoteUrl('ssh://git@github.com/user/dots.git')).toBe('github.com/user/dots');
  });
});

describe('repoKeyFromIdentity', () => {
  it('is deterministic and identical for ssh vs https of the same repo', () => {
    const fromSsh = repoKeyFromIdentity('proj', canonicalRemoteUrl('git@gitlab.com:me/proj.git'));
    const fromHttps = repoKeyFromIdentity('proj', canonicalRemoteUrl('https://gitlab.com/me/proj'));
    expect(fromSsh).toBe(fromHttps);
    expect(fromSsh).toMatch(/^proj-[0-9a-f]{8}$/);
  });

  it('differs for different identities', () => {
    expect(repoKeyFromIdentity('proj', 'a')).not.toBe(repoKeyFromIdentity('proj', 'b'));
  });
});

describe('slugifyPath / repoScopeKey (shared by context + rulesFanout fan-out ids)', () => {
  it('strips a leading ~/, lowercases, and maps unsafe runs to a single dash', () => {
    expect(slugifyPath('~/My Configs/App!!Rules')).toBe('my-configs-app-rules');
  });

  it('preserves the dot/underscore/dash grammar and trims only edge dashes', () => {
    // `._-` are all allowed by the grammar, so underscores survive; only leading/
    // trailing DASHES are trimmed.
    expect(slugifyPath('-.foo_bar-baz.md-')).toBe('.foo_bar-baz.md');
    expect(slugifyPath('AGENTS.md')).toBe('agents.md');
  });

  it('repoScopeKey is <basename-slug>__<full-path-slug> — collision-safe across repos', () => {
    // Two repos sharing a basename must NOT collide, because the full path is
    // folded into the key. This is the invariant the destination scheme relies on.
    const a = repoScopeKey('/Users/me/work/proj');
    const b = repoScopeKey('/Users/me/other/proj');
    expect(a).toBe('proj__users-me-work-proj');
    expect(b).toBe('proj__users-me-other-proj');
    expect(a).not.toBe(b);
  });
});

describe('findGitRoot', () => {
  it('walks up to the enclosing .git and returns that root', async () => {
    vol.mkdirSync('/repo/a/b/c', { recursive: true });
    vol.mkdirSync('/repo/.git', { recursive: true });
    expect(await findGitRoot('/repo/a/b/c')).toBe('/repo');
  });

  it('returns null when no .git is found up to the filesystem root', async () => {
    vol.mkdirSync('/loose/dir', { recursive: true });
    expect(await findGitRoot('/loose/dir')).toBeNull();
  });

  it('expands a leading ~/ (resolve() would leave it verbatim)', async () => {
    // Regression guard for the consolidated expandPath-seeded variant: a ~-prefixed
    // start must resolve under $HOME, not a literal "~" directory under cwd.
    const home = homedir();
    vol.mkdirSync(join(home, 'proj'), { recursive: true });
    vol.mkdirSync(join(home, 'proj', '.git'), { recursive: true });
    expect(await findGitRoot('~/proj')).toBe(join(home, 'proj'));
  });
});

describe('resolveLiveTarget', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync('/test-home', { recursive: true });
  });

  it('resolves a home file via expandPath', async () => {
    // expandPath('~/.zshrc') === join(homedir(), '.zshrc'); native separators on Windows.
    expect(await resolveLiveTarget({ source: '~/.zshrc' })).toBe(join(homedir(), '.zshrc'));
  });

  it('resolves a repo file with an UNBOUND key to null (skip, never guess)', async () => {
    expect(
      await resolveLiveTarget({ source: 'k:a.txt', scope: 'repo', repoKey: 'k', repoRelative: 'a.txt' })
    ).toBeNull();
  });

  it('resolves a repo file with a bound key to join(root, repoRelative)', async () => {
    await bindRepo('k', '/srv/proj');
    // repo target = join(resolveRepoRoot('k'), repoRelative); machine-local native path.
    expect(
      await resolveLiveTarget({ source: 'k:a.txt', scope: 'repo', repoKey: 'k', repoRelative: 'a.txt' })
    ).toBe(join(resolve('/srv/proj'), 'a.txt'));
  });
});
