/**
 * gitleaks report-path regression test.
 *
 * gitleaks NEVER writes findings to stdout (without -v it prints nothing there);
 * it only emits its JSON report when `--report-path <file>` is passed. The old
 * code parsed stdout, which was always empty, so a configured gitleaks scanner
 * silently reported every file clean — a no-op security control. scanWithGitleaks
 * must instead read the findings from the report file it points gitleaks at, and
 * must fall back to the built-in scanner (fail closed) when no report is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { dirname } from 'path';

const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    // promisify(execFile) calls execFile(cmd, args, opts, callback).
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = args[0] as string;
    const argv = args[1] as string[];
    execFileMock(cmd, argv);

    // Emulate gitleaks: write the JSON report to the --report-path target (never
    // to stdout), unless the mock was told to skip it.
    const reportIdx = argv.indexOf('--report-path');
    const reportPath = reportIdx >= 0 ? argv[reportIdx + 1] : undefined;

    if (reportPath && currentReport !== undefined) {
      // gitleaks' report lives under os.tmpdir(); create that dir in memfs.
      vol.mkdirSync(dirname(reportPath), { recursive: true });
      vol.writeFileSync(reportPath, currentReport);
    }
    callback(null, { stdout: '', stderr: '' });
  },
}));

// The report body the mocked gitleaks "writes" for the current test. `undefined`
// means "write no report at all" (simulate a gitleaks that produced nothing).
let currentReport: string | undefined;

const AWS_FINDING = [
  {
    Description: 'AWS Access Key',
    StartLine: 1,
    EndLine: 1,
    StartColumn: 1,
    EndColumn: 20,
    Match: 'key = AKIAIOSFODNN7EXAMPLE',
    Secret: 'AKIAIOSFODNN7EXAMPLE',
    File: '/test-home/config',
    RuleID: 'aws-access-token',
  },
];

describe('scanWithGitleaks report handling', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync('/test-home', { recursive: true });
    execFileMock.mockClear();
    currentReport = undefined;
  });

  it('detects secrets from the report file gitleaks writes (not stdout)', async () => {
    const { scanWithGitleaks } = await import('../../src/lib/secrets/external.js');
    currentReport = JSON.stringify(AWS_FINDING);

    const summary = await scanWithGitleaks(['/test-home/config']);

    expect(summary.totalSecrets).toBe(1);
    expect(summary.filesWithSecrets).toBe(1);
    expect(summary.results[0].matches[0].value).toBe('AKIAIOSFODNN7EXAMPLE');

    // Confirm we actually asked gitleaks to write a report.
    const argv = execFileMock.mock.calls[0][1] as string[];
    expect(argv).toContain('--report-path');
  });

  it('reports clean when gitleaks writes an empty report array', async () => {
    const { scanWithGitleaks } = await import('../../src/lib/secrets/external.js');
    currentReport = '[]';

    const summary = await scanWithGitleaks(['/test-home/config']);

    expect(summary.totalSecrets).toBe(0);
    expect(summary.filesWithSecrets).toBe(0);
  });

  it('falls back to the built-in scanner (does not report clean) when no report is written', async () => {
    const { scanWithGitleaks } = await import('../../src/lib/secrets/external.js');
    // gitleaks "succeeds" but writes nothing — the pre-fix bug treated this as
    // clean. The file actually contains a live AWS key, which the built-in
    // fallback must catch.
    currentReport = undefined;
    vol.writeFileSync('/test-home/config', 'aws_key = AKIAIOSFODNN7EXAMPLE\n');

    const summary = await scanWithGitleaks(['/test-home/config']);

    expect(summary.totalSecrets).toBeGreaterThanOrEqual(1);
    expect(summary.filesWithSecrets).toBe(1);
  });
});
