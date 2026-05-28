/**
 * preset apply safety unit tests.
 *
 * `tuck preset apply` writes files to disk from a (potentially untrusted)
 * preset manifest. It must (a) never write outside the user's home and (b)
 * never silently clobber existing files without consent.
 */
import { describe, it, expect } from 'vitest';
import { assertPresetTargetsSafe, decidePresetOverwrite } from '../../src/commands/preset.js';

describe('assertPresetTargetsSafe', () => {
  it('accepts targets inside $HOME', () => {
    expect(() =>
      assertPresetTargetsSafe([
        { target: '/test-home/.claude/CLAUDE.md' },
        { target: '/test-home/.zshrc' },
      ])
    ).not.toThrow();
  });

  it('rejects an absolute target outside $HOME', () => {
    expect(() => assertPresetTargetsSafe([{ target: '/etc/cron.d/evil' }])).toThrow();
  });

  it('rejects a ~-relative target that escapes $HOME via ..', () => {
    expect(() => assertPresetTargetsSafe([{ target: '~/../../tmp/evil' }])).toThrow();
  });

  it('rejects the whole batch if any single target is unsafe', () => {
    expect(() =>
      assertPresetTargetsSafe([
        { target: '/test-home/.config/ok' },
        { target: '/root/.bashrc' },
      ])
    ).toThrow();
  });
});

describe('decidePresetOverwrite', () => {
  it('proceeds when nothing would be overwritten', () => {
    expect(decidePresetOverwrite(0, { nonInteractive: true })).toBe('proceed');
  });

  it('proceeds when --yes is given even if files exist', () => {
    expect(decidePresetOverwrite(3, { yes: true, nonInteractive: true })).toBe('proceed');
  });

  it('refuses in non-interactive mode without --yes when files exist', () => {
    expect(decidePresetOverwrite(2, { nonInteractive: true })).toBe('refuse');
  });

  it('asks for confirmation in interactive mode without --yes when files exist', () => {
    expect(decidePresetOverwrite(2, { nonInteractive: false })).toBe('confirm');
  });
});
