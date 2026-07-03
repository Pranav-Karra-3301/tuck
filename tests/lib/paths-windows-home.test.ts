/**
 * Regression tests for the Windows drive-letter handling in isPathWithinHome.
 *
 * On Windows, homedir() is a drive-letter path (e.g. C:\Users\name), so the
 * unconditional drive-letter/UNC rejection previously classified EVERY real
 * home path as outside home, breaking backups, custom tuck dirs, and
 * absolute-path validation. The rejection must be gated to non-Windows only.
 *
 * We run on a POSIX test runner, so we use a forward-slash Windows-style home
 * ('C:/Users/name'): path.resolve treats it as relative and prefixes cwd
 * uniformly to both home and candidate, which still exercises the gate and the
 * case-insensitive comparison without depending on Win32 path semantics.
 */
import { describe, it, expect, vi } from 'vitest';

const WINDOWS_HOME = 'C:/Users/name';

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return {
    ...original,
    homedir: () => WINDOWS_HOME,
  };
});

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return {
    ...original,
    IS_WINDOWS: true,
  };
});

describe('isPathWithinHome on Windows', () => {
  it('should accept a drive-letter path inside the Windows home directory', async () => {
    const { isPathWithinHome } = await import('../../src/lib/paths.js');
    expect(isPathWithinHome('C:/Users/name/.gitconfig')).toBe(true);
    expect(isPathWithinHome('C:/Users/name')).toBe(true);
  });

  it('should accept a Windows home path case-insensitively (NTFS)', async () => {
    const { isPathWithinHome } = await import('../../src/lib/paths.js');
    expect(isPathWithinHome('C:/Users/Name/.gitconfig')).toBe(true);
  });

  it('should reject a drive-letter path outside the Windows home directory', async () => {
    const { isPathWithinHome } = await import('../../src/lib/paths.js');
    expect(isPathWithinHome('C:/Windows/System32')).toBe(false);
    expect(isPathWithinHome('C:/Users/other/.gitconfig')).toBe(false);
  });
});
