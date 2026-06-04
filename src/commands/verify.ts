/**
 * `tuck verify` — read-only drift detector.
 *
 * Compares, per tracked file, the live system copy, the repo copy, and the
 * manifest checksum (via lib/stateModel) and reports the state. This is the
 * primitive an agent uses to assert "applied state == tracked state" before
 * acting, and the CI gate (`--exit-code`) for "is everything in sync?".
 *
 *   tuck verify                 # human report
 *   tuck verify --json          # { summary, files: [...] } envelope
 *   tuck verify --exit-code     # non-zero exit if anything drifted
 *   tuck verify --fix           # re-copy missing repo copies from the live file
 */
import { Command } from 'commander';
import { resolve, dirname } from 'path';
import { readFile, writeFile, stat } from 'fs/promises';
import { ensureDir } from 'fs-extra';
import { logger, colors as c } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  getSafeRepoPathFromDestination,
  pathExists,
} from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { copyFileOrDir, getFileChecksum } from '../lib/files.js';
import { NotInitializedError } from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import {
  setWriteContext,
  snapshotWriteContext,
  restoreWriteContext,
  resolveWriteTarget,
  isSandbox,
  getWriteRoot,
} from '../lib/writeContext.js';
import { smartMerge, isShellFile, type MergeConflict } from '../lib/merge.js';
import { prepareFilesToApply } from './apply.js';
import {
  computeStateModel,
  summarizeStateModel,
  type FileStateEntry,
  type StateSummary,
} from '../lib/stateModel.js';

export interface VerifyOptions {
  json?: boolean;
  exitCode?: boolean;
  fix?: boolean;
  /**
   * Confine all write/preview targets under this directory (a "dry home"). Read
   * comparisons still use the real home; only the would-be write target routes
   * through resolveWriteTarget so the preview cannot mutate the operator's real ~.
   */
  root?: string;
  /**
   * Dry-apply diff mode: run the apply prepare pipeline into the sandbox and
   * report, per file, whether the live target would be created/modified/
   * unchanged — plus smart-merge conflicts and any path that would escape root.
   */
  apply?: boolean;
  /** Scope the dry-apply to a single bundle. */
  bundle?: string;
}

/** A single would-be change produced by `verify --apply`. */
export interface DryApplyChange {
  /** The resolved (sandbox-confined) write target. */
  target: string;
  status: 'created' | 'modified' | 'unchanged';
  /** Bytes of the existing LIVE target (0 when it does not exist). */
  bytesBefore: number;
  /** Bytes of the content apply WOULD write. */
  bytesAfter: number;
}

export interface DryApplyConflict extends MergeConflict {
  /** The live target the conflict was detected against. */
  target: string;
}

export interface DryApplyResult {
  changes: DryApplyChange[];
  conflicts: DryApplyConflict[];
  /** Sources whose would-be write target escapes the sandbox root (wrote nothing). */
  wouldEscapeRoot: string[];
}

/** Any non-`ok` file means the working set has drifted. */
export const hasDrift = (summary: StateSummary): boolean => summary.ok !== summary.total;

const STATE_LABEL: Record<FileStateEntry['state'], string> = {
  ok: 'ok',
  'drift-local': 'drift (local edited — run `tuck sync`)',
  'drift-repo': 'drift (repo changed — run `tuck restore`)',
  'missing-live': 'missing on system (run `tuck restore`)',
  'missing-repo': 'missing in repo (run `tuck verify --fix`)',
  'missing-both': 'missing everywhere (manifest references a vanished file)',
  'unknown-repo': 'repo not linked on this machine (run `tuck repo link`)',
};

/**
 * The only auto-`--fix` we apply is the unambiguously-safe one: when the repo
 * copy is missing but the live file exists, re-copy the live file INTO the repo.
 * This only writes inside the tuck repo and never mutates the user's system.
 */
