import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { detectFileChanges } from '../../src/commands/status.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('status command manifest safety', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('rejects unsafe source paths from manifest entries', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-source'] = createMockTrackedFile({
      source: '~/../etc/passwd',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(detectFileChanges(TEST_TUCK_DIR)).rejects.toThrow('path traversal');
  });

  it('rejects unsafe destination paths from manifest entries', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-destination'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/../../outside',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(detectFileChanges(TEST_TUCK_DIR)).rejects.toThrow('Unsafe manifest destination');
  });

  it('does not crash or report a repo-scoped file as changed when its repo is unbound', async () => {
    const manifest = createMockManifest();
    // A repo-scoped entry's source is a `<repoKey>:<repoRelative>` KEY, not a
    // filesystem path. The old code fed it to validateSafeSourcePath/expandPath,
    // which crashed (cwd outside $HOME) or fabricated a cwd-relative path and
    // reported the file "deleted".
    manifest.files['eslint'] = createMockTrackedFile({
      source: 'someproj-a1b2c3d4:.eslintrc',
      destination: 'files/repos/someproj-a1b2c3d4/.eslintrc',
      scope: 'repo',
      repoKey: 'someproj-a1b2c3d4',
      repoRelative: '.eslintrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    // No repos.json binding → the entry is "unknown-repo" and simply skipped.
    const changes = await detectFileChanges(TEST_TUCK_DIR);
    expect(changes).toEqual([]);
  });

  it('does not report an in-sync template file as permanently modified', async () => {
    const { getFileChecksum } = await import('../../src/lib/files.js');

    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/misc'), { recursive: true });
    // Repo holds the un-rendered template; live holds the rendered output.
    vol.writeFileSync(join(TEST_TUCK_DIR, 'files/misc/tmpl'), 'H={{ home }}\n');
    vol.writeFileSync('/test-home/.tmpl', 'H=/test-home\n');
    const repoChecksum = await getFileChecksum(join(TEST_TUCK_DIR, 'files/misc/tmpl'));

    const manifest = createMockManifest();
    // The manifest checksum is the REPO copy's hash (template source), which can
    // never equal the live rendered file's hash — the old raw compare therefore
    // reported this file "modified" forever.
    manifest.files['tmpl'] = createMockTrackedFile({
      source: '~/.tmpl',
      destination: 'files/misc/tmpl',
      template: true,
      checksum: repoChecksum,
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    const changes = await detectFileChanges(TEST_TUCK_DIR);
    expect(changes).toEqual([]);
  });
});
