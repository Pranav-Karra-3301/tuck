/**
 * Diff-summary helpers for `tuck apply`.
 *
 * "Safe first apply" (IDEAS 2.4) requires that apply ALWAYS shows a full diff
 * summary before it touches anything, so a user on a fresh machine can see
 * exactly which live files are about to be created vs overwritten — and pair it
 * with the auto-snapshot for a trustworthy, reversible first run.
 *
 * These functions are intentionally pure (no filesystem, no UI) so the summary
 * logic is unit-testable; the command layer resolves file existence and renders
 * the returned data.
 */

/** Whether a live destination will be newly created or overwritten in place. */
export type ApplyDiffStatus = 'new' | 'modify';

export interface ApplyDiffItem {
  /** Collapsed (display) live destination path. */
  destination: string;
  /** Detection category (shell, git, editors, ...). */
  category: string;
  status: ApplyDiffStatus;
}

export interface ApplyDiffSummary {
  items: ApplyDiffItem[];
  /** Count of destinations that do not yet exist on this machine. */
  newCount: number;
  /** Count of destinations that already exist and will be overwritten/merged. */
  modifyCount: number;
  /** Total number of files that will be applied. */
  total: number;
}

/**
 * Fold a list of diff items into a counted summary. Pure — callers pass items
 * already annotated with their new/modify status (resolved from the live FS).
 */
export const summarizeApplyDiff = (items: ApplyDiffItem[]): ApplyDiffSummary => {
  let newCount = 0;
  let modifyCount = 0;
  for (const item of items) {
    if (item.status === 'new') newCount += 1;
    else modifyCount += 1;
  }
  return { items, newCount, modifyCount, total: items.length };
};

/**
 * One-line human summary of an apply diff, e.g. "3 new, 2 to update".
 * Returns "No changes" for an empty diff.
 */
export const formatApplyDiffLine = (summary: ApplyDiffSummary): string => {
  const parts: string[] = [];
  if (summary.newCount > 0) {
    parts.push(`${summary.newCount} new`);
  }
  if (summary.modifyCount > 0) {
    parts.push(`${summary.modifyCount} to update`);
  }
  return parts.length > 0 ? parts.join(', ') : 'No changes';
};
