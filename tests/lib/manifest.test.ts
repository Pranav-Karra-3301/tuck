/**
 * Manifest module unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  loadManifest,
  saveManifest,
  createManifest,
  addFileToManifest,
  updateFileInManifest,
  removeFileFromManifest,
  getTrackedFile,
  getTrackedFileBySource,
  getAllTrackedFiles,
  getTrackedFilesByCategory,
  isFileTracked,
  getFileCount,
  getCategories,
  clearManifestCache,
} from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('manifest', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    clearManifestCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  // ============================================================================
  // loadManifest Tests
  // ============================================================================

  describe('loadManifest', () => {
    it('should load a valid manifest file', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      const loaded = await loadManifest(TEST_TUCK_DIR);

      expect(loaded.version).toBe(mockManifest.version);
      expect(loaded.machine).toBe(mockManifest.machine);
    });

    it('should throw for missing manifest', async () => {
      await expect(loadManifest(TEST_TUCK_DIR)).rejects.toThrow('Manifest file not found');
    });

    it('should throw for invalid JSON', async () => {
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), 'not valid json');

      await expect(loadManifest(TEST_TUCK_DIR)).rejects.toThrow('invalid JSON');
    });

    it('should throw for invalid manifest schema', async () => {
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify({ invalid: 'schema' })
      );

      await expect(loadManifest(TEST_TUCK_DIR)).rejects.toThrow('Invalid manifest');
    });

    it('should cache loaded manifest', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      const first = await loadManifest(TEST_TUCK_DIR);
      const second = await loadManifest(TEST_TUCK_DIR);

      expect(first).toBe(second); // Same object reference
    });

    it('should reload after cache clear', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      const first = await loadManifest(TEST_TUCK_DIR);
      clearManifestCache();
      const second = await loadManifest(TEST_TUCK_DIR);

      expect(first).not.toBe(second); // Different object references
    });
  });

  // ============================================================================
  // saveManifest Tests
  // ============================================================================

  describe('saveManifest', () => {
    it('should save manifest to file', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      mockManifest.files['test-file'] = createMockTrackedFile();
      await saveManifest(mockManifest, TEST_TUCK_DIR);

      const content = vol.readFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), 'utf-8');
      const saved = JSON.parse(content as string);

      expect(saved.files['test-file']).toBeDefined();
    });

    it('should update the timestamp', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      const originalUpdated = mockManifest.updated;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      await saveManifest(mockManifest, TEST_TUCK_DIR);

      expect(mockManifest.updated).not.toBe(originalUpdated);
    });

    it('should validate manifest before saving', async () => {
      const invalidManifest = { invalid: true } as any;

      await expect(saveManifest(invalidManifest, TEST_TUCK_DIR)).rejects.toThrow();
    });

    it('should update cache after save', async () => {
      const mockManifest = createMockManifest();
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(mockManifest, null, 2)
      );

      mockManifest.files['new-file'] = createMockTrackedFile();
      await saveManifest(mockManifest, TEST_TUCK_DIR);

      const loaded = await loadManifest(TEST_TUCK_DIR);
      expect(loaded.files['new-file']).toBeDefined();
    });
  });

  // ============================================================================
  // createManifest Tests
  // ============================================================================

  describe('createManifest', () => {
    it('should create new manifest file', async () => {
      const manifest = await createManifest(TEST_TUCK_DIR, 'test-machine');

      expect(manifest.version).toBe('1.0.0');
      expect(manifest.machine).toBe('test-machine');
      expect(manifest.files).toEqual({});
    });

    it('should throw if manifest already exists', async () => {
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(createMockManifest())
      );

      await expect(createManifest(TEST_TUCK_DIR)).rejects.toThrow('already exists');
    });
  });

  // ============================================================================
  // File CRUD Operations
  // ============================================================================

  describe('addFileToManifest', () => {
    beforeEach(async () => {
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(createMockManifest())
      );
    });

    it('should add a new file to manifest', async () => {
      const file = createMockTrackedFile({ source: '~/.bashrc' });
      await addFileToManifest(TEST_TUCK_DIR, 'bashrc', file);

      const manifest = await loadManifest(TEST_TUCK_DIR);
      expect(manifest.files['bashrc']).toBeDefined();
      expect(manifest.files['bashrc'].source).toBe('~/.bashrc');
    });

    it('should throw if file already tracked', async () => {
      const file = createMockTrackedFile();
      await addFileToManifest(TEST_TUCK_DIR, 'test-id', file);

      await expect(addFileToManifest(TEST_TUCK_DIR, 'test-id', file)).rejects.toThrow(
        'already tracked'
      );
    });
  });

  describe('updateFileInManifest', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['test-id'] = createMockTrackedFile();
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should update file properties', async () => {
      await updateFileInManifest(TEST_TUCK_DIR, 'test-id', {
        checksum: 'new-checksum',
      });

      const manifest = await loadManifest(TEST_TUCK_DIR);
      expect(manifest.files['test-id'].checksum).toBe('new-checksum');
    });

    it('should update modified timestamp', async () => {
      const oldModified = (await loadManifest(TEST_TUCK_DIR)).files['test-id'].modified;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await updateFileInManifest(TEST_TUCK_DIR, 'test-id', { checksum: 'x' });

      const manifest = await loadManifest(TEST_TUCK_DIR);
      expect(manifest.files['test-id'].modified).not.toBe(oldModified);
    });

    it('should throw if file not found', async () => {
      await expect(updateFileInManifest(TEST_TUCK_DIR, 'nonexistent', {})).rejects.toThrow(
        'not found'
      );
    });
  });

  describe('removeFileFromManifest', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['test-id'] = createMockTrackedFile();
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should remove file from manifest', async () => {
      await removeFileFromManifest(TEST_TUCK_DIR, 'test-id');

      const manifest = await loadManifest(TEST_TUCK_DIR);
      expect(manifest.files['test-id']).toBeUndefined();
    });

    it('should throw if file not found', async () => {
      await expect(removeFileFromManifest(TEST_TUCK_DIR, 'nonexistent')).rejects.toThrow(
        'not found'
      );
    });
  });

  // ============================================================================
  // Query Operations
  // ============================================================================

  describe('getTrackedFile', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({ source: '~/.zshrc' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should return tracked file by ID', async () => {
      const file = await getTrackedFile(TEST_TUCK_DIR, 'zshrc');
      expect(file).not.toBeNull();
      expect(file?.source).toBe('~/.zshrc');
    });

    it('should return null for unknown ID', async () => {
      const file = await getTrackedFile(TEST_TUCK_DIR, 'unknown');
      expect(file).toBeNull();
    });
  });

  describe('getTrackedFileBySource', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({ source: '~/.zshrc' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should return file by source path', async () => {
      const result = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('zshrc');
    });

    it('should return null for unknown source', async () => {
      const result = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.unknown');
      expect(result).toBeNull();
    });
  });

  describe('getAllTrackedFiles', () => {
    it('should return all tracked files', async () => {
      const manifest = createMockManifest();
      manifest.files['file1'] = createMockTrackedFile({ source: '~/.file1' });
      manifest.files['file2'] = createMockTrackedFile({ source: '~/.file2' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      const files = await getAllTrackedFiles(TEST_TUCK_DIR);
      expect(Object.keys(files)).toHaveLength(2);
    });

    it('should return empty object for no files', async () => {
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(createMockManifest())
      );

      const files = await getAllTrackedFiles(TEST_TUCK_DIR);
      expect(Object.keys(files)).toHaveLength(0);
    });
  });

  describe('getTrackedFilesByCategory', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({ source: '~/.zshrc', category: 'shell' });
      manifest.files['gitconfig'] = createMockTrackedFile({
        source: '~/.gitconfig',
        category: 'git',
      });
      manifest.files['bashrc'] = createMockTrackedFile({ source: '~/.bashrc', category: 'shell' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should filter files by category', async () => {
      const shellFiles = await getTrackedFilesByCategory(TEST_TUCK_DIR, 'shell');
      expect(Object.keys(shellFiles)).toHaveLength(2);
    });

    it('should return empty for unknown category', async () => {
      const files = await getTrackedFilesByCategory(TEST_TUCK_DIR, 'unknown');
      expect(Object.keys(files)).toHaveLength(0);
    });
  });

  describe('isFileTracked', () => {
    beforeEach(async () => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({ source: '~/.zshrc' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    });

    it('should return true for tracked file', async () => {
      expect(await isFileTracked(TEST_TUCK_DIR, '~/.zshrc')).toBe(true);
    });

    it('should return false for untracked file', async () => {
      expect(await isFileTracked(TEST_TUCK_DIR, '~/.untracked')).toBe(false);
    });
  });

  describe('getFileCount', () => {
    it('should return correct file count', async () => {
      const manifest = createMockManifest();
      manifest.files['file1'] = createMockTrackedFile();
      manifest.files['file2'] = createMockTrackedFile();
      manifest.files['file3'] = createMockTrackedFile();
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      expect(await getFileCount(TEST_TUCK_DIR)).toBe(3);
    });

    it('should return 0 for empty manifest', async () => {
      vol.writeFileSync(
        join(TEST_TUCK_DIR, '.tuckmanifest.json'),
        JSON.stringify(createMockManifest())
      );

      expect(await getFileCount(TEST_TUCK_DIR)).toBe(0);
    });
  });

  describe('getCategories', () => {
    it('should return unique categories', async () => {
      const manifest = createMockManifest();
      manifest.files['file1'] = createMockTrackedFile({ category: 'shell' });
      manifest.files['file2'] = createMockTrackedFile({ category: 'git' });
      manifest.files['file3'] = createMockTrackedFile({ category: 'shell' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      const categories = await getCategories(TEST_TUCK_DIR);
      expect(categories).toHaveLength(2);
      expect(categories).toContain('shell');
      expect(categories).toContain('git');
    });

    it('should return sorted categories', async () => {
      const manifest = createMockManifest();
      manifest.files['file1'] = createMockTrackedFile({ category: 'shell' });
      manifest.files['file2'] = createMockTrackedFile({ category: 'git' });
      manifest.files['file3'] = createMockTrackedFile({ category: 'editors' });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      const categories = await getCategories(TEST_TUCK_DIR);
      expect(categories).toEqual(['editors', 'git', 'shell']);
    });
  });
});
