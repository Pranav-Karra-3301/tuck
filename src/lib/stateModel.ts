/**
 * tuck state model — the single source of truth for "what changed".
 *
 * For every tracked file there are three independent representations:
 *   - LIVE:     the file on the system at `expandPath(source)`
 *   - REPO:     the copy committed in the tuck repo at `tuckDir/destination`
 *   - MANIFEST: the checksum recorded in `.tuckmanifest.json`
 *
 * Comparing all three lets us distinguish *local* drift (user edited the live
 * file — `tuck sync` territory) from *repo* drift (the repo copy changed
 * out-of-band, e.g. a `git pull` — `tuck restore` territory), and detect
 * missing files on either side. status/sync/restore/diff and the upcoming
 * `tuck verify` all build on this so they agree on what "changed" means.
 */

import { join } from 'path';
import { pathExists } from './paths.js';
import { getFileChecksum } from './files.js';
import { getAllTrackedFiles } from './manifest.js';
import { resolveLiveTarget } from './repoScope.js';
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';

export type FileState =
  | 'ok'
  | 'drift-local'
  | 'drift-repo'
  | 'missing-live'
  | 'missing-repo'
  | 'missing-both'
  // Repo-scoped file whose repo is not bound on this machine (run `tuck repo link`).
  | 'unknown-repo';

export interface FileStateEntry {
  id: string;
  source: string;
  destination: string;
  state: FileState;
  liveChecksum: string | null;
  repoChecksum: string | null;
  manifestChecksum: string;
}

/**
 * Pure classifier — given the three checksums (null = absent), decide the state.
 * Order matters: a missing side is reported before drift, and local drift
 * (live≠repo, what `sync` acts on) is reported before repo drift (repo≠manifest,
 * what `restore` acts on).
 */
export const classifyFileState = (
  liveChecksum: string | null,
  repoChecksum: string | null,
  manifestChecksum: string
): FileState => {
  if (liveChecksum === null && repoChecksum === null) return 'missing-both';
  if (liveChecksum === null) return 'missing-live';
  if (repoChecksum === null) return 'missing-repo';
  if (liveChecksum !== repoChecksum) return 'drift-local';
  if (repoChecksum !== manifestChecksum) return 'drift-repo';
  return 'ok';
};

/** Resolve and classify the state of a single tracked file. */
export const computeFileState = async (
  tuckDir: string,
  id: string,
  file: TrackedFileOutput
): Promise<FileStateEntry> => {
  const repoAbs = join(tuckDir, file.destination);
  const repoChecksum = (await pathExists(repoAbs)) ? await getFileChecksum(repoAbs) : null;

  // Resolve the LIVE location (home: expandPath; repo: bound root or null).
  const sourceAbs = await resolveLiveTarget(file);
  if (sourceAbs === null) {
    // Repo-scoped file whose repo is not bound on this machine — cannot compare.
    return {
      id,
      source: file.source,
      destination: file.destination,
      state: 'unknown-repo',
      liveChecksum: null,
      repoChecksum,
      manifestChecksum: file.checksum,
    };
  }

  const liveChecksum = (await pathExists(sourceAbs)) ? await getFileChecksum(sourceAbs) : null;

  return {
    id,
    source: file.source,
    destination: file.destination,
    state: classifyFileState(liveChecksum, repoChecksum, file.checksum),
    liveChecksum,
    repoChecksum,
    manifestChecksum: file.checksum,
  };
};

/** Compute the state of every tracked file in the manifest. */
export const computeStateModel = async (tuckDir: string): Promise<FileStateEntry[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  return Promise.all(
    Object.entries(files).map(([id, file]) => computeFileState(tuckDir, id, file))
  );
};

/** Summarize a state model by counting each non-ok state. */
export interface StateSummary {
  total: number;
  ok: number;
  driftLocal: number;
  driftRepo: number;
  missingLive: number;
  missingRepo: number;
  missingBoth: number;
  unknownRepo: number;
}

export const summarizeStateModel = (entries: FileStateEntry[]): StateSummary => {
  const summary: StateSummary = {
    total: entries.length,
    ok: 0,
    driftLocal: 0,
    driftRepo: 0,
    missingLive: 0,
    missingRepo: 0,
    missingBoth: 0,
    unknownRepo: 0,
  };
  for (const e of entries) {
    switch (e.state) {
      case 'ok':
        summary.ok++;
        break;
      case 'drift-local':
        summary.driftLocal++;
        break;
      case 'drift-repo':
        summary.driftRepo++;
        break;
      case 'missing-live':
        summary.missingLive++;
        break;
      case 'missing-repo':
        summary.missingRepo++;
        break;
      case 'missing-both':
        summary.missingBoth++;
        break;
      case 'unknown-repo':
        summary.unknownRepo++;
        break;
    }
  }
  return summary;
};
