import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:process';
import { ensureBuilt } from './helpers/build.js';
import { runCli, makeHome, cleanupHome, seedHomeFile, readHomeFile, homePath } from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

/**
 * Case (c1): exercises the P0-1 templating feature through the REAL binary —
 * `add --template` stores the source verbatim (NOT rendered at storage time),
 * and `apply` renders `{{os}}` to the runner's platform on the way to disk.
 */
describe('e2e: template round-trip (add --template → apply renders {{os}})', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  it('stores the template verbatim and renders {{os}} on apply', async () => {
    if (!(await hasGit())) return;
    const src = await makeHome();
    homes.push(src);
    const env = { ...gitIdentityEnv() };

    await seedHomeFile(src, '.config/tuck-demo/os.txt', 'platform={{os}}\n');

    await runCli(['init', '--bare', '--json'], { home: src, env });
    const add = await runCli(
      ['add', join(src, '.config/tuck-demo/os.txt'), '--template', '--json', '--yes'],
      { home: src, env }
    );
    expect(add.code).toBe(0);

    // Stored VERBATIM — locate the repo copy via the manifest (robust to category detection).
    const manifest = JSON.parse(await readFile(homePath(src, '.tuck/.tuckmanifest.json'), 'utf-8')) as {
      files: Record<string, { destination: string; template: boolean }>;
    };
    const entry = Object.values(manifest.files)[0];
    expect(entry.template).toBe(true);
    const repoCopy = await readFile(homePath(src, join('.tuck', entry.destination)), 'utf-8');
    expect(repoCopy).toContain('{{os}}'); // proves storage-time is NOT rendered

    await runCli(['sync', '--json', '--no-push'], { home: src, env });

    // Apply into a clean home → the token renders to the runner's platform.
    const dst = await makeHome();
    homes.push(dst);
    const apply = await runCli(['apply', homePath(src, '.tuck'), '--json', '--force'], { home: dst, env });
    expect(apply.code).toBe(0);

    const rendered = await readHomeFile(dst, '.config/tuck-demo/os.txt');
    expect(rendered).toBe(`platform=${platform}\n`); // {{os}} → darwin | linux | win32
    expect(rendered).not.toContain('{{os}}');
  });
});
