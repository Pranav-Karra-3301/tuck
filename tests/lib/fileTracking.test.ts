import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { trackFilesWithProgress } from '../../src/lib/fileTracking.js';
import { clearManifestCache, getTrackedFileBySource, loadManifest } from '../../src/lib/manifest.js';
import { initTestTuck, createTestDotfile, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { isEncryptedFile, decryptFileContent } from '../../src/lib/crypto/fileEncryption.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';
import { clearSessionKeyCache } from '../../src/lib/crypto/sessionKeyCache.js';

const retrieveMock = vi.fn();
vi.mock('../../src/lib/crypto/keystore/index.js', () => ({
  getKeystore: vi.fn(async () => ({ retrieve: retrieveMock })),
  TUCK_SERVICE: 'tuck-dotfiles',
  TUCK_ACCOUNT: 'backup-encryption',
}));

describe('fileTracking symlink strategy', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    // The keystore passphrase is cached per session (one prompt per session). In
    // one process each test must start with a cold cache, or a passphrase unlocked
    // by an earlier test would satisfy a later "no password configured" case.
    clearSessionKeyCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    clearSessionKeyCache();
    vi.restoreAllMocks();
  });

  it('stores a real file in repo and replaces source with symlink to repo file', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export TRACKING_TEST=1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [{ path: '~/.zshrc', category: 'shell' }],
      TEST_TUCK_DIR,
      {
        strategy: 'symlink',
        showCategory: false,
        delayBetween: 0,
      }
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).not.toBeNull();

    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    expect(vol.lstatSync(repoPath).isSymbolicLink()).toBe(false);
    expect(vol.readFileSync(repoPath, 'utf-8')).toBe('export TRACKING_TEST=1');

    expect(vol.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync(sourcePath)).toBe(repoPath);

    vol.writeFileSync(sourcePath, 'export TRACKING_TEST=2');
    expect(vol.readFileSync(repoPath, 'utf-8')).toBe('export TRACKING_TEST=2');

    logSpy.mockRestore();
  });

  it('writes nothing to stdout in --json mode (single-envelope contract)', async () => {
    setJsonMode(true, 'tuck add');
    await initTestTuck();
    createTestDotfile('.zshrc', 'export X=1');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const result = await trackFilesWithProgress(
      [{ path: '~/.zshrc', category: 'shell' }],
      TEST_TUCK_DIR,
      { showCategory: true, delayBetween: 0 }
    );

    writeSpy.mockRestore();
    setJsonMode(false);

    // Tracking still succeeds, but the banner/per-file/summary lines (which used
    // to precede the JSON envelope and break JSON.parse(stdout)) are suppressed.
    expect(result.succeeded).toBe(1);
    expect(writes.join('')).toBe('');
  });

  it('encrypts the file at rest when encrypt is set (encrypted:true, TCKE1 ciphertext)', async () => {
    retrieveMock.mockResolvedValue('pw');
    await initTestTuck();
    createTestDotfile('.netrc', 'machine example login bob');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress([{ path: '~/.netrc', category: 'misc' }], TEST_TUCK_DIR, {
      strategy: 'copy',
      encrypt: true,
      showCategory: false,
      delayBetween: 0,
    });
    expect(result.succeeded).toBe(1);

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.netrc');
    expect(tracked!.file.encrypted).toBe(true);

    // The repo copy is TCKE1 ciphertext that round-trips back to the plaintext.
    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    const stored = Buffer.from(vol.readFileSync(repoPath));
    expect(isEncryptedFile(stored)).toBe(true);
    expect((await decryptFileContent(stored, 'pw')).toString('utf8')).toBe('machine example login bob');

    logSpy.mockRestore();
  });

  it('marks a file as a template (template:true) and stores the source verbatim', async () => {
    await initTestTuck();
    createTestDotfile('.gitconfig', '[user]\n  name = {{user}}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await trackFilesWithProgress([{ path: '~/.gitconfig', category: 'git' }], TEST_TUCK_DIR, {
      strategy: 'copy',
      template: true,
      showCategory: false,
      delayBetween: 0,
    });

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.gitconfig');
    expect(tracked!.file.template).toBe(true);
    // Stored verbatim — NOT rendered at storage time (the repo holds the source).
    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    expect(vol.readFileSync(repoPath, 'utf-8')).toContain('{{user}}');

    logSpy.mockRestore();
  });

  it('fails clearly when encrypt is set but no encryption password is configured', async () => {
    retrieveMock.mockResolvedValue(null);
    await initTestTuck();
    createTestDotfile('.secret', 'top secret');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress([{ path: '~/.secret', category: 'misc' }], TEST_TUCK_DIR, {
      strategy: 'copy',
      encrypt: true,
      showCategory: false,
      delayBetween: 0,
    });

    // Per-file failure is captured (never throws away the whole batch, never writes plaintext).
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error.message).toMatch(/encryption password/i);

    logSpy.mockRestore();
  });

  it('avoids destination collisions for same basenames in different directories', async () => {
    await initTestTuck();
    createTestDotfile('.aws/config', 'region = us-east-1');
    createTestDotfile('.kube/config', 'apiVersion: v1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [
        { path: '~/.aws/config', category: 'misc' },
        { path: '~/.kube/config', category: 'misc' },
      ],
      TEST_TUCK_DIR,
      {
        strategy: 'copy',
        showCategory: false,
        delayBetween: 0,
      }
    );

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const aws = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.aws/config');
    const kube = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.kube/config');
    expect(aws).not.toBeNull();
    expect(kube).not.toBeNull();
    expect(aws!.file.destination).toBe('files/misc/.aws/config');
    expect(kube!.file.destination).toBe('files/misc/.kube/config');

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const destinations = Object.values(manifest.files).map((file) => file.destination);
    expect(new Set(destinations).size).toBe(destinations.length);

    logSpy.mockRestore();
  });

  it('supports custom destination names while preserving source subdirectories', async () => {
    await initTestTuck();
    createTestDotfile('.aws/config', 'region = us-east-1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [{ path: '~/.aws/config', category: 'misc', name: 'work-config' }],
      TEST_TUCK_DIR,
      {
        strategy: 'copy',
        showCategory: false,
        delayBetween: 0,
      }
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const aws = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.aws/config');
    expect(aws).not.toBeNull();
    expect(aws!.file.destination).toBe('files/misc/.aws/work-config');

    logSpy.mockRestore();
  });
});
