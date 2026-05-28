/**
 * Hook execution decision unit tests.
 *
 * Hooks run arbitrary shell from the (possibly cloned/untrusted) config. In a
 * non-interactive context (JSON mode / no TTY) we must NEVER block on a stdin
 * confirmation an agent can't answer — we skip unless --trust-hooks is explicit.
 */
import { describe, it, expect } from 'vitest';
import { decideHookExecution } from '../../src/lib/hooks.js';

describe('decideHookExecution', () => {
  it('skips when hooks are explicitly disabled', () => {
    expect(
      decideHookExecution({ skipHooks: true, hasCommand: true, nonInteractive: false })
    ).toBe('skip');
  });

  it('skips when there is no configured command', () => {
    expect(decideHookExecution({ hasCommand: false, nonInteractive: true })).toBe('skip');
  });

  it('runs when --trust-hooks is set (even non-interactive)', () => {
    expect(
      decideHookExecution({ hasCommand: true, trustHooks: true, nonInteractive: true })
    ).toBe('run');
  });

  it('skips (does NOT prompt) in non-interactive mode without trust', () => {
    expect(decideHookExecution({ hasCommand: true, nonInteractive: true })).toBe(
      'skip-non-interactive'
    );
  });

  it('prompts in interactive mode without trust', () => {
    expect(decideHookExecution({ hasCommand: true, nonInteractive: false })).toBe('prompt');
  });
});
