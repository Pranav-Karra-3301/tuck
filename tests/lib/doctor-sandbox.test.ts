/**
 * Doctor sandboxing/security recipe checks.
 *
 * `tuck doctor` surfaces OS-level wrapper recipes (sandbox-exec, bubblewrap,
 * landlock, container) and confirms that `--root` write-confinement is available
 * — the operator-facing half of the sandboxed-preview story (audit §3.3). These
 * checks must always run (they are advisory, never machine-state dependent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { runDoctorChecks, DOCTOR_CATEGORIES } from '../../src/lib/doctor.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';
import { resetWriteContext, setWriteContext } from '../../src/lib/writeContext.js';

describe('doctor sandboxing recipes', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    resetWriteContext();
    vol.mkdirSync('/test-home', { recursive: true });
  });

  afterEach(() => {
    resetWriteContext();
    vol.reset();
  });

  it('exposes a sandboxing category', () => {
    expect(DOCTOR_CATEGORIES).toContain('sandboxing');
  });

  it('includes OS-level wrapper recipes (sandbox-exec, bwrap, landlock, container)', async () => {
    const report = await runDoctorChecks({ category: 'sandboxing' });

    const recipeCheck = report.checks.find((c) => c.id === 'sandboxing.os-wrappers');
    expect(recipeCheck).toBeTruthy();

    // The recipe text is carried in details so an agent/operator can copy it.
    const text = `${recipeCheck!.message} ${recipeCheck!.details ?? ''} ${recipeCheck!.fix ?? ''}`;
    expect(text).toMatch(/sandbox-exec/i);
    expect(text).toMatch(/bwrap|bubblewrap/i);
    expect(text).toMatch(/landlock/i);
    expect(text).toMatch(/docker|container/i);
  });

  it('reports --root confinement availability', async () => {
    const report = await runDoctorChecks({ category: 'sandboxing' });
    const rootCheck = report.checks.find((c) => c.id === 'sandboxing.root-confinement');
    expect(rootCheck).toBeTruthy();
    // Without an active sandbox it is available-but-inactive (advisory).
    expect(rootCheck!.status).toBe('pass');
    expect(`${rootCheck!.message} ${rootCheck!.details ?? ''}`).toMatch(/--root/);
  });

  it('notes when --root confinement is actively engaged', async () => {
    setWriteContext({ root: '/test-home/sandbox', isSandbox: true });
    const report = await runDoctorChecks({ category: 'sandboxing' });
    const rootCheck = report.checks.find((c) => c.id === 'sandboxing.root-confinement');
    expect(rootCheck).toBeTruthy();
    expect(`${rootCheck!.message} ${rootCheck!.details ?? ''}`).toMatch(/sandbox/i);
  });
});
