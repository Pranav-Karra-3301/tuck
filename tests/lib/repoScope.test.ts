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
import {
  loadReposRegistry,
  bindRepo,
  resolveRepoRoot,
  getReposRegistryPath,
  canonicalRemoteUrl,
  repoKeyFromIdentity,
  resolveLiveTarget,
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
    expect(await resolveRepoRoot('proj-abcd1234')).toBe('/Users/me/work/proj');
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
    vol.mkdirSync(p.replace(/\/[^/]+$/, ''), { recursive: true });
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

describe('resolveLiveTarget', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync('/test-home', { recursive: true });
  });

  it('resolves a home file via expandPath', async () => {
    expect(await resolveLiveTarget({ source: '~/.zshrc' })).toBe('/test-home/.zshrc');
  });

  it('resolves a repo file with an UNBOUND key to null (skip, never guess)', async () => {
    expect(
      await resolveLiveTarget({ source: 'k:a.txt', scope: 'repo', repoKey: 'k', repoRelative: 'a.txt' })
    ).toBeNull();
  });

  it('resolves a repo file with a bound key to join(root, repoRelative)', async () => {
    await bindRepo('k', '/srv/proj');
    expect(
      await resolveLiveTarget({ source: 'k:a.txt', scope: 'repo', repoKey: 'k', repoRelative: 'a.txt' })
    ).toBe('/srv/proj/a.txt');
  });
});
