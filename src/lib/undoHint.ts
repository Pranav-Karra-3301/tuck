/**
 * Canonical one-line "restore with tuck undo" breadcrumb.
 *
 * tuck already captures a time-machine snapshot before every destructive
 * mutation (apply, sync pull/conflict resolution, remove --delete). Surfacing
 * that snapshot as a visible, copy-pasteable recovery path — right after the
 * mutation happens — is the trust story that answers the "first apply is
 * destructive" fear (IDEAS 6.5). Every destructive flow prints the SAME line so
 * users learn one recovery command.
 *
 * When the caller knows the exact snapshot id it just created, pass it so the
 * breadcrumb pins the undo to that precise checkpoint; otherwise the generic
 * `--latest` form is shown.
 */
export const undoBreadcrumb = (snapshotId?: string): string =>
  snapshotId
    ? `Undo this change: tuck undo ${snapshotId}  (or tuck undo --latest)`
    : 'Undo this change: tuck undo --latest';

/** Short title used for boxed/labelled breadcrumb notes. */
export const UNDO_BREADCRUMB_TITLE = 'Undo';
