import { describe, it, expect } from 'vitest';
import { undoBreadcrumb, UNDO_BREADCRUMB_TITLE } from '../../src/lib/undoHint.js';

describe('undoBreadcrumb', () => {
  it('pins the breadcrumb to a specific snapshot id when provided', () => {
    const line = undoBreadcrumb('2026-07-09-101112');
    expect(line).toContain('tuck undo 2026-07-09-101112');
    expect(line).toContain('tuck undo --latest');
  });

  it('falls back to --latest when no snapshot id is known', () => {
    expect(undoBreadcrumb()).toBe('Undo this change: tuck undo --latest');
  });

  it('exposes a stable note title', () => {
    expect(UNDO_BREADCRUMB_TITLE).toBe('Undo');
  });
});
