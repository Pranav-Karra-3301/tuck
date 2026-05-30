/**
 * Regression tests for snapshot restore atomicity + metadata validation.
 *
 * These cover the P0 data-loss hardening of `src/lib/timemachine.ts`:
 *   (a) a corrupted metadata.json is skipped gracefully (listSnapshots /
 *       getSnapshot must not crash the whole list).
 *   (b) a restore/undo that hits a mid-loop error rolls back to the
 *       pre-restore state (best-effort rollback) and rethrows.
 *   (c) the documented pre-undo safety snapshot still captures a file the
 *       user created after the original snapshot, AND rollback works when a
 *       partial failure occurs while deleting it.
 *
 * Matches the neighboring `timemachine.test.ts` memfs pattern (os.homedir is
 * mocked to /test-home by tests/setup.ts) so nothing touches the real home
 * directory. `fs-extra.copy` is made fault-injectable via a module-level
 * control so we can simulate a mid-loop failure without real I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../setup.js';

// Module-level fault injection for the fs-extra `copy` mock. When
// `copyFailOn` is set, any copy whose DESTINATION contains that substring
// throws — letting us simulate a mid-restore-loop failure.
let copyFailOn: string | null = null;

vi.mock('fs-extra', async () => {
  const { join, dirname } = await import('path');
  return {
    pathExists: async (path: string) => {
      const { vol } = await import('memfs');
      try {
        vol.statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    ensureDir: async (dir: string) => {
      const { vol } = await import('memfs');
      vol.mkdirSync(dir, { recursive: true });
    },
    copy: async (
      src: string,
      dest: string,
      _options?: { overwrite?: boolean; preserveTimestamps?: boolean }
    ) => {
      if (copyFailOn && dest.includes(copyFailOn)) {
        throw new Error(`injected copy failure for ${dest}`);
      }
      const { vol } = await import('memfs');
      const copyRecursive = async (source: string, destination: string) => {
        const srcStats = vol.statSync(source);
        if (srcStats.isDirectory()) {
          vol.mkdirSync(destination, { recursive: true });
          const entries = vol.readdirSync(source);
          for (const entry of entries) {
            const srcPath = join(source, entry as string);
            const destPath = join(destination, entry as string);
            await copyRecursive(srcPath, destPath);
          }
        } else {
          vol.mkdirSync(dirname(destination), { recursive: true });
          vol.writeFileSync(destination, vol.readFileSync(source));
        }
      };
      await copyRecursive(src, dest);
    },
  };
});

// Import after mocking
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
} from '../../src/lib/timemachine.js';
import { getSnapshotsDir } from '../../src/lib/state.js';
import { snapshotMetadataSchema } from '../../src/schemas/snapshot.schema.js';

const TIMEMACHINE_DIR = getSnapshotsDir();

describe('timemachine atomicity + validation', () => {
  beforeEach(() => {
    copyFailOn = null;
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(join(TEST_HOME, '.tuck'), { recursive: true });
  });

  afterEach(() => {
    copyFailOn = null;
    vol.reset();
  });

  // ==========================================================================
  // snapshotMetadataSchema
  // ==========================================================================

  describe('snapshotMetadataSchema', () => {
    it('parses a well-formed metadata object', () => {
      const meta = {
        id: '2024-06-15-143022',
        timestamp: '2024-06-15T14:30:22.000Z',
        reason: 'Test backup',
        files: [
          {
            originalPath: '/test-home/.zshrc',
            backupPath: '/test-home/snap/files/.zshrc',
            existed: true,
          },
        ],
        machine: 'test-machine',
      };
      const parsed = snapshotMetadataSchema.parse(meta);
      expect(parsed.id).toBe('2024-06-15-143022');
      expect(parsed.files[0].existed).toBe(true);
    });

    it('accepts an optional profile', () => {
      const meta = {
        id: 'x',
        timestamp: 't',
        reason: 'r',
        files: [],
        machine: 'm',
        profile: 'work',
      };
      expect(snapshotMetadataSchema.parse(meta).profile).toBe('work');
    });

    it('rejects metadata missing required fields', () => {
      expect(() =>
        snapshotMetadataSchema.parse({ id: 'x' })
      ).toThrow();
    });

    it('rejects a file entry with a non-boolean existed flag', () => {
      const meta = {
        id: 'x',
        timestamp: 't',
        reason: 'r',
        files: [{ originalPath: '/a', backupPath: '/b', existed: 'yes' }],
        machine: 'm',
      };
      expect(() => snapshotMetadataSchema.parse(meta)).toThrow();
    });
  });

  // ==========================================================================
  // (a) corrupted metadata is skipped, not fatal
  // ==========================================================================

  describe('corrupted metadata handling', () => {
    it('listSnapshots skips a snapshot whose metadata.json is unparseable JSON', async () => {
      // One good snapshot.
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');
      const good = await createSnapshot([join(TEST_HOME, '.zshrc')], 'Good');

      // One corrupted snapshot dir alongside it.
      const badDir = join(TIMEMACHINE_DIR, '2024-01-01-000000');
      vol.mkdirSync(badDir, { recursive: true });
      vol.writeFileSync(join(badDir, 'metadata.json'), '{ this is not json');

      const snapshots = await listSnapshots();

      // The good one survives; the corrupt one is dropped, no throw.
      expect(snapshots.map((s) => s.id)).toContain(good.id);
      expect(snapshots.map((s) => s.id)).not.toContain('2024-01-01-000000');
    });

    it('listSnapshots skips a snapshot whose metadata violates the schema', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');
      const good = await createSnapshot([join(TEST_HOME, '.zshrc')], 'Good');

      // Valid JSON, but wrong shape (files is a string, missing fields).
      const badDir = join(TIMEMACHINE_DIR, '2024-02-02-000000');
      vol.mkdirSync(badDir, { recursive: true });
      vol.writeFileSync(
        join(badDir, 'metadata.json'),
        JSON.stringify({ id: '2024-02-02-000000', files: 'nope' })
      );

      const snapshots = await listSnapshots();

      expect(snapshots.map((s) => s.id)).toContain(good.id);
      expect(snapshots.map((s) => s.id)).not.toContain('2024-02-02-000000');
    });

    it('getSnapshot returns null for a schema-invalid metadata.json instead of throwing', async () => {
      const badDir = join(TIMEMACHINE_DIR, '2024-03-03-000000');
      vol.mkdirSync(badDir, { recursive: true });
      vol.writeFileSync(
        join(badDir, 'metadata.json'),
        JSON.stringify({ id: '2024-03-03-000000', files: 42 })
      );

      const snap = await getSnapshot('2024-03-03-000000');
      expect(snap).toBeNull();
    });
  });

  // ==========================================================================
  // (b) mid-loop restore failure rolls back to pre-restore state
  // ==========================================================================

  describe('restore atomicity / rollback', () => {
    it('rolls back overwritten files when a later file in the restore loop fails', async () => {
      const fileA = join(TEST_HOME, '.aaa');
      const fileB = join(TEST_HOME, '.zzz');
      vol.writeFileSync(fileA, 'A-original');
      vol.writeFileSync(fileB, 'B-original');

      // Snapshot captures both originals.
      const snap = await createSnapshot([fileA, fileB], 'Before changes');

      // User modifies both live files.
      vol.writeFileSync(fileA, 'A-live');
      vol.writeFileSync(fileB, 'B-live');

      // Inject a failure when STAGING the restore of fileB. The restore stages
      // each backup into a `<dest>.tuck-restore-*.tmp` file before renaming it
      // into place, so matching the staging marker for `.zzz` fails the forward
      // restore of fileB without also tripping the (different-path) rollback
      // copies — modelling a single transient forward-path failure.
      copyFailOn = '.zzz.tuck-restore-';

      await expect(restoreSnapshot(snap.id)).rejects.toThrow();

      // After the failed restore, BOTH live files must be back to their
      // pre-restore ("live") state — fileA must NOT be left half-restored to
      // 'A-original'. Rollback restores the pre-restore safety snapshot.
      expect(vol.readFileSync(fileA, 'utf-8')).toBe('A-live');
      expect(vol.readFileSync(fileB, 'utf-8')).toBe('B-live');
    });

    it('does not lose a user-created file when restore fails mid-loop', async () => {
      // fileKeep exists at snapshot time; fileNew is created by the user later
      // and would be rm'd by a successful undo. If the undo fails partway, the
      // user-created file must survive (rolled back).
      const fileKeep = join(TEST_HOME, '.keep');
      const fileNew = join(TEST_HOME, '.created-later');
      vol.writeFileSync(fileKeep, 'keep-original');

      // Snapshot: .created-later did NOT exist (listed first so the restore
      // loop deletes it BEFORE the failure), .keep existed.
      const snap = await createSnapshot([fileNew, fileKeep], 'Initial');

      // User changes .keep and creates .created-later with valuable data.
      vol.writeFileSync(fileKeep, 'keep-live');
      vol.writeFileSync(fileNew, 'valuable-user-data');

      // The restore loop first deletes .created-later (it didn't exist in the
      // snapshot), then fails while staging the restore of .keep — forcing a
      // rollback that must bring the deleted user file back.
      copyFailOn = '.keep.tuck-restore-';

      await expect(restoreSnapshot(snap.id)).rejects.toThrow();

      // Rollback must have restored the pre-restore state of every touched
      // path: the user's valuable file is intact, .keep is back to 'keep-live'.
      expect(vol.existsSync(fileNew)).toBe(true);
      expect(vol.readFileSync(fileNew, 'utf-8')).toBe('valuable-user-data');
      expect(vol.readFileSync(fileKeep, 'utf-8')).toBe('keep-live');
    });
  });
});
