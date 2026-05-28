/**
 * context apply safety unit tests.
 *
 * `tuck context apply <user/repo>` clones an UNTRUSTED remote and writes files
 * from its context.json into the user's home. Every write target must be
 * validated to stay inside $HOME, and every read source must stay inside the
 * clone dir, BEFORE any directory is created.
 */
import { describe, it, expect } from 'vitest';
import { assertContextWriteSafe } from '../../src/commands/context.js';

const CLONE = '/test-home/.tuck/.tmp-context/u-r';

describe('assertContextWriteSafe', () => {
  it('accepts a home-scoped write with an in-clone source', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, {
        source: '~/.claude/CLAUDE.md',
        destination: 'context/claude/CLAUDE.md',
      })
    ).not.toThrow();
  });

  it('rejects a write target that escapes $HOME (absolute)', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, { source: '/etc/cron.d/evil', destination: 'context/x' })
    ).toThrow();
  });

  it('rejects a write target that escapes $HOME via ..', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, { source: '~/../../tmp/evil', destination: 'context/x' })
    ).toThrow();
  });

  it('rejects a read source that escapes the clone dir', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, {
        source: '~/.config/ok',
        destination: '../../../../etc/passwd',
      })
    ).toThrow();
  });
});
