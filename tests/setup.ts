import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';

// Mock fs modules
beforeAll(() => {
  // Setup any global test configuration
});

afterAll(() => {
  // Cleanup any global test resources
});

beforeEach(() => {
  // Reset virtual filesystem before each test
  vol.reset();
});

afterEach(() => {
  // Cleanup after each test
  vol.reset();
});
