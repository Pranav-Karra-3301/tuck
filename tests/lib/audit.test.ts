import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME } from '../setup.js';

// Mock fs modules to use memfs
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs.promises;
});

vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs;
});

// Mock os.homedir to return test home
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

// Import after mocks are set up
import {
  logAuditEntry,
  logForceSecretBypass,
  logForcePush,
  logSecretsCommitted,
  logDangerousConfirmed,
  getRecentAuditEntries,
  hasRecentDangerousOperations,
} from '../../src/lib/audit.js';
import path from 'path';

describe('Audit Logging', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(path.join(TEST_HOME, '.tuck'), { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    vi.restoreAllMocks();
  });

  describe('logAuditEntry', () => {
    it('should create audit log file if it does not exist', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force', 'Test push');

      const logPath = path.join(TEST_HOME, '.tuck', 'audit.log');
      expect(vol.existsSync(logPath)).toBe(true);
    });

    it('should append entries to existing log file', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force', 'First push');
      await logAuditEntry('FORCE_SECRET_BYPASS', 'tuck add --force', 'Second action');

      const logPath = path.join(TEST_HOME, '.tuck', 'audit.log');
      const content = vol.readFileSync(logPath, 'utf-8') as string;
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);
    });

    it('should include timestamp in entries', async () => {
      await logAuditEntry('DANGEROUS_CONFIRMED', 'test', 'details');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include action type in entries', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].action).toBe('FORCE_PUSH');
    });

    it('should include command in entries', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].command).toBe('tuck push --force');
    });

    it('should include optional details', async () => {
      await logAuditEntry('SECRETS_COMMITTED', 'tuck add', 'file1.txt, file2.txt');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].details).toBe('file1.txt, file2.txt');
    });
  });

  describe('logForceSecretBypass', () => {
    it('should log force secret bypass with file count', async () => {
      await logForceSecretBypass('tuck add --force', 3);

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].action).toBe('FORCE_SECRET_BYPASS');
      expect(entries[0].details).toContain('3 file(s)');
    });
  });

  describe('logForcePush', () => {
    it('should log force push with branch name', async () => {
      await logForcePush('main');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].action).toBe('FORCE_PUSH');
      expect(entries[0].details).toContain('main');
    });
  });

  describe('logSecretsCommitted', () => {
    it('should log secrets committed with file list', async () => {
      await logSecretsCommitted(['file1.txt', 'file2.txt']);

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].action).toBe('SECRETS_COMMITTED');
      expect(entries[0].details).toContain('file1.txt');
    });

    it('should truncate long file lists', async () => {
      const files = Array.from({ length: 15 }, (_, i) => `file${i}.txt`);
      await logSecretsCommitted(files);

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].details).toContain('and 5 more');
    });
  });

  describe('logDangerousConfirmed', () => {
    it('should log dangerous operation confirmation', async () => {
      await logDangerousConfirmed('force overwrite', 'Overwriting backup files');

      const entries = await getRecentAuditEntries(1);
      expect(entries[0].action).toBe('DANGEROUS_CONFIRMED');
      expect(entries[0].command).toBe('force overwrite');
      expect(entries[0].details).toBe('Overwriting backup files');
    });
  });

  describe('getRecentAuditEntries', () => {
    it('should return empty array when no log exists', async () => {
      const entries = await getRecentAuditEntries();
      expect(entries).toEqual([]);
    });

    it('should return limited number of entries', async () => {
      for (let i = 0; i < 20; i++) {
        await logAuditEntry('DANGEROUS_CONFIRMED', `command${i}`);
      }

      const entries = await getRecentAuditEntries(5);
      expect(entries.length).toBe(5);
    });

    it('should return most recent entries', async () => {
      await logAuditEntry('DANGEROUS_CONFIRMED', 'first');
      await logAuditEntry('DANGEROUS_CONFIRMED', 'second');
      await logAuditEntry('DANGEROUS_CONFIRMED', 'third');

      const entries = await getRecentAuditEntries(2);
      expect(entries[0].command).toBe('second');
      expect(entries[1].command).toBe('third');
    });
  });

  describe('hasRecentDangerousOperations', () => {
    it('should return false when no operations', async () => {
      const hasRecent = await hasRecentDangerousOperations();
      expect(hasRecent).toBe(false);
    });

    it('should return true when recent operations exist', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force');

      const hasRecent = await hasRecentDangerousOperations(24);
      expect(hasRecent).toBe(true);
    });
  });
});
