/**
 * files write-guard repo-root threading (the load-bearing fix).
 *
 * copyFileOrDir/createSymlink independently call validateSafeDestinationPath,
 * which defaults to [homedir()] and would reject ANY out-of-home repo target —
 * even one resolveWriteTarget allowed. They must validate against allowedRoots()
 * so a write to a BOUND repo root (outside $HOME) is permitted, while an
 * unbound out-of-home path is still rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { copyFileOrDir } from '../../src/lib/files.js';
import { setKnownRepoRoots, resetWriteContext } from '../../src/lib/writeContext.js';

beforeEach(() => {
  vol.reset();
  resetWriteContext();
  vol.mkdirSync('/test-home', { recursive: true });
  vol.mkdirSync('/srv', { recursive: true });
  vol.writeFileSync('/src.txt', 'hi');
});
afterEach(() => resetWriteContext());

describe('copyFileOrDir destination guard', () => {
  it('still allows a normal in-home destination', async () => {
    await copyFileOrDir('/src.txt', '/test-home/.config/f.txt');
    expect(vol.readFileSync('/test-home/.config/f.txt', 'utf-8')).toBe('hi');
  });

  it('rejects an out-of-home repo path when no repo is bound', async () => {
    await expect(copyFileOrDir('/src.txt', '/srv/repoX/sub/f.txt')).rejects.toThrow();
    expect(vol.existsSync('/srv/repoX/sub/f.txt')).toBe(false);
  });

  it('allows a write to a BOUND repo root outside $HOME', async () => {
    setKnownRepoRoots(['/srv/repoX']);
    await copyFileOrDir('/src.txt', '/srv/repoX/sub/f.txt');
    expect(vol.readFileSync('/srv/repoX/sub/f.txt', 'utf-8')).toBe('hi');
  });
});
