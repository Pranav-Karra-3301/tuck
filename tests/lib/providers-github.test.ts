/**
 * GitHub provider createRepo argv unit tests.
 *
 * `gh repo create --confirm --json ...` uses flags that DO NOT EXIST in gh 2.x,
 * so the flagship auto-repo-create path always threw. The argv must use the
 * modern non-interactive form (name + visibility) and never the dead flags.
 */
import { describe, it, expect } from 'vitest';
import { buildCreateRepoArgs } from '../../src/lib/providers/github.js';

describe('buildCreateRepoArgs', () => {
  it('builds a private create with no dead --confirm/--json flags', () => {
    const args = buildCreateRepoArgs({ name: 'dotfiles', isPrivate: true });
    expect(args).toEqual(['repo', 'create', 'dotfiles', '--private']);
    expect(args).not.toContain('--confirm');
    expect(args).not.toContain('--json');
  });

  it('uses --public when isPrivate is false', () => {
    expect(buildCreateRepoArgs({ name: 'dots', isPrivate: false })).toContain('--public');
  });

  it('defaults to private when isPrivate is unset', () => {
    expect(buildCreateRepoArgs({ name: 'dots' })).toContain('--private');
  });

  it('includes a description when given', () => {
    const args = buildCreateRepoArgs({ name: 'dots', isPrivate: true, description: 'my dotfiles' });
    expect(args).toContain('--description');
    expect(args).toContain('my dotfiles');
    expect(args).not.toContain('--confirm');
  });
});
