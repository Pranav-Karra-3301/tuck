/**
 * Prompts UI tests
 *
 * Tests non-interactive paths and environment variable handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store original values
const originalTTY = process.stdout.isTTY;
const originalEnv = process.env.TUCK_FORCE_DANGEROUS;

describe('prompts', () => {
  describe('confirmDangerous', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      // Restore original values
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalTTY,
        writable: true,
      });
      if (originalEnv === undefined) {
        delete process.env.TUCK_FORCE_DANGEROUS;
      } else {
        process.env.TUCK_FORCE_DANGEROUS = originalEnv;
      }
      vi.restoreAllMocks();
    });

    it('should return false in non-TTY mode without TUCK_FORCE_DANGEROUS', async () => {
      // Mock non-TTY environment
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
      });
      delete process.env.TUCK_FORCE_DANGEROUS;

      // Mock console methods to suppress output
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { prompts } = await import('../../src/ui/prompts.js');

      const result = await prompts.confirmDangerous('Test dangerous operation', 'confirm');

      expect(result).toBe(false);
    });

    it('should return true in non-TTY mode with TUCK_FORCE_DANGEROUS=true', async () => {
      // Mock non-TTY environment with env var set
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
      });
      process.env.TUCK_FORCE_DANGEROUS = 'true';

      const { prompts } = await import('../../src/ui/prompts.js');

      const result = await prompts.confirmDangerous('Test dangerous operation', 'confirm');

      expect(result).toBe(true);
    });

    it('should return false in non-TTY mode with TUCK_FORCE_DANGEROUS=false', async () => {
      // Mock non-TTY environment with env var explicitly false
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
      });
      process.env.TUCK_FORCE_DANGEROUS = 'false';

      // Mock console methods to suppress output
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { prompts } = await import('../../src/ui/prompts.js');

      const result = await prompts.confirmDangerous('Test dangerous operation', 'confirm');

      expect(result).toBe(false);
    });

    it('should return false in non-TTY mode with empty TUCK_FORCE_DANGEROUS', async () => {
      // Mock non-TTY environment with empty env var
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
      });
      process.env.TUCK_FORCE_DANGEROUS = '';

      // Mock console methods to suppress output
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { prompts } = await import('../../src/ui/prompts.js');

      const result = await prompts.confirmDangerous('Test dangerous operation', 'confirm');

      expect(result).toBe(false);
    });
  });
});
