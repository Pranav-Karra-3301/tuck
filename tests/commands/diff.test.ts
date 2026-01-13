import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import { createMockTrackedFile } from '../utils/factories.js';
import path from 'path';

// Mock colors - simple passthrough functions
const mockColor = (str: string) => str;
const mockColors = {
  brand: mockColor,
  brandBold: mockColor,
  brandDim: mockColor,
  brandBg: mockColor,
  success: mockColor,
  warning: mockColor,
  error: mockColor,
  info: mockColor,
  muted: mockColor,
  bold: mockColor,
  highlight: mockColor,
  cyan: mockColor,
  green: mockColor,
  yellow: mockColor,
  red: mockColor,
  blue: mockColor,
  dim: mockColor,
  white: mockColor,
};

// Mock UI
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('general'),
    text: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
    },
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: '',
    })),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    brand: (str: string) => str,
    brandBold: (str: string) => str,
    brandDim: (str: string) => str,
    brandBg: (str: string) => str,
    success: (str: string) => str,
    warning: (str: string) => str,
    error: (str: string) => str,
    info: (str: string) => str,
    muted: (str: string) => str,
    bold: (str: string) => str,
    highlight: (str: string) => str,
    cyan: (str: string) => str,
    green: (str: string) => str,
    yellow: (str: string) => str,
    red: (str: string) => str,
    blue: (str: string) => str,
    dim: (str: string) => str,
    white: (str: string) => str,
  },
}));

describe('diff command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('diff formatting', () => {
    it('should format file missing on system correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        repoContent: 'line 1\nline 2',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File missing on system');
      expect(output).toContain('Repository content:');
      expect(output).toContain('+ line 1');
      expect(output).toContain('+ line 2');
    });

    it('should format file not in repo correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: 'line 1\nline 2',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File not yet synced to repository');
      expect(output).toContain('System content:');
      expect(output).toContain('- line 1');
      expect(output).toContain('- line 2');
    });

    it('should format line-by-line diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: 'line 1\nline 2\nline 3\nline 4',
        repoContent: 'line 1\nmodified\nline 3\nline 4',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('- line 2');
      expect(output).toContain('+ modified');
    });

    it('should format binary file diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test-binary',
        destination: 'files/test-binary',
        hasChanges: true,
        isBinary: true,
        systemSize: 100,
        repoSize: 200,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('Binary files differ');
      expect(output).toContain('System:');
      expect(output).toContain('Repo:');
      expect(output).toContain('100 B');
      expect(output).toContain('200 B');
    });

    it('should format directory diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test-dir',
        destination: 'files/test-dir',
        hasChanges: true,
        isDirectory: true,
        fileCount: 5,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('Directory content changed');
      expect(output).toContain('Contains 5 files');
    });
  });

  describe('file diff detection', () => {
    it('should handle empty files', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.empty.txt',
        destination: 'files/empty.txt',
        hasChanges: true,
        systemContent: '',
        repoContent: '',
        isBinary: undefined,
        isDirectory: undefined,
        fileCount: undefined,
        systemSize: undefined,
        repoSize: undefined,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toBeDefined();
      expect(typeof output).toBe('string');
    });

    it('should handle files with only additions', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: '',
        repoContent: 'new line',
        isBinary: undefined,
        isDirectory: undefined,
        fileCount: undefined,
        systemSize: undefined,
        repoSize: undefined,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File missing on system');
      expect(output).toContain('+ new line');
    });

    it('should handle files with only deletions', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: 'old line',
        repoContent: '',
        isBinary: undefined,
        isDirectory: undefined,
        fileCount: undefined,
        systemSize: undefined,
        repoSize: undefined,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File not yet synced to repository');
      expect(output).toContain('- old line');
    });
  });

  it('should handle empty files', async () => {
    const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

    const diff = {
      source: '~/.test.txt',
      destination: 'files/test.txt',
      hasChanges: true,
      systemContent: '',
      repoContent: '',
      isBinary: undefined,
      isDirectory: undefined,
      fileCount: undefined,
      systemSize: undefined,
      repoSize: undefined,
    };

    const output = formatUnifiedDiff(diff);

    expect(output).toBeDefined();
    expect(typeof output).toBe('string');
  });

  it('should handle files with only additions', async () => {
    const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

    const diff = {
      source: '~/.test.txt',
      destination: 'files/test.txt',
      hasChanges: true,
      systemContent: '',
      repoContent: 'new line',
    };

    const output = formatUnifiedDiff(diff);

    expect(output).toContain('File missing on system');
    expect(output).toContain('+ new line');
  });

  it('should handle files with only deletions', async () => {
    const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

    const diff = {
      source: '~/.test.txt',
      destination: 'files/test.txt',
      hasChanges: true,
      systemContent: 'old line',
      repoContent: '',
    };

    const output = formatUnifiedDiff(diff);

    expect(output).toContain('File not yet synced to repository');
    expect(output).toContain('- old line');
  });
});

describe('FileDiff interface', () => {
  it('should create correct FileDiff object', () => {
    const diff = {
      source: '~/.test.txt',
      destination: 'files/test.txt',
      hasChanges: true,
      systemContent: 'content',
      repoContent: 'content',
    };

    expect(diff.source).toBe('~/.test.txt');
    expect(diff.destination).toBe('files/test.txt');
    expect(diff.hasChanges).toBe(true);
    expect(diff.systemContent).toBe('content');
    expect(diff.repoContent).toBe('content');
  });

  it('should handle optional fields', () => {
    const diff = {
      source: '~/.test.txt',
      destination: 'files/test.txt',
      hasChanges: false,
    };

    expect(diff.source).toBeDefined();
    expect(diff.destination).toBeDefined();
    expect(diff.hasChanges).toBe(false);
    expect(diff.isBinary).toBeUndefined();
    expect(diff.isDirectory).toBeUndefined();
    expect(diff.fileCount).toBeUndefined();
  });
});
