/**
 * Regression tests for the W4-B scan perf refactor (src/commands/scan.ts).
 *
 * The old scan loop called getTrackedFileBySource (O(N)) AND isIgnored (which
 * re-reads .tuckignore from disk) once PER detected file, i.e.
 * O(detected × tracked) tracked-lookups and ~detected redundant .tuckignore
 * reads. The refactor builds the source→{id,file} index ONCE and loads
 * .tuckignore ONCE before the loop, then does O(1) checks per file — with
 * identical "already tracked" / "ignored" results.
 *
 * This file uses its own complete mock topology (including the new
 * buildSourceIndex / loadTuckignore / isIgnoredInSet seams) so it exercises the
 * refactored code path directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadManifestMock = vi.fn();
const buildSourceIndexMock = vi.fn();
const detectDotfilesMock = vi.fn();
const loadTuckignoreMock = vi.fn();
const shouldExcludeFromBinMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  colors: {
    bold: Object.assign((x: string) => x, { cyan: (x: string) => x }),
    dim: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    cyan: (x: string) => x,
    white: (x: string) => x,
  },
  logger: {
    info: vi.fn(),
    warning: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    dim: vi.fn(),
  },
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    select: vi.fn().mockResolvedValue('preview'),
    multiselect: vi.fn(),
    text: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  collapsePath: vi.fn((p: string) => p),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  buildSourceIndex: buildSourceIndexMock,
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: detectDotfilesMock,
  DETECTION_CATEGORIES: {
    shell: { icon: '$', name: 'Shell', description: 'Shell configuration' },
    git: { icon: '*', name: 'Git', description: 'Git configuration' },
  },
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  loadTuckignore: loadTuckignoreMock,
  isIgnoredInSet: (set: Set<string>, path: string) => set.has(path),
}));

vi.mock('../../src/lib/binary.js', () => ({
  shouldExcludeFromBin: shouldExcludeFromBinMock,
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: vi.fn().mockResolvedValue({
    succeeded: 0,
    failed: 0,
    errors: [],
    sensitiveFiles: [],
  }),
}));

vi.mock('../../src/lib/trackPipeline.js', () => ({
  preparePathsForTracking: vi.fn().mockResolvedValue([]),
}));

describe('scan command perf (W4-B)', () => {
  const DETECTED = [
    { path: '~/.zshrc', category: 'shell', description: 'Shell config', sensitive: false, isDirectory: false },
    { path: '~/.gitconfig', category: 'git', description: 'Git config', sensitive: false, isDirectory: false },
    { path: '~/.vimrc', category: 'shell', description: 'Vim config', sensitive: false, isDirectory: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    loadManifestMock.mockResolvedValue({ files: {} });
    detectDotfilesMock.mockResolvedValue(DETECTED);
    loadTuckignoreMock.mockResolvedValue(new Set<string>());
    shouldExcludeFromBinMock.mockResolvedValue(false);
    // .zshrc is already tracked; the rest are new.
    buildSourceIndexMock.mockResolvedValue(
      new Map([['~/.zshrc', { id: 'zshrc', file: { source: '~/.zshrc' } }]])
    );
  });

  it('builds the source index ONCE and loads .tuckignore ONCE regardless of detected count', async () => {
    const { runScan } = await import('../../src/commands/scan.js');
    await runScan({ quick: true });

    // 3 detected files, but each "is tracked?" / "is ignored?" lookup uses the
    // single prebuilt index / preloaded set — not a per-file disk read.
    expect(buildSourceIndexMock).toHaveBeenCalledTimes(1);
    expect(loadTuckignoreMock).toHaveBeenCalledTimes(1);
  });

  it('marks already-tracked files via the index (same answer as getTrackedFileBySource)', async () => {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      const { runScan } = await import('../../src/commands/scan.js');
      await runScan({ quick: true, all: true });
    } finally {
      console.log = origLog;
    }

    const out = captured.join('\n');
    // .zshrc is in the index → classified as already tracked (1 tracked), and
    // the remaining two (.gitconfig, .vimrc) are new — exactly what the old
    // per-file getTrackedFileBySource path would have reported.
    expect(out).toContain('2 new, 1 already tracked');
  });

  it('skips ignored files using the preloaded ignore set', async () => {
    // Ignore .gitconfig: it must not appear among the new/selectable files.
    loadTuckignoreMock.mockResolvedValue(new Set<string>(['~/.gitconfig']));

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      const { runScan } = await import('../../src/commands/scan.js');
      await runScan({ quick: true });
    } finally {
      console.log = origLog;
    }

    const out = captured.join('\n');
    expect(out).not.toContain('~/.gitconfig');
    expect(out).toContain('~/.vimrc');
  });
});
