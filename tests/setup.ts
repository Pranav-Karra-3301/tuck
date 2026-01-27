import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';

// Test environment constants - exported for use in tests
// Use forward slashes consistently for memfs compatibility, but provide
// platform-native versions for path.join() comparisons
export const TEST_HOME = '/test-home';
export const TEST_TUCK_DIR = '/test-home/.tuck';
export const TEST_FILES_DIR = '/test-home/.tuck/files';

// Platform-native path versions (for comparing with path.join() results on Windows)
export const TEST_HOME_NATIVE = process.platform === 'win32' ? '\\test-home' : '/test-home';
export const TEST_TUCK_DIR_NATIVE =
  process.platform === 'win32' ? '\\test-home\\.tuck' : '/test-home/.tuck';
export const TEST_FILES_DIR_NATIVE =
  process.platform === 'win32' ? '\\test-home\\.tuck\\files' : '/test-home/.tuck/files';

// Store original HOME for restoration
const originalHome = process.env.HOME;

// Mock os.homedir to return TEST_HOME
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

// Mock fs modules globally for all tests
vi.mock('fs', async () => {
  const memfs = await import('memfs');
  return memfs.fs;
});

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return memfs.fs.promises;
});

// Mock fs-extra to work with memfs
vi.mock('fs-extra', async () => {
  const { join, dirname } = await import('path');
  return {
    copy: async (
      src: string,
      dest: string,
      options?: { overwrite?: boolean; filter?: (s: string) => boolean }
    ) => {
      const { vol } = await import('memfs');
      const copyRecursive = async (source: string, destination: string) => {
        const srcStats = vol.statSync(source);
        if (srcStats.isDirectory()) {
          vol.mkdirSync(destination, { recursive: true });
          const entries = vol.readdirSync(source);
          for (const entry of entries) {
            const srcPath = join(source, entry as string);
            const destPath = join(destination, entry as string);
            // Check filter
            if (options?.filter && !options.filter(srcPath)) continue;
            await copyRecursive(srcPath, destPath);
          }
        } else {
          vol.mkdirSync(dirname(destination), { recursive: true });
          vol.writeFileSync(destination, vol.readFileSync(source));
        }
      };
      await copyRecursive(src, dest);
    },
    ensureDir: async (dir: string) => {
      const { vol } = await import('memfs');
      vol.mkdirSync(dir, { recursive: true });
    },
  };
});

// Setup test environment
beforeAll(() => {
  // Set HOME to test directory
  process.env.HOME = TEST_HOME;
});

afterAll(() => {
  // Restore original HOME
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Reset virtual filesystem before each test
  vol.reset();
  // Create base home directory
  vol.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  // Cleanup after each test
  vol.reset();
});