const fixMissingRepo = async (tuckDir: string, entries: FileStateEntry[]): Promise<string[]> => {
  const fixed: string[] = [];
  for (const e of entries) {
    if (e.state !== 'missing-repo') continue;
    const repoAbs = getSafeRepoPathFromDestination(tuckDir, e.destination);
    await copyFileOrDir(expandPath(e.source), repoAbs, { overwrite: true });
    fixed.push(e.source);
  }
  return fixed;
};

/**
 * Dry-apply the local tuck repo into the sandbox `root` and diff each produced
 * file against the would-be LIVE target.
 *
 * - The prepare pipeline (`prepareFilesToApply`) is reused verbatim so the file
 *   set, repo copies, and live-target resolution match a real `tuck apply`.
 * - Writes route through `resolveWriteTarget`, confining every target under the
 *   sandbox root; a target that escapes is reported in `wouldEscapeRoot` and
 *   NOTHING is written for it.
 * - Manifest entries that prepare drops as unsafe (traversal / out-of-home
 *   sources) are surfaced in `wouldEscapeRoot` rather than silently discarded.
 * - smartMerge CONFLICTS (which a plain apply detects then throws away) are
 *   collected and returned.
 * - Status is derived by comparing the live target's checksum to the checksum of
 *   the content that WOULD be written (reusing `getFileChecksum`, not a private
 *   hash). The live read uses the REAL home; the write stays in the sandbox.
 */
export const dryApplyIntoSandbox = async (
  tuckDir: string,
  bundle?: string
): Promise<DryApplyResult> => {
  const manifest = await loadManifest(tuckDir);
  const { files } = await prepareFilesToApply(tuckDir, manifest, bundle);

  // Sources prepare KEPT — anything in the manifest with a real repo copy that
  // is NOT in this set was dropped (unsafe/escaping) and must be surfaced.
  const keptSources = new Set(files.map((f) => f.source));
  const wouldEscapeRoot: string[] = [];
  for (const file of Object.values(manifest.files)) {
    if (keptSources.has(file.source)) continue;
    const repoAbs = resolve(tuckDir, file.destination);
    // Only count entries whose repo copy actually exists (a real apply candidate);
    // a missing repo copy would be skipped by apply anyway, not an escape.
    if (await pathExists(repoAbs)) {
      wouldEscapeRoot.push(file.source);
    }
  }

  const changes: DryApplyChange[] = [];
  const conflicts: DryApplyConflict[] = [];

  for (const file of files) {
    // Read side uses the REAL live target (real home), never the sandbox.
    const liveExists = await pathExists(file.destination);

    // Resolve + confine the write target up front. An escape (traversal /
    // out-of-sandbox absolute) throws → report it and write NOTHING.
    let writeTarget: string;
    try {
      writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
    } catch {
      wouldEscapeRoot.push(file.source);
      continue;
    }

    // A tracked DIRECTORY entry: copy the whole tree into the sandbox (smartMerge
    // applies to shell TEXT files only) and diff by directory checksum. Reading a
    // directory as a file below would throw EISDIR.
    if ((await stat(file.repoPath)).isDirectory()) {
      await ensureDir(dirname(writeTarget));
      await copyFileOrDir(file.repoPath, writeTarget, { overwrite: true });
      let dirStatus: DryApplyChange['status'];
      if (!liveExists) {
        dirStatus = 'created';
      } else {
        const [liveSum, sandboxSum] = await Promise.all([
          getFileChecksum(file.destination),
          getFileChecksum(writeTarget),
        ]);
        dirStatus = liveSum === sandboxSum ? 'unchanged' : 'modified';
      }
      // Byte counts are per-file; for a directory the status is the signal.
      changes.push({ target: writeTarget, status: dirStatus, bytesBefore: 0, bytesAfter: 0 });
      continue;
    }

    // ── single file ──
    // Determine the content apply WOULD write: smart-merged for shell files with
    // an existing live copy (and surface the conflicts apply discards), else the
    // verbatim repo copy.
    let content = await readFile(file.repoPath, 'utf-8');
    if (isShellFile(file.source) && liveExists) {
      const merge = await smartMerge(file.destination, content);
      content = merge.content;
      for (const conflict of merge.conflicts) {
        conflicts.push({ ...conflict, target: collapsePath(file.destination) });
      }
    }

    await ensureDir(dirname(writeTarget));
    await writeFile(writeTarget, content, 'utf-8');

    const bytesAfter = Buffer.byteLength(content, 'utf-8');
    let bytesBefore = 0;
    let status: DryApplyChange['status'];
    if (!liveExists) {
      status = 'created';
    } else {
      const liveContent = await readFile(file.destination, 'utf-8');
      bytesBefore = Buffer.byteLength(liveContent, 'utf-8');
      // Compare via getFileChecksum (the project's canonical digest) — the live
      // file vs the freshly-written sandbox copy. No private hashing here.
      const [liveSum, sandboxSum] = await Promise.all([
        getFileChecksum(file.destination),
        getFileChecksum(writeTarget),
      ]);
      status = liveSum === sandboxSum ? 'unchanged' : 'modified';
    }

    changes.push({ target: writeTarget, status, bytesBefore, bytesAfter });
  }

  return { changes, conflicts, wouldEscapeRoot };
};

