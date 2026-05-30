import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { dirname } from 'path';
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
import { getRecentAuditEntries, hasRecentDangerousOperations } from '../../src/lib/audit.js';
import { getAuditLogPath } from '../../src/lib/state.js';

describe('Audit corrupt log handling', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    vi.restoreAllMocks();
  });

  function writeRawLog(...lines: string[]): void {
    const logPath = getAuditLogPath();
    vol.mkdirSync(dirname(logPath), { recursive: true });
    vol.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
  }

  it('should skip corrupted/garbage log lines instead of fabricating "unknown" entries', async () => {
    const valid = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'FORCE_PUSH',
      command: 'tuck push --force',
    });
    writeRawLog('this is not json {{{', valid, '{ broken json ]');

    const entries = await getRecentAuditEntries(10);

    // Only the single valid entry should be returned; garbage lines are skipped.
    expect(entries.length).toBe(1);
    expect(entries[0].command).toBe('tuck push --force');
    // No fabricated 'unknown' timestamps should leak through.
    expect(entries.some((e) => e.timestamp === 'unknown')).toBe(false);
  });

  it('should not produce NaN in the sort when a corrupted line is present', async () => {
    const older = JSON.stringify({
      timestamp: '2020-01-01T00:00:00.000Z',
      action: 'FORCE_PUSH',
      command: 'older',
    });
    const newer = JSON.stringify({
      timestamp: '2024-01-01T00:00:00.000Z',
      action: 'FORCE_PUSH',
      command: 'newer',
    });
    writeRawLog(newer, 'garbage line that cannot parse', older);

    const entries = await getRecentAuditEntries(10);

    // Both valid entries returned, sorted oldest -> newest, garbage skipped.
    expect(entries.length).toBe(2);
    expect(entries[0].command).toBe('older');
    expect(entries[1].command).toBe('newer');
    // Every returned timestamp must parse to a real (non-NaN) number.
    for (const entry of entries) {
      expect(Number.isNaN(new Date(entry.timestamp).getTime())).toBe(false);
    }
  });

  it('should not crash and should return a clean recency result with a corrupted line', async () => {
    const recent = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'FORCE_PUSH',
      command: 'recent',
    });
    writeRawLog('totally corrupted !!!', recent);

    // A fabricated 'unknown' timestamp would make this throw/return based on NaN.
    const hasRecent = await hasRecentDangerousOperations(24);
    expect(hasRecent).toBe(true);
  });

  it('should report no recent operations when only a corrupted line exists', async () => {
    writeRawLog('garbage only, no valid entries');

    const hasRecent = await hasRecentDangerousOperations(24);
    // A fabricated 'unknown' entry would yield NaN-based false here regardless,
    // but the corrupted line must not be treated as a recent operation.
    expect(hasRecent).toBe(false);
  });
});
