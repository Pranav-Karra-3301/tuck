import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { runDoctorChecks, getDoctorExitCode } from '../../src/lib/doctor.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';
import { initTestTuck, TEST_HOME, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

vi.mock('../../src/lib/git.js', () => ({
  getStatus: vi.fn().mockResolvedValue({
    isRepo: true,
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    hasChanges: false,
  }),
}));

describe('doctor checks', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
  });

  it('reports healthy status for a valid initialized repository', async () => {
    await initTestTuck();

    const report = await runDoctorChecks();

    expect(report.summary.failed).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.checks.some((check) => check.id === 'repo.tuck-directory' && check.status === 'pass')).toBe(true);
    expect(report.checks.some((check) => check.id === 'repo.manifest-loadable' && check.status === 'pass')).toBe(true);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it('fails when tuck directory is missing', async () => {
    vol.mkdirSync(TEST_HOME, { recursive: true });

    const report = await runDoctorChecks();

    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repo.tuck-directory',
          status: 'fail',
        }),
      ])
    );
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it('fails manifest checks when unsafe destinations exist', async () => {
    await initTestTuck();

    const manifest = createMockManifest({
      files: {
        zshrc: createMockTrackedFile({
          source: '~/.zshrc',
          destination: '../../evil',
        }),
      },
    });

    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    clearManifestCache();

    const report = await runDoctorChecks({ category: 'manifest' });

    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'manifest.path-safety',
          status: 'fail',
        }),
      ])
    );
  });

  it('returns strict warning exit code when warnings are present without failures', async () => {
    await initTestTuck({
      config: {
        security: {
          scanSecrets: false,
        },
      },
    });

    const report = await runDoctorChecks({ category: 'security' });

    expect(report.summary.failed).toBe(0);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(getDoctorExitCode(report, true)).toBe(2);
  });
});
