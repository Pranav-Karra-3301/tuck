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
import { logger, colors as c } from '../ui/index.js';
import { getTuckDir, expandPath, collapsePath, getSafeRepoPathFromDestination } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { copyFileOrDir } from '../lib/files.js';
import { NotInitializedError } from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
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

export const runVerify = async (options: VerifyOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck verify');
  const tuckDir = getTuckDir();

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
};

export const verifyCommand = new Command('verify')
  .description('Verify that the live system, the repo, and the manifest agree')
  .option('--json', 'Emit JSON envelope to stdout')
  .option('--exit-code', 'Exit non-zero if anything has drifted (CI gate)')
  .option('--fix', 'Re-copy missing repo copies from the live file (safe fixes only)')
  .action(async (options: VerifyOptions) => {
    await runVerify(options);
  });
