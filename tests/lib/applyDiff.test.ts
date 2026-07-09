import { describe, it, expect } from 'vitest';
import {
  summarizeApplyDiff,
  formatApplyDiffLine,
  type ApplyDiffItem,
} from '../../src/lib/applyDiff.js';

const item = (
  destination: string,
  status: 'new' | 'modify',
  category = 'shell'
): ApplyDiffItem => ({ destination, category, status });

describe('summarizeApplyDiff', () => {
  it('counts new and modify entries separately', () => {
    const summary = summarizeApplyDiff([
      item('~/.zshrc', 'new'),
      item('~/.gitconfig', 'modify'),
      item('~/.vimrc', 'new'),
    ]);

    expect(summary.newCount).toBe(2);
    expect(summary.modifyCount).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.items).toHaveLength(3);
  });

  it('returns zero counts for an empty diff', () => {
    const summary = summarizeApplyDiff([]);
    expect(summary).toEqual({ items: [], newCount: 0, modifyCount: 0, total: 0 });
  });
});

describe('formatApplyDiffLine', () => {
  it('renders both new and update counts', () => {
    const summary = summarizeApplyDiff([item('~/.zshrc', 'new'), item('~/.gitconfig', 'modify')]);
    expect(formatApplyDiffLine(summary)).toBe('1 new, 1 to update');
  });

  it('renders only the new count when nothing is modified', () => {
    const summary = summarizeApplyDiff([item('~/.zshrc', 'new'), item('~/.vimrc', 'new')]);
    expect(formatApplyDiffLine(summary)).toBe('2 new');
  });

  it('renders only the update count when nothing is new', () => {
    const summary = summarizeApplyDiff([item('~/.gitconfig', 'modify')]);
    expect(formatApplyDiffLine(summary)).toBe('1 to update');
  });

  it('reports no changes for an empty diff', () => {
    expect(formatApplyDiffLine(summarizeApplyDiff([]))).toBe('No changes');
  });
});
