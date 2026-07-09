/**
 * Unit tests for the centralized secret allowlist.
 *
 * The allowlist is a committed `secrets.allow.json` file that suppresses
 * scanner findings the user has marked safe. These tests exercise the lib in
 * isolation over the memfs sandbox: fingerprinting, CRUD, scoped matching, and
 * the summary filter that every scan path runs through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { readFileSync } from 'fs';
import { TEST_TUCK_DIR } from '../../setup.js';
import {
  computeFingerprint,
  getAllowlistPath,
  loadAllowlist,
  addAllowlistEntryByFingerprint,
  addAllowlistEntryForValue,
  removeAllowlistEntries,
  listAllowlistEntries,
  isMatchAllowed,
  filterSummaryWithAllowlist,
} from '../../../src/lib/secrets/allowlist.js';
import type { ScanSummary, SecretMatch } from '../../../src/lib/secrets/scanner.js';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

const makeMatch = (over: Partial<SecretMatch> = {}): SecretMatch => ({
  patternId: 'aws-access-key-id',
  patternName: 'AWS Access Key ID',
  severity: 'high',
  value: SECRET,
  redactedValue: '[REDACTED]',
  line: 1,
  column: 1,
  context: 'key = [REDACTED]',
  placeholder: 'AWS_ACCESS_KEY_ID',
  ...over,
});

const makeSummary = (matches: SecretMatch[], collapsedPath = '~/.config/app'): ScanSummary => ({
  totalFiles: 1,
  scannedFiles: 1,
  skippedFiles: 0,
  filesWithSecrets: matches.length > 0 ? 1 : 0,
  totalSecrets: matches.length,
  bySeverity: {
    critical: matches.filter((m) => m.severity === 'critical').length,
    high: matches.filter((m) => m.severity === 'high').length,
    medium: matches.filter((m) => m.severity === 'medium').length,
    low: matches.filter((m) => m.severity === 'low').length,
  },
  results: [
    {
      path: '/test-home/.config/app',
      collapsedPath,
      hasSecrets: matches.length > 0,
      matches,
      criticalCount: matches.filter((m) => m.severity === 'critical').length,
      highCount: matches.filter((m) => m.severity === 'high').length,
      mediumCount: matches.filter((m) => m.severity === 'medium').length,
      lowCount: matches.filter((m) => m.severity === 'low').length,
      skipped: false,
    },
  ],
});

describe('secret allowlist lib', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => {
    vol.reset();
  });

  describe('computeFingerprint', () => {
    it('produces a stable 64-char sha256 hex digest', () => {
      const fp = computeFingerprint(SECRET);
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
      expect(fp).toBe(computeFingerprint(SECRET));
    });

    it('differs for different values', () => {
      expect(computeFingerprint('a')).not.toBe(computeFingerprint('b'));
    });
  });

  describe('load/save', () => {
    it('returns an empty store when the file is absent', async () => {
      const store = await loadAllowlist(TEST_TUCK_DIR);
      expect(store.entries).toEqual([]);
    });

    it('never writes the raw secret value to disk', async () => {
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, { reason: 'example from docs' });
      const raw = readFileSync(getAllowlistPath(TEST_TUCK_DIR), 'utf-8');
      expect(raw).not.toContain(SECRET);
      expect(raw).toContain(computeFingerprint(SECRET));
    });

    it('throws on a corrupt allowlist rather than silently disabling scanning', async () => {
      vol.writeFileSync(getAllowlistPath(TEST_TUCK_DIR), '{ not valid json');
      await expect(loadAllowlist(TEST_TUCK_DIR)).rejects.toThrow(/Failed to load secret allowlist/);
    });
  });

  describe('add/remove/list', () => {
    it('adds an entry and lists it', async () => {
      const entry = await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, {
        reason: 'test placeholder',
        pattern: 'aws-access-key-id',
        path: '~/.config/app',
        addedBy: 'tester',
      });
      expect(entry.fingerprint).toBe(computeFingerprint(SECRET));
      expect(entry.addedBy).toBe('tester');

      const entries = await listAllowlistEntries(TEST_TUCK_DIR);
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('test placeholder');
    });

    it('deduplicates by fingerprint+pattern+path (refresh, not append)', async () => {
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, {
        reason: 'first',
        pattern: 'aws-access-key-id',
        path: '~/.config/app',
      });
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, {
        reason: 'second',
        pattern: 'aws-access-key-id',
        path: '~/.config/app',
      });
      const entries = await listAllowlistEntries(TEST_TUCK_DIR);
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('second');
    });

    it('keeps entries with different scopes separate', async () => {
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, { reason: 'global' });
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, {
        reason: 'scoped',
        path: '~/.config/app',
      });
      expect(await listAllowlistEntries(TEST_TUCK_DIR)).toHaveLength(2);
    });

    it('removes entries by fingerprint prefix', async () => {
      const entry = await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, { reason: 'x' });
      const removed = await removeAllowlistEntries(TEST_TUCK_DIR, entry.fingerprint.slice(0, 8));
      expect(removed).toHaveLength(1);
      expect(await listAllowlistEntries(TEST_TUCK_DIR)).toHaveLength(0);
    });

    it('returns empty when no entry matches the removal prefix', async () => {
      await addAllowlistEntryForValue(TEST_TUCK_DIR, SECRET, { reason: 'x' });
      const removed = await removeAllowlistEntries(TEST_TUCK_DIR, 'deadbeef');
      expect(removed).toHaveLength(0);
      expect(await listAllowlistEntries(TEST_TUCK_DIR)).toHaveLength(1);
    });
  });

  describe('isMatchAllowed', () => {
    it('matches a global (unscoped) entry anywhere', () => {
      const entries = [
        { fingerprint: computeFingerprint(SECRET), reason: 'r', addedAt: 'now' },
      ];
      expect(isMatchAllowed(makeMatch(), '~/anywhere', entries)).toBe(true);
    });

    it('respects a pattern scope', () => {
      const entries = [
        {
          fingerprint: computeFingerprint(SECRET),
          reason: 'r',
          pattern: 'aws-access-key-id',
          addedAt: 'now',
        },
      ];
      expect(isMatchAllowed(makeMatch(), '~/x', entries)).toBe(true);
      expect(isMatchAllowed(makeMatch({ patternId: 'other' }), '~/x', entries)).toBe(false);
    });

    it('respects a path scope', () => {
      const entries = [
        {
          fingerprint: computeFingerprint(SECRET),
          reason: 'r',
          path: '~/.config/app',
          addedAt: 'now',
        },
      ];
      expect(isMatchAllowed(makeMatch(), '~/.config/app', entries)).toBe(true);
      expect(isMatchAllowed(makeMatch(), '~/.config/other', entries)).toBe(false);
    });

    it('does not match a different value', () => {
      const entries = [
        { fingerprint: computeFingerprint('different'), reason: 'r', addedAt: 'now' },
      ];
      expect(isMatchAllowed(makeMatch(), '~/x', entries)).toBe(false);
    });
  });

  describe('filterSummaryWithAllowlist', () => {
    it('is a no-op with no entries', () => {
      const summary = makeSummary([makeMatch()]);
      expect(filterSummaryWithAllowlist(summary, [])).toBe(summary);
    });

    it('drops an allowlisted finding and recomputes counts', () => {
      const summary = makeSummary([makeMatch()]);
      const entries = [
        { fingerprint: computeFingerprint(SECRET), reason: 'r', addedAt: 'now' },
      ];
      const filtered = filterSummaryWithAllowlist(summary, entries);
      expect(filtered.totalSecrets).toBe(0);
      expect(filtered.filesWithSecrets).toBe(0);
      expect(filtered.results).toHaveLength(0);
      expect(filtered.bySeverity.high).toBe(0);
      // Scan-level counters are unchanged.
      expect(filtered.scannedFiles).toBe(1);
    });

    it('keeps non-allowlisted findings in a mixed file', () => {
      const kept = makeMatch({ value: 'REAL_SECRET_VALUE_123', line: 2 });
      const summary = makeSummary([makeMatch(), kept]);
      const entries = [
        { fingerprint: computeFingerprint(SECRET), reason: 'r', addedAt: 'now' },
      ];
      const filtered = filterSummaryWithAllowlist(summary, entries);
      expect(filtered.totalSecrets).toBe(1);
      expect(filtered.filesWithSecrets).toBe(1);
      expect(filtered.results[0].matches[0].value).toBe('REAL_SECRET_VALUE_123');
    });
  });
});
