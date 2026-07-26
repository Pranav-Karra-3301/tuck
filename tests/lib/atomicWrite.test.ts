/**
 * Atomic write helper unit tests.
 *
 * The manifest, config, and secrets store are the source-of-truth files; a
 * crash or partial write mid-`writeFile` must never corrupt or truncate them.
 * `atomicWriteFile` writes to a temp sibling then renames into place so the
 * target is only ever the old content or the new content, never a fragment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol, fs as memfs } from 'memfs';
import { readFileSync, readdirSync } from 'fs';
import { atomicWriteFile } from '../../src/lib/files.js';

const DIR = '/test-home/atomic';

describe('atomicWriteFile', () => {
  beforeEach(() => {
    vol.mkdirSync(DIR, { recursive: true });
  });

  it('writes content that reads back identically for a new file', async () => {
    const target = `${DIR}/new.json`;
    await atomicWriteFile(target, '{"a":1}\n');
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}\n');
  });

  it('atomically replaces existing file content', async () => {
    const target = `${DIR}/existing.json`;
    vol.writeFileSync(target, 'OLD');
    await atomicWriteFile(target, 'NEW');
    expect(readFileSync(target, 'utf-8')).toBe('NEW');
  });

  it('leaves no temp sibling files behind after a successful write', async () => {
    const target = `${DIR}/clean.json`;
    await atomicWriteFile(target, 'data');
    const leftovers = readdirSync(DIR).filter((n) => String(n).includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('honors an explicit restrictive mode (0o600) for sensitive files', async () => {
    const target = `${DIR}/secrets.local.json`;
    await atomicWriteFile(target, '{}', { mode: 0o600 });
    const mode = vol.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('fsyncs the temp file data BEFORE renaming it into place (durability)', async () => {
    // Regression guard: a bare writeFile()+rename() can let the rename's metadata
    // reach disk while the file's data blocks have not, leaving a zero-length or
    // stale target after a crash/power loss. atomicWriteFile must fsync the temp
    // fd before the rename so the published file is always the full content.
    const target = `${DIR}/durable-sync.json`;
    const events: string[] = [];

    const realOpen = memfs.promises.open.bind(memfs.promises);
    const realRename = memfs.promises.rename.bind(memfs.promises);

    (memfs.promises as { open: unknown }).open = async (
      ...args: Parameters<typeof realOpen>
    ) => {
      const handle = (await realOpen(...args)) as { sync: () => Promise<void> };
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push('sync');
        return realSync();
      };
      return handle;
    };
    (memfs.promises as { rename: unknown }).rename = async (
      ...args: Parameters<typeof realRename>
    ) => {
      events.push('rename');
      return realRename(...args);
    };

    try {
      await atomicWriteFile(target, 'DURABLE');
    } finally {
      (memfs.promises as { open: unknown }).open = realOpen;
      (memfs.promises as { rename: unknown }).rename = realRename;
    }

    expect(readFileSync(target, 'utf-8')).toBe('DURABLE');
    // The temp file's data must be fsync'd, and that fsync must happen before the
    // atomic rename publishes it.
    expect(events).toContain('sync');
    expect(events).toContain('rename');
    expect(events.indexOf('sync')).toBeLessThan(events.indexOf('rename'));
  });

  it('preserves the original file and cleans up the temp file when the rename fails', async () => {
    const target = `${DIR}/durable.json`;
    vol.writeFileSync(target, 'ORIGINAL');

    // Force the rename step to fail, simulating a crash between write and swap.
    const realRename = memfs.promises.rename;
    (memfs.promises as { rename: unknown }).rename = async () => {
      throw new Error('simulated rename failure');
    };

    try {
      await expect(atomicWriteFile(target, 'CORRUPT')).rejects.toThrow();
    } finally {
      (memfs.promises as { rename: unknown }).rename = realRename;
    }

    // Original content is intact (never truncated/partially written).
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL');
    // No orphan temp files remain.
    const leftovers = readdirSync(DIR).filter((n) => String(n).includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});
