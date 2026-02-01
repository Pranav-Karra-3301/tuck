/**
 * Test helpers for sandboxed testing
 */

import { vol } from 'memfs';
import { join, dirname } from 'path';
import { createMockConfig, createMockManifest } from './factories.js';
import type { TuckConfigOutput } from '../../src/schemas/config.schema.js';
import type { TuckManifestOutput } from '../../src/schemas/manifest.schema.js';

// Test environment constants
export const TEST_HOME = '/test-home';
export const TEST_TUCK_DIR = '/test-home/.tuck';
export const TEST_FILES_DIR = '/test-home/.tuck/files';
export const TEST_BACKUPS_DIR = '/test-home/.tuck-backups';

/**
 * Initialize a complete tuck environment for testing
 */
export const initTestTuck = async (options?: {
  files?: Record<string, string>; // Additional files to create
  config?: Partial<TuckConfigOutput>;
  manifest?: Partial<TuckManifestOutput>;
  tracked?: Record<string, string>; // Tracked files with content
}): Promise<void> => {
  // Create directory structure
  const dirs = [
    TEST_HOME,
    TEST_TUCK_DIR,
    TEST_FILES_DIR,
    TEST_BACKUPS_DIR,
    join(TEST_FILES_DIR, 'shell'),
    join(TEST_FILES_DIR, 'git'),
    join(TEST_FILES_DIR, 'editors'),
    join(TEST_FILES_DIR, 'terminal'),
    join(TEST_FILES_DIR, 'ssh'),
    join(TEST_FILES_DIR, 'misc'),
  ];

  for (const dir of dirs) {
    vol.mkdirSync(dir, { recursive: true });
  }

  // Create config file
  const config = createMockConfig(options?.config);
  vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckrc.json'), JSON.stringify(config, null, 2));

  // Create manifest file
  const manifest = createMockManifest(options?.manifest);
  vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));

  // Create .gitignore
  vol.writeFileSync(join(TEST_TUCK_DIR, '.gitignore'), '.DS_Store\n*.bak\n');

  // Create tracked files if specified
  if (options?.tracked) {
    for (const [path, content] of Object.entries(options.tracked)) {
      const fullPath = path.startsWith('/') ? path : join(TEST_HOME, path);
      const dir = join(fullPath, '..');
      vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(fullPath, content);
    }
  }

  // Create additional files if provided
  if (options?.files) {
    for (const [path, content] of Object.entries(options.files)) {
      const fullPath = path.startsWith('/') ? path : join(TEST_HOME, path);
      const dir = join(fullPath, '..');
      vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(fullPath, content);
    }
  }

  // Initialize git directory (mock)
  vol.mkdirSync(join(TEST_TUCK_DIR, '.git'), { recursive: true });
  vol.writeFileSync(join(TEST_TUCK_DIR, '.git', 'HEAD'), 'ref: refs/heads/main');
};

/**
 * Create a test dotfile in the home directory
 */
export const createTestDotfile = (
  name: string,
  content: string,
  options?: { subdir?: string }
): string => {
  const basePath = options?.subdir ? join(TEST_HOME, options.subdir) : TEST_HOME;
  const fullPath = join(basePath, name);

  // Create the parent directory of the full path (handles nested paths like .local/bin/script.sh)
  const parentDir = dirname(fullPath);
  vol.mkdirSync(parentDir, { recursive: true });
  vol.writeFileSync(fullPath, content);

  return fullPath;
};

/**
 * Get the current state of the test filesystem
 */
export const getTestFilesystem = (): Record<string, string | Buffer> => {
  return vol.toJSON() as Record<string, string | Buffer>;
};

/**
 * Check if a file exists in the test filesystem
 */
export const testFileExists = (path: string): boolean => {
  try {
    vol.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read a file from the test filesystem
 */
export const readTestFile = (path: string): string => {
  return vol.readFileSync(path, 'utf-8') as string;
};

/**
 * Read JSON from test filesystem
 */
export const readTestJson = <T>(path: string): T => {
  const content = readTestFile(path);
  return JSON.parse(content) as T;
};

/**
 * Get the test manifest
 */
export const getTestManifest = (): TuckManifestOutput => {
  return readTestJson<TuckManifestOutput>(join(TEST_TUCK_DIR, '.tuckmanifest.json'));
};

/**
 * Get the test config
 */
export const getTestConfig = (): TuckConfigOutput => {
  return readTestJson<TuckConfigOutput>(join(TEST_TUCK_DIR, '.tuckrc.json'));
};

/**
 * Reset the test environment
 */
export const resetTestEnv = (): void => {
  vol.reset();
};
