/**
 * File-hash mtime/size short-circuit tests.
 *
 * `computeFileState` re-hashes the LIVE source on every status/sync/verify. For
 * a SINGLE file whose recorded (mtime, size) still match the live file's stat,
 * the content cannot have changed under any normal edit, so we skip the
 * (potentially large) re-hash and reuse the recorded checksum — the standard
 * mtime+size cache that git/make use.
 *
 * These tests prove CORRECTNESS, not just speed:
 *   - an unchanged single file is short-circuited (getFileChecksum NOT called on
 *     the live source, state === 'ok'),
 *   - an edited file (content + mtime) is still detected as drift-local,
 *   - a same-mtime size change is still detected,
 *   - a DIRECTORY entry is NEVER short-circuited (a nested change doesn't move
 *     the dir's own mtime/size),
 *   - a LEGACY entry (no recorded mtime/size) falls back to full hashing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { statSync } from 'fs';
import { computeStateModel } from '../../src/lib/stateModel.js';
import * as filesModule from '../../src/lib/files.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { trackedFileSchema } from '../../src/schemas/manifest.schema.js';

describe('manifest schema legacy round-trip', () => {
  it('parses a legacy entry (no mtime/size fields) unchanged', () => {
    const legacy = {
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      category: 'shell',
      strategy: 'copy' as const,
      added: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      checksum: 'abc123',
    };
    const parsed = trackedFileSchema.parse(legacy);
    // Optional (never defaulted) — absent in, absent out.
    expect(parsed.sourceMtimeMs).toBeUndefined();
    expect(parsed.sourceSize).toBeUndefined();
    expect('sourceMtimeMs' in parsed).toBe(false);
    expect('sourceSize' in parsed).toBe(false);
  });

  it('preserves recorded mtime/size when present', () => {
    const parsed = trackedFileSchema.parse({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      category: 'shell',
      strategy: 'copy' as const,
      added: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      checksum: 'abc123',
      sourceMtimeMs: 1700000000123.5,
      sourceSize: 42,
    });
    expect(parsed.sourceMtimeMs).toBe(1700000000123.5);
    expect(parsed.sourceSize).toBe(42);
  });
});

const TUCK = '/test-home/.tuck';

/** Build a manifest with a single tracked entry and persist it to memfs. */
const writeManifest = (id: string, file: Record<string, unknown>): void => {
  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: { [id]: file },
      bundles: {},
    })
  );
};

const baseEntry = {
  category: 'shell',
  strategy: 'copy' as const,
  added: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
};

