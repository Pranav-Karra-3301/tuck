import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatBytes } from '../../src/lib/files.js';

describe('files', () => {
  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(2621440)).toBe('2.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });
});
