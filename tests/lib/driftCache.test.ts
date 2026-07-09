import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDriftKey,
  computePlaintextHmac,
  recordDriftEntry,
  getDriftEntry,
  compareLiveToCache,
  readDriftCache,
  resetDriftKeyCache,
} from '../../src/lib/crypto/driftCache.js';

// memfs + mocked homedir come from tests/setup.ts. The drift key/cache live
// under the per-machine state dir, which resolves inside the mocked home.

describe('driftCache', () => {
  beforeEach(() => {
    // The HMAC key is memoized in-process; memfs is reset per test, so drop the
    // stale in-memory key too or a later test would reuse a key whose file is gone.
    resetDriftKeyCache();
  });

  describe('getDriftKey', () => {
    it('returns null when absent and create=false (read-only never writes)', async () => {
      expect(await getDriftKey(false)).toBeNull();
    });

    it('generates and persists a 32-byte key when create=true', async () => {
      const key = await getDriftKey(true);
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
      // Persisted: a fresh in-process load (create=false) now finds it.
      resetDriftKeyCache();
      const again = await getDriftKey(false);
      expect(again).not.toBeNull();
      expect(again!.equals(key!)).toBe(true);
    });
  });

  describe('computePlaintextHmac', () => {
    it('is deterministic for the same key + input', () => {
      const key = Buffer.alloc(32, 7);
      expect(computePlaintextHmac('hello', key)).toBe(computePlaintextHmac('hello', key));
    });

    it('differs for different keys (keyed, not a bare checksum)', () => {
      const a = computePlaintextHmac('hello', Buffer.alloc(32, 1));
      const b = computePlaintextHmac('hello', Buffer.alloc(32, 2));
      expect(a).not.toBe(b);
    });

    it('treats a utf8 string and its Buffer identically', () => {
      const key = Buffer.alloc(32, 3);
      expect(computePlaintextHmac('body', key)).toBe(
        computePlaintextHmac(Buffer.from('body', 'utf8'), key)
      );
    });
  });

  describe('record + compare round-trip', () => {
    it('reports match for unchanged live bytes, mismatch after an edit', async () => {
      await recordDriftEntry('file1', 'plaintext-body', 'repo-sum-1');

      expect(await compareLiveToCache('file1', 'plaintext-body', 'repo-sum-1')).toBe('match');
      expect(await compareLiveToCache('file1', 'EDITED-body', 'repo-sum-1')).toBe('mismatch');
    });

    it('reports unknown when the repo copy moved on (stale fingerprint)', async () => {
      await recordDriftEntry('file1', 'body', 'repo-sum-1');
      // Same live bytes, but the repo checksum changed (e.g. git pull).
      expect(await compareLiveToCache('file1', 'body', 'repo-sum-2')).toBe('unknown');
    });

    it('reports unknown for an unrecorded file id', async () => {
      await recordDriftEntry('file1', 'body', 'repo-sum-1');
      expect(await compareLiveToCache('other', 'body', 'repo-sum-1')).toBe('unknown');
    });

    it('reports unknown when no key exists yet (nothing recorded)', async () => {
      expect(await compareLiveToCache('file1', 'body', 'repo-sum-1')).toBe('unknown');
    });

    it('persists the entry with a pinned repo checksum', async () => {
      await recordDriftEntry('file1', 'body', 'repo-sum-1');
      const entry = await getDriftEntry('file1');
      expect(entry).not.toBeNull();
      expect(entry!.repoChecksum).toBe('repo-sum-1');
      expect(typeof entry!.plaintextHmac).toBe('string');
    });

    it('recording twice refreshes the fingerprint in place', async () => {
      await recordDriftEntry('file1', 'v1', 'repo-sum-1');
      const first = (await getDriftEntry('file1'))!.plaintextHmac;
      await recordDriftEntry('file1', 'v2', 'repo-sum-2');
      const second = await getDriftEntry('file1');
      expect(second!.plaintextHmac).not.toBe(first);
      expect(second!.repoChecksum).toBe('repo-sum-2');
    });
  });

  describe('concurrency (single-flight key, serialized writes)', () => {
    it('concurrent first-warm getDriftKey(true) callers all receive the SAME key', async () => {
      const [a, b, ...rest] = await Promise.all(
        Array.from({ length: 6 }, () => getDriftKey(true))
      );
      expect(a).not.toBeNull();
      for (const k of [b, ...rest]) {
        expect(k?.equals(a as Buffer)).toBe(true);
      }
    });

    it('concurrent recordDriftEntry calls never lose entries', async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          recordDriftEntry(`file-${i}`, `plaintext-${i}`, `repo-${i}`)
        )
      );
      const cache = await readDriftCache();
      for (let i = 0; i < 8; i++) {
        expect(cache.entries[`file-${i}`]).toBeDefined();
      }
    });
  });

  describe('readDriftCache', () => {
    it('returns an empty cache when none exists', async () => {
      const cache = await readDriftCache();
      expect(cache.version).toBe(1);
      expect(cache.entries).toEqual({});
    });
  });
});
