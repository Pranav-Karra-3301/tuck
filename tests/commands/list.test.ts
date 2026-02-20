import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();

const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();
const promptsWarningMock = vi.fn();
const promptsNoteMock = vi.fn();

const loggerWarningMock = vi.fn();

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
}));

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
    log: {
      warning: promptsWarningMock,
    },
    note: promptsNoteMock,
  },
  logger: {
    warning: loggerWarningMock,
  },
  formatCount: vi.fn((count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`),
  colors: {
    bold: (x: string) => x,
    dim: (x: string) => x,
    cyan: (x: string) => x,
  },
}));

describe('list command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
      gitconfig: {
        source: '~/.gitconfig',
        destination: 'files/git/gitconfig',
        category: 'git',
      },
    });
  });

  it('prints grouped files in default mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { listCommand } = await import('../../src/commands/list.js');

    await listCommand.parseAsync(['node', 'list'], { from: 'user' });

    expect(promptsIntroMock).toHaveBeenCalledWith('tuck list');
    expect(promptsOutroMock).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('prints JSON output when --json is passed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { listCommand } = await import('../../src/commands/list.js');

    await listCommand.parseAsync(['node', 'list', '--json'], { from: 'user' });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('"shell"');
    expect(output).toContain('"source": "~/.zshrc"');

    logSpy.mockRestore();
  });

  it('prints only paths when --paths is passed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { listCommand } = await import('../../src/commands/list.js');

    await listCommand.parseAsync(['node', 'list', '--paths'], { from: 'user' });

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('~/.zshrc');
    expect(lines).toContain('~/.gitconfig');

    logSpy.mockRestore();
  });

  it('throws NotInitializedError when manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { listCommand } = await import('../../src/commands/list.js');

    await expect(listCommand.parseAsync(['node', 'list'], { from: 'user' })).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    });
  });

  it('warns when category filter has no matches', async () => {
    const { listCommand } = await import('../../src/commands/list.js');

    await listCommand.parseAsync(['node', 'list', '--category', 'terminal'], { from: 'user' });

    expect(loggerWarningMock).toHaveBeenCalledWith('No files found in category: terminal');
  });
});
