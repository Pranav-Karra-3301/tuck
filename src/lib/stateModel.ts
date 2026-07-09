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
import { stat, readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { pathExists } from './paths.js';
import { getFileChecksum } from './files.js';
import { getAllTrackedFiles } from './manifest.js';
import { resolveLiveTarget } from './repoScope.js';
import { materializeForLive, keystorePassphrase, buildMaterializeCtx } from './materialize.js';
import { extractSubtree, hasSubtree } from './jsonKey.js';
import type { TemplateContext } from './template.js';
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

/**
 * Compute the LIVE checksum for a tracked source, with a conservative
 * mtime+size short-circuit (the git/make cache).
 *
 * For a SINGLE regular file that carries a recorded `sourceMtimeMs` +
 * `sourceSize` (captured when its checksum was last written), we stat the live
 * file first; if it is a regular file whose size AND mtimeMs both equal the
 * recorded values, the content cannot have changed under any normal edit, so we
 * reuse the recorded `checksum` instead of re-hashing.
 *
 * Deliberate limitations (kept narrow so we never MISS a real change):
 *   - Directories are NEVER short-circuited: a nested file change does not move
 *     the directory's own mtime/size, so we always re-hash dirs.
 *   - Legacy entries without recorded mtime/size fall back to full hashing.
 *   - The ONLY accepted miss is a content change that preserves BOTH the mtime
 *     and the byte size — the same (vanishingly rare) blind spot every
 *     mtime+size cache has.
 */
const computeLiveChecksum = async (
  sourceAbs: string,
  file: TrackedFileOutput
): Promise<string | null> => {
  if (file.sourceMtimeMs !== undefined && file.sourceSize !== undefined) {
    try {
      const st = await stat(sourceAbs);
      if (st.isFile() && st.size === file.sourceSize && st.mtimeMs === file.sourceMtimeMs) {
        // Unchanged single file — trust the recorded checksum, skip re-hashing.
        return file.checksum;
      }
    } catch {
      // Missing/inaccessible — fall through; pathExists + hashing below decide.
    }
  }

  return (await pathExists(sourceAbs)) ? await getFileChecksum(sourceAbs) : null;
};

/** Resolve and classify the state of a single tracked file. */
export const computeFileState = async (
  tuckDir: string,
  id: string,
  file: TrackedFileOutput,
  ctx?: TemplateContext
): Promise<FileStateEntry> => {
  const repoAbs = join(tuckDir, file.destination);
  const repoChecksum = (await pathExists(repoAbs)) ? await getFileChecksum(repoAbs) : null;

  // Resolve the LIVE location (home: expandPath; repo: bound root or null).
  const sourceAbs = await resolveLiveTarget(file);

  const entry = (
    state: FileState,
    liveChecksum: string | null,
    repoChk: string | null
  ): FileStateEntry => ({
    id,
    source: file.source,
    destination: file.destination,
    state,
    liveChecksum,
    repoChecksum: repoChk,
    manifestChecksum: file.checksum,
  });

  if (sourceAbs === null) {
    // Repo-scoped file whose repo is not bound on this machine — cannot compare.
    return entry('unknown-repo', null, repoChecksum);
  }

  // JSON-key files: the tracked unit is the SUBTREE at `jsonKey`, not the whole
  // live file. Compare the checksum of the subtree extracted from the LIVE file
  // against the repo copy (which stores exactly that canonical subtree) — so
  // machine-managed keys elsewhere in the live file never register as drift.
  if (file.jsonKey) {
    const liveExists = await pathExists(sourceAbs);
    if (!liveExists && repoChecksum === null) return entry('missing-both', null, repoChecksum);
    if (!liveExists) return entry('missing-live', null, repoChecksum);
    if (repoChecksum === null) return entry('missing-repo', null, repoChecksum);
    try {
      const liveContent = await readFile(sourceAbs, 'utf8');
      // The tracked key is absent from the live file: the subtree is effectively
      // missing on this machine (apply would re-add it).
      if (!hasSubtree(liveContent, file.jsonKey)) return entry('missing-live', null, repoChecksum);
      const liveSub = extractSubtree(liveContent, file.jsonKey);
      const liveChecksum = createHash('sha256').update(Buffer.from(liveSub, 'utf8')).digest('hex');
      const state: FileState =
        liveChecksum !== repoChecksum
          ? 'drift-local'
          : repoChecksum !== file.checksum
            ? 'drift-repo'
            : 'ok';
      return entry(state, liveChecksum, repoChecksum);
    } catch {
      // Live file is unreadable / not valid JSON: surface as local drift so the
      // user investigates, rather than crashing status/verify.
      return entry('drift-local', null, repoChecksum);
    }
  }

  // Materialized files (template/encrypted): the LIVE form is materialize(repo),
  // not the raw repo bytes. Hash the live file DIRECTLY (the mtime+size
  // short-circuit would wrongly return the recorded REPO checksum for an
  // encrypted file's plaintext live copy) and compare against materialize(repo).
  // DIRECTORIES are never materialized (readFile would EISDIR, then the catch
  // would mask real drift as `ok`); a template/encrypted DIR falls through to the
  // normal directory-checksum comparison below.
  const repoIsDir = repoChecksum !== null && (await stat(repoAbs)).isDirectory();
  if ((file.template || file.encrypted) && !repoIsDir) {
    const liveChecksum = (await pathExists(sourceAbs)) ? await getFileChecksum(sourceAbs) : null;
    if (liveChecksum === null && repoChecksum === null) return entry('missing-both', liveChecksum, repoChecksum);
    if (liveChecksum === null) return entry('missing-live', liveChecksum, repoChecksum);
    if (repoChecksum === null) return entry('missing-repo', liveChecksum, repoChecksum);
    try {
      const useCtx = ctx ?? (await buildMaterializeCtx(tuckDir));
      const raw = await readFile(repoAbs);
      const expected = await materializeForLive(raw, file, useCtx, { getPassphrase: keystorePassphrase });
      const expectedChecksum = createHash('sha256').update(Buffer.from(expected, 'utf8')).digest('hex');
      // live ≠ materialize(repo) → stale/edited (remedy: `tuck apply`, since sync
      // skips these files). Otherwise raw repo vs manifest distinguishes drift-repo.
      const state: FileState =
        liveChecksum !== expectedChecksum
          ? 'drift-local'
          : repoChecksum !== file.checksum
            ? 'drift-repo'
            : 'ok';
      return entry(state, liveChecksum, repoChecksum);
    } catch {
      // Locked keystore / undecryptable repo file: can't compute the expected live
      // form — degrade to ok-by-presence rather than failing status/verify offline.
      return entry('ok', liveChecksum, repoChecksum);
    }
  }

  const liveChecksum = await computeLiveChecksum(sourceAbs, file);
  return entry(classifyFileState(liveChecksum, repoChecksum, file.checksum), liveChecksum, repoChecksum);
};

/** Compute the state of every tracked file in the manifest. */
export const computeStateModel = async (tuckDir: string): Promise<FileStateEntry[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  // Build the template context ONCE (built-in vars + config.templates.variables)
  // and reuse it across every materialized-file comparison.
  const ctx = await buildMaterializeCtx(tuckDir);
  return Promise.all(
    Object.entries(files).map(([id, file]) => computeFileState(tuckDir, id, file, ctx))
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
