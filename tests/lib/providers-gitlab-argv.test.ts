/**
 * GitLab provider argv builder unit tests.
 *
 * glab reserves `-h` as the inherited `--help` shorthand on EVERY subcommand,
 * so passing `-h <host>` made every glab call print help and exit 0 — breaking
 * auth detection (isAuthenticated always false) and repoExists (always true).
 * Host selection must use the documented long flags (`--hostname` / `--host`)
 * or the GITLAB_HOST env var for `repo` subcommands, which have no host flag.
 * These tests pin the exact argv/env so the regression can't return.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAuthStatusArgs,
  buildApiUserArgs,
  buildRepoViewArgs,
  buildRepoCreateArgs,
  buildRepoCloneArgs,
  buildConfigGetProtocolArgs,
  glabHostEnv,
} from '../../src/lib/providers/gitlab.js';

describe('GitLab glab argv builders', () => {
  it('uses --hostname for auth status and never -h', () => {
    const args = buildAuthStatusArgs('gitlab.example.com');
    expect(args).toEqual(['auth', 'status', '--hostname', 'gitlab.example.com']);
    expect(args).not.toContain('-h');
  });

  it('uses --hostname for api user and never -h', () => {
    const args = buildApiUserArgs('gitlab.com');
    expect(args).toEqual(['api', 'user', '--hostname', 'gitlab.com']);
    expect(args).not.toContain('-h');
  });

  it('builds repo view with no host flag (host comes from env)', () => {
    const args = buildRepoViewArgs('user/dotfiles');
    expect(args).toEqual(['repo', 'view', 'user/dotfiles']);
    expect(args).not.toContain('-h');
  });

  it('uses -F json (not -o) for machine-readable repo view', () => {
    const args = buildRepoViewArgs('user/dotfiles', true);
    expect(args).toEqual(['repo', 'view', 'user/dotfiles', '-F', 'json']);
    expect(args).not.toContain('-o');
  });

  it('builds a private repo create with no -y and no host flag', () => {
    const args = buildRepoCreateArgs({ name: 'dotfiles', isPrivate: true });
    expect(args).toEqual(['repo', 'create', 'dotfiles', '--private']);
    expect(args).not.toContain('-y');
    expect(args).not.toContain('-h');
  });

  it('uses --public when isPrivate is false and includes a description', () => {
    const args = buildRepoCreateArgs({ name: 'dots', isPrivate: false, description: 'my dots' });
    expect(args).toEqual(['repo', 'create', 'dots', '--public', '--description', 'my dots']);
  });

  it('defaults to --private when isPrivate is unset', () => {
    expect(buildRepoCreateArgs({ name: 'dots' })).toContain('--private');
  });

  it('builds repo clone with no host flag', () => {
    const args = buildRepoCloneArgs('user/dotfiles', '/tmp/dest');
    expect(args).toEqual(['repo', 'clone', 'user/dotfiles', '/tmp/dest']);
    expect(args).not.toContain('-h');
  });

  it('uses --host for config get git_protocol and never -h', () => {
    const args = buildConfigGetProtocolArgs('gitlab.example.com');
    expect(args).toEqual(['config', 'get', 'git_protocol', '--host', 'gitlab.example.com']);
    expect(args).not.toContain('-h');
  });

  it('sets GITLAB_HOST in the env for host-flag-less repo subcommands', () => {
    const env = glabHostEnv('gitlab.example.com');
    expect(env.GITLAB_HOST).toBe('gitlab.example.com');
  });
});
