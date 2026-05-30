/**
 * Regression tests for isIgnoredInSet (W4-B).
 *
 * `isIgnored` re-reads .tuckignore from disk on EVERY call. Detection loops that
 * checked ~150 detected files therefore re-read the same file ~150 times. The
 * new `isIgnoredInSet` performs the identical normalization + membership test
 * against a SET that the caller loads once via `loadTuckignore`, so the answer
 * is byte-identical but the file is read once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { loadTuckignore, isIgnored, isIgnoredInSet } from '../../src/lib/tuckignore.js';
import { TEST_TUCK_DIR } from '../setup.js';

describe('isIgnoredInSet (W4-B)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  it('gives the same answer as isIgnored for every probed path', async () => {
    const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
    vol.writeFileSync(ignorePath, '~/.docker/config.json\n~/.netrc\n');

    const ignored = await loadTuckignore(TEST_TUCK_DIR);

    const probes = [
      '~/.docker/config.json', // ignored
      '~/.netrc', // ignored
      '~/.zshrc', // not ignored
      '~/.gitconfig', // not ignored
    ];

    for (const probe of probes) {
      const viaSet = isIgnoredInSet(ignored, probe);
      const viaDisk = await isIgnored(TEST_TUCK_DIR, probe);
      expect(viaSet).toBe(viaDisk);
    }
  });

  it('normalizes absolute home paths just like isIgnored', async () => {
    const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
    vol.writeFileSync(ignorePath, '~/.netrc\n');

    const ignored = await loadTuckignore(TEST_TUCK_DIR);

    // Absolute path within $HOME should collapse to ~/.netrc and match.
    const abs = '/test-home/.netrc';
    expect(isIgnoredInSet(ignored, abs)).toBe(await isIgnored(TEST_TUCK_DIR, abs));
    expect(isIgnoredInSet(ignored, abs)).toBe(true);
  });

  it('returns false for an empty ignore set', () => {
    expect(isIgnoredInSet(new Set(), '~/.zshrc')).toBe(false);
  });
});