describe('file-hash short-circuit', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vi.restoreAllMocks();
    vol.mkdirSync('/test-home', { recursive: true });
    vol.mkdirSync(`${TUCK}/files/shell`, { recursive: true });
  });

  it('does NOT re-hash an unchanged single file (uses recorded mtime/size)', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'export A=1\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');

    const checksum = await filesModule.getFileChecksum('/test-home/.zshrc');
    const live = statSync('/test-home/.zshrc');

    writeManifest('zshrc', {
      ...baseEntry,
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      checksum,
      sourceMtimeMs: live.mtimeMs,
      sourceSize: live.size,
    });

    // Spy AFTER seeding so the manifest checksum is real; the live hash must be skipped.
    const spy = vi.spyOn(filesModule, 'getFileChecksum');

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('ok');
    expect(model[0].liveChecksum).toBe(checksum);
    // Live source was NOT hashed; only the repo copy may have been.
    expect(spy).not.toHaveBeenCalledWith('/test-home/.zshrc');
  });

  it('detects an edited single file (content + mtime changed) as drift-local', async () => {
    // Seed with the ORIGINAL content/stat, then edit the live file so both its
    // content and mtime move past the recorded values.
    vol.writeFileSync('/test-home/.zshrc', 'original\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'original\n');
    const repoChecksum = await filesModule.getFileChecksum(`${TUCK}/files/shell/zshrc`);
    const orig = statSync('/test-home/.zshrc');

    writeManifest('zshrc', {
      ...baseEntry,
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      checksum: repoChecksum,
      sourceMtimeMs: orig.mtimeMs,
      sourceSize: orig.size,
    });

    // Edit: new content AND a strictly later mtime (size also differs here).
    vol.writeFileSync('/test-home/.zshrc', 'EDITED CONTENT IS LONGER\n');
    vol.utimesSync('/test-home/.zshrc', new Date(), new Date(orig.mtimeMs + 5000));

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('drift-local');
  });

  it('detects a size change at the SAME recorded mtime', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'abc\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'abc\n');
    const repoChecksum = await filesModule.getFileChecksum(`${TUCK}/files/shell/zshrc`);
    const orig = statSync('/test-home/.zshrc');

    writeManifest('zshrc', {
      ...baseEntry,
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      checksum: repoChecksum,
      sourceMtimeMs: orig.mtimeMs,
      sourceSize: orig.size,
    });

    // Different content -> different size, but force the SAME mtime as recorded.
    vol.writeFileSync('/test-home/.zshrc', 'a totally different and longer line\n');
    vol.utimesSync(
      '/test-home/.zshrc',
      new Date(orig.mtimeMs),
      new Date(orig.mtimeMs)
    );
    const after = statSync('/test-home/.zshrc');
    // Guard: mtime is unchanged, size IS changed — the case under test.
    expect(after.mtimeMs).toBe(orig.mtimeMs);
    expect(after.size).not.toBe(orig.size);

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('drift-local');
  });

  it('NEVER short-circuits a directory entry, even with recorded mtime/size', async () => {
    vol.mkdirSync('/test-home/.config/app', { recursive: true });
    vol.writeFileSync('/test-home/.config/app/a.conf', 'one\n');
    vol.mkdirSync(`${TUCK}/files/config/app`, { recursive: true });
    vol.writeFileSync(`${TUCK}/files/config/app/a.conf`, 'one\n');

    const dirChecksum = await filesModule.getFileChecksum('/test-home/.config/app');
    const dirStat = statSync('/test-home/.config/app');

    writeManifest('app', {
      ...baseEntry,
      category: 'config',
      source: '~/.config/app',
      destination: 'files/config/app',
      checksum: dirChecksum,
      // Even if a dir carries recorded mtime/size, it must be IGNORED: a nested
      // file change does not move the directory's own mtime/size.
      sourceMtimeMs: dirStat.mtimeMs,
      sourceSize: dirStat.size,
    });

    const spy = vi.spyOn(filesModule, 'getFileChecksum');

    const model = await computeStateModel(TUCK);
    // Directory still hashed (no short-circuit) -> recomputed, state ok here.
    expect(model[0].state).toBe('ok');
    // Separator-agnostic (Windows resolves to backslashes): assert the LIVE dir
    // source was hashed — its '/.config/app' suffix distinguishes it from the repo
    // copy under '/files/config/app'.
    const dirHashed = spy.mock.calls.some((c) =>
      String(c[0]).replace(/\\/g, '/').endsWith('/.config/app')
    );
    expect(dirHashed).toBe(true);
  });

  it('falls back to full hashing for a LEGACY entry (no mtime/size recorded)', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'export A=1\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');
    const checksum = await filesModule.getFileChecksum('/test-home/.zshrc');

    // No sourceMtimeMs / sourceSize — exactly today's manifest shape.
    writeManifest('zshrc', {
      ...baseEntry,
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      checksum,
    });

    const spy = vi.spyOn(filesModule, 'getFileChecksum');

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('ok');
    // Legacy entry: the live source IS hashed (no recorded stat to trust).
    // Separator-agnostic; '/.zshrc' suffix distinguishes the live source from the
    // repo copy under '/files/shell/zshrc'.
    const liveHashed = spy.mock.calls.some((c) =>
      String(c[0]).replace(/\\/g, '/').endsWith('/.zshrc')
    );
    expect(liveHashed).toBe(true);
  });
});
