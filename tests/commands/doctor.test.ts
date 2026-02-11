import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runDoctorChecksMock = vi.fn();
const getDoctorExitCodeMock = vi.fn();

const loggerSuccessMock = vi.fn();
const loggerWarningMock = vi.fn();
const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerDimMock = vi.fn();
const loggerBlankMock = vi.fn();

const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();

vi.mock('../../src/lib/doctor.js', () => ({
  DOCTOR_CATEGORIES: ['env', 'repo', 'manifest', 'security', 'hooks'],
  runDoctorChecks: runDoctorChecksMock,
  getDoctorExitCode: getDoctorExitCodeMock,
}));

vi.mock('../../src/ui/index.js', () => ({
  logger: {
    success: loggerSuccessMock,
    warning: loggerWarningMock,
    error: loggerErrorMock,
    info: loggerInfoMock,
    dim: loggerDimMock,
    blank: loggerBlankMock,
  },
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
  },
}));

describe('doctor command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('prints human output and sets exit code for failures', async () => {
    runDoctorChecksMock.mockResolvedValue({
      generatedAt: '2026-02-11T00:00:00.000Z',
      tuckDir: '/test-home/.tuck',
      summary: { passed: 1, warnings: 0, failed: 1 },
      checks: [
        {
          id: 'repo.tuck-directory',
          category: 'repo',
          status: 'fail',
          message: 'Missing tuck directory',
          fix: 'Run tuck init',
        },
      ],
    });
    getDoctorExitCodeMock.mockReturnValue(1);

    const { runDoctor } = await import('../../src/commands/doctor.js');

    await runDoctor({ strict: true });

    expect(promptsIntroMock).toHaveBeenCalledWith('tuck doctor');
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerDimMock).toHaveBeenCalledWith('  Fix: Run tuck init');
    expect(process.exitCode).toBe(1);
  });

  it('prints JSON output when requested', async () => {
    const jsonSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runDoctorChecksMock.mockResolvedValue({
      generatedAt: '2026-02-11T00:00:00.000Z',
      tuckDir: '/test-home/.tuck',
      summary: { passed: 2, warnings: 1, failed: 0 },
      checks: [],
    });
    getDoctorExitCodeMock.mockReturnValue(2);

    const { runDoctor } = await import('../../src/commands/doctor.js');

    await runDoctor({ json: true, strict: true });

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(promptsIntroMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);

    jsonSpy.mockRestore();
  });

  it('validates category option on command parse', async () => {
    const { doctorCommand } = await import('../../src/commands/doctor.js');

    await expect(
      doctorCommand.parseAsync(['node', 'doctor', '--category', 'invalid'], { from: 'user' })
    ).rejects.toThrow('Invalid category "invalid"');
  });
});
