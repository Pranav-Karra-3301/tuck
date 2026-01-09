import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';

// Test environment constants - exported for use in tests
export const TEST_HOME = '/test-home';
export const TEST_TUCK_DIR = '/test-home/.tuck';
export const TEST_FILES_DIR = '/test-home/.tuck/files';

// Store original HOME for restoration
const originalHome = process.env.HOME;

// Mock fs modules globally for all tests
vi.mock('fs', async () => {
  const memfs = await import('memfs');
  return memfs.fs;
});

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return memfs.fs.promises;
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
