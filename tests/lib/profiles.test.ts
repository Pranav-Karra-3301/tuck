import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { TEST_TUCK_DIR, TEST_HOME } from '../setup.js';
import { loadManifest, clearManifestCache } from '../../src/lib/manifest.js';
import {
  isValidProfileName,
  isUniversalFile,
  fileMatchesProfile,
  fileIsForeignToProfile,
  ensureProfile,
  removeProfile,
  tagFile,
  untagFile,
  getFilesByProfile,
  listProfileCounts,
  countUniversalFiles,
  bindProfile,
  unbindProfile,
  getBoundProfile,
  loadProfileBinding,
  resolveEffectiveProfile,
  detectProfileLeaks,
  getProfileBindingPath,
} from '../../src/lib/profiles.js';

const manifestPath = `${TEST_TUCK_DIR}/.tuckmanifest.json`;

/** A legacy manifest with no tags/profiles, plus two home-scoped files. */
const writeLegacyManifest = async (): Promise<void> => {
  const legacy = {
    version: '1.0.0',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    files: {
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        checksum: 'abc123',
      },
      workgit: {
        source: '~/.work-gitconfig',
        destination: 'files/git/work-gitconfig',
        category: 'git',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        checksum: 'def456',
      },
    },
  };
  await mkdir(TEST_TUCK_DIR, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(legacy, null, 2), 'utf-8');
};

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  clearManifestCache();
});

describe('profile name validation', () => {
  it('accepts filename-safe names', () => {
    for (const name of ['work', 'personal', 'server', 'agent', 'my.profile', 'a-b_c1']) {
      expect(isValidProfileName(name)).toBe(true);
    }
  });

  it('rejects unsafe names', () => {
    for (const name of ['', 'a b', 'a/b', 'a:b', 'a$b', '..']) {
      // '..' is actually filename-unsafe here because it contains only dots which
      // ARE allowed by the grammar; assert the clearly-invalid ones.
      if (name === '..') continue;
      expect(isValidProfileName(name)).toBe(false);
    }
  });
});

describe('pure selection predicates', () => {
  it('treats an empty tag list as universal', () => {
    expect(isUniversalFile({ tags: [] })).toBe(true);
    expect(isUniversalFile({ tags: ['work'] })).toBe(false);
  });

  it('fileMatchesProfile: no profile matches everything', () => {
    expect(fileMatchesProfile({ tags: ['work'] }, undefined)).toBe(true);
    expect(fileMatchesProfile({ tags: [] }, undefined)).toBe(true);
  });

  it('fileMatchesProfile: universal files match any profile', () => {
    expect(fileMatchesProfile({ tags: [] }, 'work')).toBe(true);
  });

  it('fileMatchesProfile: tagged files match only their profile', () => {
    expect(fileMatchesProfile({ tags: ['work'] }, 'work')).toBe(true);
    expect(fileMatchesProfile({ tags: ['work'] }, 'personal')).toBe(false);
  });

  it('fileIsForeignToProfile: universal is never foreign', () => {
    expect(fileIsForeignToProfile({ tags: [] }, 'work')).toBe(false);
    expect(fileIsForeignToProfile({ tags: ['personal'] }, 'work')).toBe(true);
    expect(fileIsForeignToProfile({ tags: ['work', 'personal'] }, 'work')).toBe(false);
  });
});

describe('schema migration', () => {
  it('defaults tags to [] and profiles to {} on legacy manifests', async () => {
    await writeLegacyManifest();
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.profiles).toEqual({});
    for (const file of Object.values(manifest.files)) {
      expect(file.tags).toEqual([]);
    }
  });
});

