import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { expandPath, pathExists } from './paths.js';

/**
 * Canonical pattern shape consumed by `detect.ts`.
 *
 * This matches the original in-code `DOTFILE_PATTERNS` entry type so existing
 * detection logic remains byte-identical. JSON files on disk use a slightly
 * different schema (`pattern` instead of `path`, plus required `isDirectory`
 * and `exclude` fields). `loadPatterns()` converts JSON entries to this shape.
 */
export interface DotfilePattern {
  path: string;
  category: string;
  description: string;
  sensitive?: boolean;
  exclude?: string[];
  platform?: 'darwin' | 'linux' | 'win32' | 'all';
}

/**
 * JSON-on-disk pattern shape. See `templates/patterns/*.json`.
 *
 * Schema: https://tuck.sh/schemas/patterns-v1.json
 */
interface PatternFileEntry {
  pattern: string;
  category: string;
  description: string;
  sensitive?: boolean;
  isDirectory?: boolean;
  exclude?: string[];
  platform?: 'darwin' | 'linux' | 'win32' | 'all';
}

interface PatternFile {
  $schema?: string;
  category: string;
  patterns: PatternFileEntry[];
}

let cache: DotfilePattern[] | null = null;

/**
 * Reset the in-process cache. Intended for tests only.
 */
export const resetPatternsCache = (): void => {
  cache = null;
};

export const bundledPatternsDir = (): string => {
  // Resolve to <pkg>/templates/patterns. The layout differs between dev
  // (src/lib → ../../templates) and the published, tsup-bundled build
  // (dist → ../templates), so probe each candidate and return the first that
  // exists. Blindly returning candidates[0] silently dropped ALL bundled
  // detection patterns in every npm install (it resolved outside the package).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../templates/patterns'),
    resolve(here, '../templates/patterns'),
    resolve(here, '../../../templates/patterns'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
};

const userPatternsDir = (): string => {
  // Override hook for tests: TUCK_PATTERNS_DIR forces a specific user-patterns
  // directory. Otherwise the canonical location is ~/.tuck/patterns.
  const override = process.env.TUCK_PATTERNS_DIR;
  if (override) return expandPath(override);
  return expandPath('~/.tuck/patterns');
};

const toDotfilePattern = (entry: PatternFileEntry): DotfilePattern => {
  const out: DotfilePattern = {
    path: entry.pattern,
    category: entry.category,
    description: entry.description,
  };
  if (entry.sensitive) out.sensitive = true;
  if (entry.exclude && entry.exclude.length > 0) out.exclude = entry.exclude;
  if (entry.platform) out.platform = entry.platform;
  return out;
};

const readJsonFile = async (file: string): Promise<PatternFile | null> => {
  try {
    const text = await readFile(file, 'utf-8');
    const parsed = JSON.parse(text) as PatternFile;
    if (!parsed || !Array.isArray(parsed.patterns)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const listJsonFiles = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir);
    // Sort for deterministic load order across platforms / filesystems.
    return entries
      .filter((e) => e.endsWith('.json'))
      .sort()
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
};

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Load dotfile patterns from disk.
 *
 * Resolution order:
 *   1. Bundled JSON files in `<pkg>/templates/patterns/*.json`
 *   2. User overrides in `~/.tuck/patterns/*.json` (or `TUCK_PATTERNS_DIR`)
 *
 * Override semantics: a user-provided entry whose `pattern` matches an existing
 * bundled entry replaces that entry in-place. Entries with a new `pattern` are
 * appended.
 *
 * Result is cached for the lifetime of the process. Use `resetPatternsCache()`
 * to invalidate (tests only).
 */
export const loadPatterns = async (): Promise<DotfilePattern[]> => {
  if (cache) return cache;

  const bundledDir = bundledPatternsDir();
  const bundledFiles = await listJsonFiles(bundledDir);
  const merged: DotfilePattern[] = [];
  // Index by pattern path for O(1) override lookups.
  const indexByPath = new Map<string, number>();

  for (const file of bundledFiles) {
    const doc = await readJsonFile(file);
    if (!doc) continue;
    for (const entry of doc.patterns) {
      const dp = toDotfilePattern(entry);
      const existing = indexByPath.get(dp.path);
      if (existing !== undefined) {
        merged[existing] = dp;
      } else {
        indexByPath.set(dp.path, merged.length);
        merged.push(dp);
      }
    }
  }

  const userDir = userPatternsDir();
  if (await dirExists(userDir)) {
    const userFiles = await listJsonFiles(userDir);
    for (const file of userFiles) {
      const doc = await readJsonFile(file);
      if (!doc) continue;
      for (const entry of doc.patterns) {
        const dp = toDotfilePattern(entry);
        const existing = indexByPath.get(dp.path);
        if (existing !== undefined) {
          merged[existing] = dp;
        } else {
          indexByPath.set(dp.path, merged.length);
          merged.push(dp);
        }
      }
    }
  }

  cache = merged;
  return cache;
};

// Re-export `pathExists` is intentionally not done here; consumers should
// import it directly from `./paths.js` to keep this module focused.
export { pathExists };
