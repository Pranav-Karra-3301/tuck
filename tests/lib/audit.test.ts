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
} from '../../src/lib/audit.js';
import { getAuditLogPath } from '../../src/lib/state.js';

interface LoggedEntry {
  timestamp: string;
  action: string;
  command: string;
  details?: string;
}

/**
 * Read the audit log back off disk directly (the production readback helper was
 * removed as dead code). Parses the JSONL log file so tests still verify the
 * exact bytes the live audit writers append.
 */
function readAuditLog(): LoggedEntry[] {
  const logPath = getAuditLogPath();
  if (!vol.existsSync(logPath)) {
    return [];
  }
  const content = vol.readFileSync(logPath, 'utf-8') as string;
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEntry);
}

describe('Audit Logging', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    vi.restoreAllMocks();
  });

  describe('logAuditEntry', () => {
    it('should create audit log file if it does not exist', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force', 'Test push');

      const logPath = getAuditLogPath();
      expect(vol.existsSync(logPath)).toBe(true);
    });

    it('should append entries to existing log file', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force', 'First push');
      await logAuditEntry('FORCE_SECRET_BYPASS', 'tuck add --force', 'Second action');

      const entries = readAuditLog();
      expect(entries.length).toBe(2);
    });

    it('should include timestamp in entries', async () => {
      await logAuditEntry('DANGEROUS_CONFIRMED', 'test', 'details');

      const entries = readAuditLog();
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include action type in entries', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force');

      const entries = readAuditLog();
      expect(entries[0].action).toBe('FORCE_PUSH');
    });

    it('should include command in entries', async () => {
      await logAuditEntry('FORCE_PUSH', 'tuck push --force');

      const entries = readAuditLog();
      expect(entries[0].command).toBe('tuck push --force');
    });

    it('should include optional details', async () => {
      await logAuditEntry('SECRETS_COMMITTED', 'tuck add', 'file1.txt, file2.txt');

      const entries = readAuditLog();
      expect(entries[0].details).toBe('file1.txt, file2.txt');
    });
  });

  describe('logForceSecretBypass', () => {
    it('should log force secret bypass with file count', async () => {
      await logForceSecretBypass('tuck add --force', 3);

      const entries = readAuditLog();
      expect(entries[0].action).toBe('FORCE_SECRET_BYPASS');
      expect(entries[0].details).toContain('3 file(s)');
    });
  });

  describe('logForcePush', () => {
    it('should log force push with branch name', async () => {
      await logForcePush('main');

      const entries = readAuditLog();
      expect(entries[0].action).toBe('FORCE_PUSH');
      expect(entries[0].details).toContain('main');
    });
  });
});
