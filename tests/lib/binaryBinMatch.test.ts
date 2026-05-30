import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Per-test fake home directory, set before importing the module under test.
let fakeHome: string;

// Mock the platform module (binary.ts depends on IS_WINDOWS).
const mockIsWindows = vi.fn(() => false);
vi.mock('../../src/lib/platform.js', () => ({
  get IS_WINDOWS() {
    return mockIsWindows();
  },
  IS_MACOS: false,
  IS_LINUX: true,
  expandWindowsEnvVars: (path: string) => path,
  toPosixPath: (path: string) => path.replace(/\\/g, '/'),
  fromPosixPath: (path: string) => path,
  normalizePath: (path: string) => path,
}));

// Mock os.homedir so that ~/bin and ~/.local/bin resolve under our tmp root,
// without ever touching the real home directory.
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return {
    ...original,
    homedir: () => fakeHome,
  };
});

describe('shouldExcludeFromBin bin-root matching', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsWindows.mockReturnValue(false);
    fakeHome = join(tmpdir(), `tuck-binmatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(fakeHome, { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    try {
      await rm(fakeHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Write an ELF binary executable (magic numbers + execute bit) at the path. */
  async function writeBinary(filePath: string): Promise<void> {
    const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    await writeFile(filePath, elfHeader);
    await chmod(filePath, 0o755);
  }

  it('should NOT exclude a binary under ~/projects/bin (parent basename is bin but not a bin root)', async () => {
    const { shouldExcludeFromBin } = await import('../../src/lib/binary.js');
    const dir = join(fakeHome, 'projects', 'bin');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'script');
    await writeBinary(filePath);

    expect(await shouldExcludeFromBin(filePath)).toBe(false);
  });

  it('should exclude a binary under ~/bin', async () => {
    const { shouldExcludeFromBin } = await import('../../src/lib/binary.js');
    const dir = join(fakeHome, 'bin');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'script');
    await writeBinary(filePath);

    expect(await shouldExcludeFromBin(filePath)).toBe(true);
  });

  it('should exclude a binary under ~/.local/bin', async () => {
    const { shouldExcludeFromBin } = await import('../../src/lib/binary.js');
    const dir = join(fakeHome, '.local', 'bin');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'script');
    await writeBinary(filePath);

    expect(await shouldExcludeFromBin(filePath)).toBe(true);
  });

  it('should NOT exclude a binary under a sibling like ~/.local/foo-bin', async () => {
    const { shouldExcludeFromBin } = await import('../../src/lib/binary.js');
    const dir = join(fakeHome, '.local', 'foo-bin');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'script');
    await writeBinary(filePath);

    expect(await shouldExcludeFromBin(filePath)).toBe(false);
  });

  it('should still NOT exclude a script under ~/bin', async () => {
    const { shouldExcludeFromBin } = await import('../../src/lib/binary.js');
    const dir = join(fakeHome, 'bin');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'myscript');
    await writeFile(filePath, '#!/bin/bash\necho hello');
    await chmod(filePath, 0o755);

    expect(await shouldExcludeFromBin(filePath)).toBe(false);
  });
});
