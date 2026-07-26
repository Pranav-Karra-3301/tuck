import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { ensureBuilt } from './helpers/build.js';
import {
  runCli,
  makeHome,
  cleanupHome,
  seedHomeFile,
  homePath,
  fileExists,
  readHomeFile,
  parseEnvelope,
} from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

// Resolve git availability once (top-level await) so the sync/commit-dependent
// cases register as genuinely SKIPPED — not silently PASSED — when git is absent.
const gitAvailable = await hasGit();

/**
 * Profiles / tags end-to-end against the REAL built binary:
 *   - `tuck add --tag` records tags in the shared manifest;
 *   - `tuck apply --profile P` materializes ONLY the universal + P-tagged subset;
 *   - `tuck profile bind` makes `apply` (with no --profile) use that subset;
 *   - `tuck profile devcontainer` scaffolds the ephemeral-env bootstrap files.
 */
describe('e2e: profiles / tags', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  it.skipIf(!gitAvailable)('applies only the universal + profile-tagged subset', async () => {
    const src = await makeHome();
    homes.push(src);
    const env = { ...gitIdentityEnv() };

    // Three files: one universal, one work-only, one agent-only.
    await seedHomeFile(src, '.zshrc', 'export EDITOR=vim\n'); // universal
    await seedHomeFile(src, '.work-gitconfig', '[user]\n  email = me@work\n'); // work
    await seedHomeFile(src, '.agentrc', 'AGENT=1\n'); // agent

    await runCli(['init', '--bare', '--json'], { home: src, env });
    await runCli(['add', join(src, '.zshrc'), '--json', '--yes'], { home: src, env });
    await runCli(['add', join(src, '.work-gitconfig'), '--tag', 'work', '--json', '--yes'], {
      home: src,
      env,
    });
    await runCli(['add', join(src, '.agentrc'), '--tag', 'agent', '--json', '--yes'], {
      home: src,
      env,
    });
    await runCli(['sync', '--json', '--no-push'], { home: src, env });

    // profile list reports the two profiles + their counts.
    const list = await runCli(['profile', 'list', '--json'], { home: src, env });
    const listData = parseEnvelope(list.stdout).data as {
      profiles: Array<{ name: string; fileCount: number }>;
      universal: number;
    };
    expect(listData.universal).toBe(1);
    const names = listData.profiles.map((p) => p.name).sort();
    expect(names).toEqual(['agent', 'work']);

    // Apply the WORK profile onto a clean machine: universal + work only.
    const workDst = await makeHome();
    homes.push(workDst);
    const repoDir = homePath(src, '.tuck');
    const applyWork = await runCli(
      ['apply', repoDir, '--profile', 'work', '--json', '--force'],
      { home: workDst, env }
    );
    expect(applyWork.code).toBe(0);
    expect(parseEnvelope(applyWork.stdout)).toMatchObject({ ok: true, data: { profile: 'work' } });

    expect(await fileExists(homePath(workDst, '.zshrc'))).toBe(true); // universal applied
    expect(await fileExists(homePath(workDst, '.work-gitconfig'))).toBe(true); // work applied
    expect(await fileExists(homePath(workDst, '.agentrc'))).toBe(false); // agent NOT applied

    // Apply the AGENT profile onto a different clean machine: universal + agent only.
    const agentDst = await makeHome();
    homes.push(agentDst);
    const applyAgent = await runCli(
      ['apply', repoDir, '--profile', 'agent', '--yes', '--json'],
      { home: agentDst, env }
    );
    expect(applyAgent.code).toBe(0);
    expect(await fileExists(homePath(agentDst, '.zshrc'))).toBe(true);
    expect(await fileExists(homePath(agentDst, '.agentrc'))).toBe(true);
    expect(await fileExists(homePath(agentDst, '.work-gitconfig'))).toBe(false);
  });

  it.skipIf(!gitAvailable)('binds a profile and applies it by default (no --profile flag)', async () => {
    const src = await makeHome();
    homes.push(src);
    const env = { ...gitIdentityEnv() };

    await seedHomeFile(src, '.zshrc', 'export EDITOR=vim\n');
    await seedHomeFile(src, '.work-gitconfig', '[user]\n  email = me@work\n');
    await runCli(['init', '--bare', '--json'], { home: src, env });
    await runCli(['add', join(src, '.zshrc'), '--json', '--yes'], { home: src, env });
    await runCli(['add', join(src, '.work-gitconfig'), '--tag', 'work', '--json', '--yes'], {
      home: src,
      env,
    });
    await runCli(['sync', '--json', '--no-push'], { home: src, env });

    const dst = await makeHome();
    homes.push(dst);

    // Bind THIS (dst) machine to "personal": work files must be excluded.
    const bind = await runCli(['profile', 'bind', 'work', '--json', '--force'], {
      home: dst,
      env,
    });
    expect(bind.code).toBe(0);
    expect(parseEnvelope(bind.stdout)).toMatchObject({ ok: true, data: { bound: 'work' } });

    // Apply with NO --profile: the binding drives selection.
    const apply = await runCli(['apply', homePath(src, '.tuck'), '--json', '--force'], {
      home: dst,
      env,
    });
    expect(parseEnvelope(apply.stdout)).toMatchObject({ ok: true, data: { profile: 'work' } });
    expect(await fileExists(homePath(dst, '.work-gitconfig'))).toBe(true);
    expect(await fileExists(homePath(dst, '.zshrc'))).toBe(true);
  });

  it('scaffolds the devcontainer + Codespaces bootstrap files', async () => {
    const home = await makeHome();
    homes.push(home);
    const out = join(home, 'project');

    const res = await runCli(['profile', 'devcontainer', out, '--json'], { home });
    expect(res.code).toBe(0);
    const data = parseEnvelope(res.stdout).data as { written: string[] };
    expect(data.written.length).toBe(2);

    expect(await fileExists(join(out, '.devcontainer', 'devcontainer.json'))).toBe(true);
    expect(await fileExists(join(out, 'install.sh'))).toBe(true);

    const devcontainer = await readHomeFile(home, 'project/.devcontainer/devcontainer.json');
    expect(devcontainer).toContain('--profile agent --yes');
    const install = await readHomeFile(home, 'project/install.sh');
    expect(install).toContain('--profile');
  });
});
