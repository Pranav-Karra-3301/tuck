/**
 * Tests for restoreLiveFilesAfterRedaction (issue #100).
 *
 * After "Replace with placeholders", the LIVE dotfile must get its original
 * values back once the redacted copy is safely in the repo — a live rc file
 * containing `{{PLACEHOLDER}}` is broken config (zsh aborts sourcing on it).
 * Symlinked live paths are skipped: writing through a symlink that points into
 * the tuck repo would put the secrets straight back into git.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, initTestTuck } from '../utils/testHelpers.js';
import { scanFile } from '../../src/lib/secrets/scanner.js';
import {
  redactFile,
  restoreLiveFilesAfterRedaction,
  liveMatchesRestoredRepo,
} from '../../src/lib/secrets/redactor.js';
import { processSecretsForRedaction } from '../../src/lib/secrets/index.js';
import { setSecret } from '../../src/lib/secrets/store.js';

const ORIGINAL = 'export MY_API_KEY=secret_0123456789abcdef0123456789abcdef\n';

const redactLiveFile = async (filepath: string): Promise<void> => {
  const result = await scanFile(filepath);
  expect(result.hasSecrets).toBe(true);
  const maps = await processSecretsForRedaction([result], TEST_TUCK_DIR);
  const placeholderMap = maps.get(result.path);
  expect(placeholderMap).toBeDefined();
  await redactFile(filepath, result.matches, placeholderMap!);
};

describe('restoreLiveFilesAfterRedaction', () => {
  beforeEach(async () => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    await initTestTuck();
  });

  it('restores the original content of a redacted live file', async () => {
    const file = join(TEST_HOME, '.testrc');
    vol.writeFileSync(file, ORIGINAL);

    await redactLiveFile(file);
    expect(vol.readFileSync(file, 'utf-8')).not.toBe(ORIGINAL);

    const result = await restoreLiveFilesAfterRedaction([file], TEST_TUCK_DIR);

    expect(result.restoredFiles).toBe(1);
    expect(vol.readFileSync(file, 'utf-8')).toBe(ORIGINAL);
  });

  it('skips symlinks so secrets cannot be written through into the repo copy', async () => {
    const repoCopy = join(TEST_TUCK_DIR, 'files', 'shell', '.testrc');
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files', 'shell'), { recursive: true });
    vol.writeFileSync(repoCopy, 'export MY_API_KEY={{API_KEY}}\n');

    const live = join(TEST_HOME, '.testrc');
    vol.symlinkSync(repoCopy, live);

    const result = await restoreLiveFilesAfterRedaction([live], TEST_TUCK_DIR);

    expect(result.restoredFiles).toBe(0);
    expect(result.skippedSymlinks).toEqual([live]);
    expect(vol.readFileSync(repoCopy, 'utf-8')).toBe('export MY_API_KEY={{API_KEY}}\n');
  });

  it('ignores paths that no longer exist', async () => {
    const result = await restoreLiveFilesAfterRedaction(
      [join(TEST_HOME, '.does-not-exist')],
      TEST_TUCK_DIR
    );
    expect(result.restoredFiles).toBe(0);
  });
});

describe('liveMatchesRestoredRepo', () => {
  const REPO_COPY = join(TEST_TUCK_DIR, 'files', 'shell', '.testrc');
  const LIVE = join(TEST_HOME, '.testrc');

  beforeEach(async () => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    await initTestTuck();
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files', 'shell'), { recursive: true });
  });

  it('returns true when the live file equals the repo copy with placeholders restored', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'secret_0123456789abcdef0123456789abcdef');
    vol.writeFileSync(REPO_COPY, 'export MY_API_KEY={{API_KEY}}\n');
    vol.writeFileSync(LIVE, ORIGINAL);

    expect(await liveMatchesRestoredRepo(LIVE, REPO_COPY, TEST_TUCK_DIR)).toBe(true);
  });

  it('returns false when the live file was genuinely edited', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'secret_0123456789abcdef0123456789abcdef');
    vol.writeFileSync(REPO_COPY, 'export MY_API_KEY={{API_KEY}}\n');
    vol.writeFileSync(LIVE, ORIGINAL + 'alias new="thing"\n');

    expect(await liveMatchesRestoredRepo(LIVE, REPO_COPY, TEST_TUCK_DIR)).toBe(false);
  });

  it('returns false when the repo copy has no placeholders', async () => {
    vol.writeFileSync(REPO_COPY, 'plain content\n');
    vol.writeFileSync(LIVE, 'different content\n');

    expect(await liveMatchesRestoredRepo(LIVE, REPO_COPY, TEST_TUCK_DIR)).toBe(false);
  });

  it('returns false when the placeholder has no stored value', async () => {
    vol.writeFileSync(REPO_COPY, 'export MY_API_KEY={{UNKNOWN_KEY}}\n');
    vol.writeFileSync(LIVE, ORIGINAL);

    expect(await liveMatchesRestoredRepo(LIVE, REPO_COPY, TEST_TUCK_DIR)).toBe(false);
  });
});
