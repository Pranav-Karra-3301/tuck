/**
 * Manifest operation benchmarks for tuck.
 *
 * The manifest is loaded/saved frequently during operations.
 * Performance concerns:
 * - Large manifests with many tracked files
 * - JSON parsing/stringifying overhead
 * - Zod validation overhead
 * - Cache effectiveness
 *
 * Target performance:
 * - Load manifest (100 files): < 10ms
 * - Load manifest (1000 files): < 50ms
 * - Save manifest: < 20ms
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench, beforeEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { createTempDir, generateLargeManifest } from './setup.js';

// Import manifest functions
import {
  loadManifest,
  saveManifest,
  clearManifestCache,
  getTrackedFileBySource,
  getAllTrackedFiles,
  isFileTracked,
  getCategories,
} from '../../src/lib/manifest.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('manifest-bench-');

// Create tuck directories with different manifest sizes
const tuckDir10 = join(tempDir, 'tuck10');
const tuckDir100 = join(tempDir, 'tuck100');
const tuckDir1000 = join(tempDir, 'tuck1000');

// Create directories
mkdirSync(tuckDir10, { recursive: true });
mkdirSync(tuckDir100, { recursive: true });
mkdirSync(tuckDir1000, { recursive: true });

// Create manifests of different sizes
writeFileSync(
  join(tuckDir10, '.tuckmanifest.json'),
  JSON.stringify(generateLargeManifest(10), null, 2)
);
writeFileSync(
  join(tuckDir100, '.tuckmanifest.json'),
  JSON.stringify(generateLargeManifest(100), null, 2)
);
writeFileSync(
  join(tuckDir1000, '.tuckmanifest.json'),
  JSON.stringify(generateLargeManifest(1000), null, 2)
);

// ============================================================================
// Benchmarks
// ============================================================================

describe('Manifest Benchmarks', () => {
  beforeEach(() => {
    // Clear cache before each benchmark to test cold loads
    clearManifestCache();
  });

  // ============================================================================
  // Load Benchmarks
  // ============================================================================

  describe('loadManifest', () => {
    bench('load manifest with 10 files (cold)', async () => {
      clearManifestCache();
      await loadManifest(tuckDir10);
    });

    bench('load manifest with 100 files (cold)', async () => {
      clearManifestCache();
      await loadManifest(tuckDir100);
    });

    bench('load manifest with 1000 files (cold)', async () => {
      clearManifestCache();
      await loadManifest(tuckDir1000);
    });

    bench('load manifest with 10 files (cached)', async () => {
      // First load to cache
      await loadManifest(tuckDir10);
      // Cached load
      await loadManifest(tuckDir10);
    });

    bench('load manifest with 1000 files (cached)', async () => {
      await loadManifest(tuckDir1000);
      await loadManifest(tuckDir1000);
    });
  });

  // ============================================================================
  // Save Benchmarks
  // ============================================================================

  describe('saveManifest', () => {
    bench('save manifest with 10 files', async () => {
      const manifest = await loadManifest(tuckDir10);
      manifest.updated = new Date().toISOString();
      await saveManifest(manifest, tuckDir10);
    });

    bench('save manifest with 100 files', async () => {
      const manifest = await loadManifest(tuckDir100);
      manifest.updated = new Date().toISOString();
      await saveManifest(manifest, tuckDir100);
    });

    bench('save manifest with 1000 files', async () => {
      const manifest = await loadManifest(tuckDir1000);
      manifest.updated = new Date().toISOString();
      await saveManifest(manifest, tuckDir1000);
    });
  });

  // ============================================================================
  // Query Benchmarks
  // ============================================================================

  describe('Manifest Queries', () => {
    bench('getTrackedFileBySource (1000 files)', async () => {
      clearManifestCache();
      await getTrackedFileBySource(tuckDir1000, '~/.config/app500/config');
    });

    bench('getAllTrackedFiles (1000 files)', async () => {
      clearManifestCache();
      await getAllTrackedFiles(tuckDir1000);
    });

    bench('isFileTracked - exists (1000 files)', async () => {
      clearManifestCache();
      await isFileTracked(tuckDir1000, '~/.config/app500/config');
    });

    bench('isFileTracked - not exists (1000 files)', async () => {
      clearManifestCache();
      await isFileTracked(tuckDir1000, '~/.config/nonexistent/config');
    });

    bench('getCategories (1000 files)', async () => {
      clearManifestCache();
      await getCategories(tuckDir1000);
    });
  });

  // ============================================================================
  // Cache Performance
  // ============================================================================

  describe('Cache Effectiveness', () => {
    bench('10 consecutive loads (should hit cache)', async () => {
      clearManifestCache();
      for (let i = 0; i < 10; i++) {
        await loadManifest(tuckDir1000);
      }
    });

    bench('10 alternating loads (cache switches)', async () => {
      clearManifestCache();
      for (let i = 0; i < 10; i++) {
        await loadManifest(i % 2 === 0 ? tuckDir100 : tuckDir1000);
      }
    });
  });

  // ============================================================================
  // Combined Operations
  // ============================================================================

  describe('Combined Operations', () => {
    bench('load + query + save cycle', async () => {
      clearManifestCache();
      const manifest = await loadManifest(tuckDir100);
      await getTrackedFileBySource(tuckDir100, '~/.config/app50/config');
      manifest.updated = new Date().toISOString();
      await saveManifest(manifest, tuckDir100);
    });

    bench('multiple queries on same manifest', async () => {
      clearManifestCache();
      await loadManifest(tuckDir100);

      for (let i = 0; i < 50; i++) {
        await getTrackedFileBySource(tuckDir100, `~/.config/app${i}/config`);
      }
    });
  });
});
