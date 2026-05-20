/**
 * Interactive merge-conflict resolution UI.
 *
 * Given a list of {@link FileConflict}s detected by the rebase machinery, walk
 * the user through each file with a side-by-side preview and a four-way
 * choice: keep local, keep remote, edit in $EDITOR, or abort the entire sync.
 *
 * The UI helpers live here (not in `src/lib/mergeConflicts.ts`) so the library
 * stays import-light and testable without stubbing @clack/prompts.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import boxen from 'boxen';
import { prompts } from './prompts.js';
import { colors as c } from './theme.js';
import type { FileConflict, ConflictResolution } from '../lib/mergeConflicts.js';

const MAX_PREVIEW_LINES = 20;

/**
 * Build a compact side-by-side preview of the conflict for the terminal.
 * Truncates long files so the prompt UI stays usable.
 */
const renderConflictPreview = (conflict: FileConflict): string => {
  const ours = conflict.oursDeleted
    ? c.dim('(deleted locally)')
    : truncate(conflict.ours, MAX_PREVIEW_LINES);
  const theirs = conflict.theirsDeleted
    ? c.dim('(deleted on remote)')
    : truncate(conflict.theirs, MAX_PREVIEW_LINES);

  const oursBox = boxen(ours, {
    title: c.brand('LOCAL (ours)'),
    titleAlignment: 'left',
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: 'cyan',
  });

  const theirsBox = boxen(theirs, {
    title: c.warning('REMOTE (theirs)'),
    titleAlignment: 'left',
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: 'yellow',
  });

  return `${oursBox}\n${theirsBox}`;
};

const truncate = (content: string, maxLines: number): string => {
  if (!content) return c.dim('(empty)');
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  const head = lines.slice(0, maxLines).join('\n');
  return `${head}\n${c.dim(`… (${lines.length - maxLines} more lines)`)}`;
};

/**
 * Build a temp file pre-populated with conflict markers so the user can
 * resolve the file in their editor of choice, then read the saved content
 * back when the editor exits.
 */
const editInEditor = async (conflict: FileConflict): Promise<string> => {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmpPath = join(
    tmpdir(),
    `tuck-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeForFilename(conflict.path)}`
  );

  const initialContent = buildConflictMarkers(conflict);
  await fs.writeFile(tmpPath, initialContent, 'utf-8');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [tmpPath], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Editor "${editor}" exited with code ${code}`));
        }
      });
    });

    const finalContent = await fs.readFile(tmpPath, 'utf-8');
    return finalContent;
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
};

const sanitizeForFilename = (input: string): string =>
  input.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);

const buildConflictMarkers = (conflict: FileConflict): string => {
  const ours = conflict.oursDeleted ? '' : conflict.ours;
  const theirs = conflict.theirsDeleted ? '' : conflict.theirs;
  return [
    '<<<<<<< LOCAL (ours)',
    ours,
    '=======',
    theirs,
    '>>>>>>> REMOTE (theirs)',
    '',
  ].join('\n');
};

/**
 * Walk the user through each conflict and collect their resolutions. Returns
 * the resolutions in the same order as the input. If the user picks `abort`
 * for any file, that choice short-circuits and is the last entry in the array
 * — the caller is responsible for calling `abortRebase`.
 */
export const resolveConflictsInteractively = async (
  conflicts: FileConflict[]
): Promise<ConflictResolution[]> => {
  if (conflicts.length === 0) return [];

  prompts.log.warning(
    `Found ${conflicts.length} conflicting file${conflicts.length === 1 ? '' : 's'} during pull`
  );

  console.log();
  console.log(c.bold('Conflicting files:'));
  for (const conflict of conflicts) {
    console.log(c.yellow(`  ! ${conflict.path}`));
  }
  console.log();

  const resolutions: ConflictResolution[] = [];

  for (const conflict of conflicts) {
    console.log();
    console.log(c.bold(`Resolving: ${conflict.path}`));
    console.log(renderConflictPreview(conflict));
    console.log();

    const choice = await prompts.select<'ours' | 'theirs' | 'edited' | 'abort'>(
      `How should ${conflict.path} be resolved?`,
      [
        { value: 'ours', label: 'Keep local (ours)', hint: 'discard remote changes for this file' },
        { value: 'theirs', label: 'Keep remote (theirs)', hint: 'discard local changes for this file' },
        { value: 'edited', label: `Edit in $EDITOR (${process.env.EDITOR || 'vi'})`, hint: 'merge manually' },
        { value: 'abort', label: 'Abort entire sync', hint: 'roll back the pull, no changes applied' },
      ]
    );

    if (choice === 'abort') {
      resolutions.push({ path: conflict.path, choice: 'abort' });
      return resolutions;
    }

    if (choice === 'edited') {
      try {
        const finalContent = await editInEditor(conflict);
        resolutions.push({ path: conflict.path, choice: 'edited', finalContent });
      } catch (error) {
        prompts.log.error(
          `Editor exited with an error: ${error instanceof Error ? error.message : String(error)}`
        );
        const fallback = await prompts.select<'ours' | 'theirs' | 'abort'>(
          'Pick a fallback resolution:',
          [
            { value: 'ours', label: 'Keep local (ours)' },
            { value: 'theirs', label: 'Keep remote (theirs)' },
            { value: 'abort', label: 'Abort entire sync' },
          ]
        );
        if (fallback === 'abort') {
          resolutions.push({ path: conflict.path, choice: 'abort' });
          return resolutions;
        }
        resolutions.push({ path: conflict.path, choice: fallback });
      }
      continue;
    }

    resolutions.push({ path: conflict.path, choice });
  }

  return resolutions;
};
