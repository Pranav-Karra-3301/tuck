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

  it('passes manifest path-safety for a valid repo-scoped entry (not home-confined)', async () => {
    await initTestTuck();

    // A legitimately repo-scoped entry: source is a `<repoKey>:<repoRelative>`
    // KEY, and the file lives under a repo root that may be OUTSIDE $HOME. The
    // old check fed the key to validateSafeSourcePath (home-confinement), which
    // FAILed valid manifests depending on the invoker's cwd.
    const manifest = createMockManifest({
      files: {
        eslint: createMockTrackedFile({
          source: 'myrepo-a1b2c3d4:src/index.ts',
          destination: 'files/repos/myrepo-a1b2c3d4/src/index.ts',
          scope: 'repo',
          repoKey: 'myrepo-a1b2c3d4',
          repoRelative: 'src/index.ts',
        }),
      },
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    clearManifestCache();

    const report = await runDoctorChecks({ category: 'manifest' });
    const check = report.checks.find((item) => item.id === 'manifest.path-safety');

    expect(check?.status).toBe('pass');
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

  it('fails when legacy runtime artifacts still live under the tuck repo', async () => {
    await initTestTuck();
    vol.mkdirSync(join(TEST_TUCK_DIR, 'backups'), { recursive: true });
    vol.writeFileSync(join(TEST_TUCK_DIR, 'audit.log'), 'legacy');

    const report = await runDoctorChecks({ category: 'security' });
    const check = report.checks.find((item) => item.id === 'security.repo-runtime-state');

    expect(check?.status).toBe('fail');
    expect(check?.details).toContain('~/.tuck/backups');
    expect(check?.details).toContain('~/.tuck/audit.log');
  });

  it('warns when local secrets backend is configured explicitly', async () => {
    await initTestTuck({
      config: {
        security: {
          secretBackend: 'local',
        },
      },
    });

    const report = await runDoctorChecks({ category: 'security' });
    const check = report.checks.find((item) => item.id === 'security.local-secrets');

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('Local secrets backend');
  });

  it('fails when reserved unsupported config keys are in use', async () => {
    await initTestTuck({
      config: {
        encryption: {
          enabled: true,
        },
      },
    });

    const report = await runDoctorChecks({ category: 'security' });
    const check = report.checks.find((item) => item.id === 'security.unsupported-config');

    expect(check?.status).toBe('fail');
    expect(check?.details).toContain('encryption.enabled');
  });

  it('passes when templates.variables is set because templating has shipped', async () => {
    await initTestTuck({
      config: {
        templates: {
          enabled: true,
          variables: {
            MACHINE: 'devbox',
          },
        },
      },
    });

    const report = await runDoctorChecks({ category: 'security' });
    const check = report.checks.find((item) => item.id === 'security.unsupported-config');

    // templates.enabled / templates.variables are wired (rendered on
    // apply/restore), so they must NOT trip the unsupported-config health gate.
    expect(check?.status).toBe('pass');
    expect(check?.details ?? '').not.toContain('templates');
  });
});