/**
 * `verify --apply`: emit the dry-apply diff envelope. Always runs against a
 * sandbox root (explicit `--root`, else an internal temp dir under the tuck
 * runtime area) and cleans up the sandbox afterwards. Never writes to the real
 * home — the live comparison is read-only.
 */
const runVerifyApply = async (options: VerifyOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck verify');
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // The sandbox root: an explicit --root, else an internal scratch dir.
  // `--root` is a GLOBAL option the preAction hook resolves into the WriteContext,
  // so when the subcommand didn't receive its own `options.root` (the common CLI
  // case) honor the global sandbox via getWriteRoot() — otherwise `--apply` would
  // silently ignore the user's `--root` and write into a throwaway temp dir.
  const explicitRoot = options.root
    ? resolve(expandPath(options.root))
    : isSandbox()
      ? getWriteRoot()
      : undefined;
  const sandboxRoot = explicitRoot ?? resolve(tuckDir, '.verify-sandbox', `dry-${Date.now()}`);
  const usingTempSandbox = !explicitRoot;

  // Confine ALL writes under the sandbox for the duration of the dry-apply.
  // Snapshot first so the finally restores any PRIOR boundary (e.g. a global
  // --root) instead of dropping it — critical in long-running (MCP) mode.
  const prevContext = snapshotWriteContext();
  setWriteContext({ root: sandboxRoot, isSandbox: true });
  try {
    await ensureDir(sandboxRoot);
    const result = await dryApplyIntoSandbox(tuckDir, options.bundle);

    if (isJsonMode()) {
      emitJsonOk(
        {
          root: sandboxRoot,
          changes: result.changes,
          conflicts: result.conflicts,
          wouldEscapeRoot: result.wouldEscapeRoot,
        },
        'tuck verify'
      );
    } else {
      logger.heading('Dry-apply preview (no real files touched):');
      for (const ch of result.changes) {
        const line = `${collapsePath(ch.target)} — ${ch.status} (${ch.bytesBefore} → ${ch.bytesAfter} bytes)`;
        if (ch.status === 'unchanged') {
          logger.dim(`  ${line}`);
        } else {
          logger.file(ch.status === 'created' ? 'add' : 'modify', line);
        }
      }
      if (result.conflicts.length > 0) {
        logger.blank();
        logger.warning(`${result.conflicts.length} smart-merge conflict(s):`);
        for (const cf of result.conflicts) {
          logger.warning(`  ${cf.target}: ${cf.type} ${cf.name}`);
        }
      }
      if (result.wouldEscapeRoot.length > 0) {
        logger.blank();
        logger.error(`${result.wouldEscapeRoot.length} entry(ies) would escape the sandbox root:`);
        for (const src of result.wouldEscapeRoot) logger.error(`  ${src} (skipped, wrote nothing)`);
      }
    }

    if (options.exitCode && (result.conflicts.length > 0 || result.wouldEscapeRoot.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    // Restore the prior write boundary (not a blind reset → null) and always
    // clean up the scratch sandbox. An explicit --root provided by the caller is
    // left on disk for inspection.
    restoreWriteContext(prevContext);
    if (usingTempSandbox) {
      try {
        const { rm } = await import('fs/promises');
        await rm(sandboxRoot, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; never fail a read-only preview over it.
      }
    }
  }
};

export const runVerify = async (options: VerifyOptions): Promise<void> => {
  // Dry-apply diff mode is a distinct, sandboxed pipeline.
  if (options.apply) {
    await runVerifyApply(options);
    return;
  }

  if (options.json) setJsonMode(true, 'tuck verify');
  const tuckDir = getTuckDir();

  // --root (without --apply): confine the read-only verify's preview targets to a
  // dry home. The live comparison still reads the real home; only resolveWriteTarget
  // (used by --fix's repo writes stay inside the repo) routes through the sandbox.
  const rootForContext = options.root ? resolve(expandPath(options.root)) : undefined;
  const prevContext = snapshotWriteContext();
  if (rootForContext) {
    setWriteContext({ root: rootForContext, isSandbox: true });
  }

  try {
    try {
      await loadManifest(tuckDir);
    } catch {
      throw new NotInitializedError();
    }

    let entries = await computeStateModel(tuckDir);
    let fixed: string[] = [];

    if (options.fix) {
      fixed = await fixMissingRepo(tuckDir, entries);
      if (fixed.length > 0) entries = await computeStateModel(tuckDir);
    }

    const summary = summarizeStateModel(entries);

    if (isJsonMode()) {
      emitJsonOk(
        {
          summary,
          fixed,
          files: entries.map((e) => ({
            source: e.source,
            state: e.state,
            liveChecksum: e.liveChecksum,
            repoChecksum: e.repoChecksum,
            manifestChecksum: e.manifestChecksum,
          })),
        },
        'tuck verify'
      );
    } else {
      logger.heading('Verifying tracked files:');
      for (const e of entries) {
        const label = STATE_LABEL[e.state];
        const line = `  ${collapsePath(e.source)} — ${label}`;
        if (e.state === 'ok') logger.dim(line);
        else logger.warning(line);
      }
      if (fixed.length > 0) logger.info(`Fixed ${fixed.length} missing repo copy(ies).`);
      logger.blank();
      logger.info(
        `${summary.ok}/${summary.total} ok` +
          (hasDrift(summary)
            ? c.warning(
                ` — ${summary.driftLocal} local, ${summary.driftRepo} repo, ${
                  summary.missingLive + summary.missingRepo + summary.missingBoth
                } missing`
              )
            : '')
      );
    }

    if (options.exitCode && hasDrift(summary)) {
      process.exitCode = 1;
    }
  } finally {
    // Restore the prior boundary we may have overridden for --root (don't blind
    // reset → null, which would drop a global sandbox in long-running mode).
    if (rootForContext) restoreWriteContext(prevContext);
  }
};

export const verifyCommand = new Command('verify')
  .description('Verify that the live system, the repo, and the manifest agree')
  .option('--json', 'Emit JSON envelope to stdout')
  .option('--exit-code', 'Exit non-zero if anything has drifted (CI gate)')
  .option('--fix', 'Re-copy missing repo copies from the live file (safe fixes only)')
  .option(
    '--root <dir>',
    'Confine write/preview targets under this directory (sandbox / dry-home preview)'
  )
  .option('--apply', 'Dry-apply diff: preview created/modified/unchanged, conflicts, and escapes')
  .option('-b, --bundle <name>', 'Scope --apply to a single bundle')
  .action(async (options: VerifyOptions) => {
    await runVerify(options);
  });