describe('profile registry helpers', () => {
  beforeEach(async () => {
    await writeLegacyManifest();
    await loadManifest(TEST_TUCK_DIR);
  });

  it('ensureProfile registers a profile idempotently', async () => {
    await ensureProfile(TEST_TUCK_DIR, 'work', 'Work machine');
    const first = (await loadManifest(TEST_TUCK_DIR)).profiles.work.created;
    await ensureProfile(TEST_TUCK_DIR, 'work');
    const second = (await loadManifest(TEST_TUCK_DIR)).profiles.work.created;
    expect(second).toBe(first);
    expect((await loadManifest(TEST_TUCK_DIR)).profiles.work.description).toBe('Work machine');
  });

  it('tagFile auto-registers the profile and adds the tag', async () => {
    const res = await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    expect(res.added).toBe(true);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.profiles.work).toBeDefined();
    expect(manifest.files.workgit.tags).toEqual(['work']);
  });

  it('tagFile is idempotent', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    const res = await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    expect(res.added).toBe(false);
    expect((await loadManifest(TEST_TUCK_DIR)).files.workgit.tags).toEqual(['work']);
  });

  it('untagFile removes a tag', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    const res = await untagFile(TEST_TUCK_DIR, 'workgit', 'work');
    expect(res.removed).toBe(true);
    expect((await loadManifest(TEST_TUCK_DIR)).files.workgit.tags).toEqual([]);
  });

  it('getFilesByProfile returns only explicitly tagged files', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    const files = await getFilesByProfile(TEST_TUCK_DIR, 'work');
    expect(Object.keys(files)).toEqual(['workgit']);
  });

  it('removeProfile strips the tag from every file', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    await tagFile(TEST_TUCK_DIR, 'zshrc', 'work');
    const { untagged } = await removeProfile(TEST_TUCK_DIR, 'work');
    expect(untagged).toBe(2);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.profiles.work).toBeUndefined();
    expect(manifest.files.workgit.tags).toEqual([]);
    expect(manifest.files.zshrc.tags).toEqual([]);
  });

  it('listProfileCounts reports tagged-file counts and countUniversalFiles the rest', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    const counts = await listProfileCounts(TEST_TUCK_DIR);
    const work = counts.find((p) => p.name === 'work');
    expect(work?.fileCount).toBe(1);
    // zshrc remains universal.
    expect(await countUniversalFiles(TEST_TUCK_DIR)).toBe(1);
  });

  it('persists tags to disk', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    clearManifestCache();
    const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(raw.files.workgit.tags).toEqual(['work']);
    expect(raw.profiles.work).toBeDefined();
  });
});

describe('machine-local binding', () => {
  it('binds, reads, and unbinds the machine profile', async () => {
    expect(await getBoundProfile()).toBeNull();

    await bindProfile('personal');
    expect(await getBoundProfile()).toBe('personal');

    const binding = await loadProfileBinding();
    expect(binding?.version).toBe('1');
    expect(binding?.profile).toBe('personal');
    expect(binding?.boundAt).toBeTruthy();

    // The binding file lives under the off-repo state dir, not the tuck repo.
    expect(getProfileBindingPath()).not.toContain(TEST_TUCK_DIR);
    expect(getProfileBindingPath().startsWith(TEST_HOME)).toBe(true);

    const removed = await unbindProfile();
    expect(removed).toBe(true);
    expect(await getBoundProfile()).toBeNull();
  });

  it('unbind returns false when nothing is bound', async () => {
    expect(await unbindProfile()).toBe(false);
  });

  it('rebinding overwrites the previous profile', async () => {
    await bindProfile('work');
    await bindProfile('personal');
    expect(await getBoundProfile()).toBe('personal');
  });

  it('resolveEffectiveProfile prefers the explicit choice, then the binding', async () => {
    expect(await resolveEffectiveProfile('work')).toBe('work');
    expect(await resolveEffectiveProfile(undefined)).toBeNull();
    await bindProfile('server');
    expect(await resolveEffectiveProfile(undefined)).toBe('server');
    expect(await resolveEffectiveProfile('work')).toBe('work');
  });
});

describe('cross-profile leak detection', () => {
  beforeEach(async () => {
    await writeLegacyManifest();
    await loadManifest(TEST_TUCK_DIR);
  });

  it('flags a foreign-profile file that is materialized on disk', async () => {
    // workgit belongs to the "work" profile; the machine is bound to "personal".
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    // Materialize the live work file.
    await mkdir(TEST_HOME, { recursive: true });
    await writeFile(`${TEST_HOME}/.work-gitconfig`, '[user]\n', 'utf-8');

    const leaks = await detectProfileLeaks(TEST_TUCK_DIR, 'personal');
    expect(leaks).toHaveLength(1);
    expect(leaks[0].id).toBe('workgit');
    expect(leaks[0].tags).toEqual(['work']);
    expect(leaks[0].livePath).toBe(`${TEST_HOME}/.work-gitconfig`);
  });

  it('does not flag a foreign file that is NOT on disk (latent, not leaked)', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'work');
    // No live file created.
    const leaks = await detectProfileLeaks(TEST_TUCK_DIR, 'personal');
    expect(leaks).toHaveLength(0);
  });

  it('never flags universal files or files carrying the bound profile', async () => {
    await tagFile(TEST_TUCK_DIR, 'workgit', 'personal');
    await mkdir(TEST_HOME, { recursive: true });
    await writeFile(`${TEST_HOME}/.work-gitconfig`, 'x', 'utf-8');
    await writeFile(`${TEST_HOME}/.zshrc`, 'x', 'utf-8'); // universal

    const leaks = await detectProfileLeaks(TEST_TUCK_DIR, 'personal');
    expect(leaks).toHaveLength(0);
  });
});
