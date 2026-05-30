import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// These tests verify the platform-aware default editor used when neither
// $EDITOR nor $VISUAL is set. We toggle the mocked IS_WINDOWS flag and
// re-import the modules so each picks up the right platform constant.

const ORIGINAL_EDITOR = process.env.EDITOR;
const ORIGINAL_VISUAL = process.env.VISUAL;

const clearEditorEnv = (): void => {
  delete process.env.EDITOR;
  delete process.env.VISUAL;
};

const restoreEditorEnv = (): void => {
  if (ORIGINAL_EDITOR === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = ORIGINAL_EDITOR;
  if (ORIGINAL_VISUAL === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = ORIGINAL_VISUAL;
};

describe('default editor (platform-aware)', () => {
  beforeEach(() => {
    clearEditorEnv();
    vi.resetModules();
  });

  afterEach(() => {
    restoreEditorEnv();
    vi.resetModules();
    vi.doUnmock('../../src/lib/platform.js');
  });

  it('config.ts defaults to notepad on Windows, vim elsewhere', async () => {
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: true }));
    const winMod = await import('../../src/commands/config.js');
    expect(winMod.getDefaultEditor()).toBe('notepad');

    vi.resetModules();
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));
    const nixMod = await import('../../src/commands/config.js');
    expect(nixMod.getDefaultEditor()).toBe('vim');
  });

  it('config.ts respects $EDITOR when set', async () => {
    process.env.EDITOR = 'nano';
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: true }));
    const mod = await import('../../src/commands/config.js');
    expect(mod.getDefaultEditor()).toBe('nano');
  });

  it('ui/merge.ts defaults to notepad on Windows, vi elsewhere', async () => {
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: true }));
    const winMod = await import('../../src/ui/merge.js');
    expect(winMod.getDefaultEditor()).toBe('notepad');

    vi.resetModules();
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));
    const nixMod = await import('../../src/ui/merge.js');
    expect(nixMod.getDefaultEditor()).toBe('vi');
  });

  it('ui/merge.ts respects $VISUAL when set', async () => {
    process.env.VISUAL = 'code -w';
    vi.doMock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));
    const mod = await import('../../src/ui/merge.js');
    expect(mod.getDefaultEditor()).toBe('code -w');
  });
});
