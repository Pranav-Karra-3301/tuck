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
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
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

  it('uses OS-level home resolution when HOME and USERPROFILE are unset', async () => {
    await initTestTuck();
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    const report = await runDoctorChecks({ category: 'env' });
    const homeCheck = report.checks.find((check) => check.id === 'env.home-directory');

    expect(homeCheck?.status).toBe('pass');
  });

  it('fails when tuck path exists but is not a directory', async () => {
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.writeFileSync(TEST_TUCK_DIR, 'conflicting file');

    const report = await runDoctorChecks();
    const tuckDirCheck = report.checks.find((check) => check.id === 'repo.tuck-directory');

    expect(tuckDirCheck?.status).toBe('fail');
    expect(tuckDirCheck?.message).toContain('not a directory');
  });
});
