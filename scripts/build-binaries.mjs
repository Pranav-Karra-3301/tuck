#!/usr/bin/env node
/**
 * Cross-platform single-binary builder via `bun build --compile`.
 *
 * Produces `dist/bin/tuck-<os>-<arch>` for the platforms in TARGETS. Bun's
 * compile target uses its own naming scheme (darwin-arm64, linux-x64, etc.) —
 * we translate them to a tuck-stable naming so the install scripts can fetch
 * by predictable name.
 *
 * Requires bun ≥ 1.1 to be installed. Run:
 *   pnpm build:bin:all
 *
 * Why a script and not a `tsup` plugin? `bun build --compile` is its own
 * pipeline and doesn't play with tsup's esbuild. Keeping this as a thin
 * orchestrator means we don't lock the rest of the build to bun.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(repoRoot, 'dist', 'bin');
mkdirSync(outDir, { recursive: true });

const TARGETS = [
  { bun: 'bun-darwin-arm64', name: 'tuck-darwin-arm64' },
  { bun: 'bun-darwin-x64', name: 'tuck-darwin-x64' },
  { bun: 'bun-linux-x64', name: 'tuck-linux-x64' },
  { bun: 'bun-linux-arm64', name: 'tuck-linux-arm64' },
  { bun: 'bun-windows-x64', name: 'tuck-windows-x64.exe' },
];

const hasBun = spawnSync('bun', ['--version'], { stdio: 'pipe' }).status === 0;
if (!hasBun) {
  console.error('error: bun is required to build single-file binaries.');
  console.error('Install: curl -fsSL https://bun.sh/install | bash');
  process.exit(1);
}

let anyFailure = false;
for (const target of TARGETS) {
  const out = join(outDir, target.name);
  if (existsSync(out)) {
    console.log(`✓ ${target.name} already exists, skipping`);
    continue;
  }
  console.log(`→ Building ${target.name}…`);
  const result = spawnSync(
    'bun',
    [
      'build',
      '--compile',
      '--minify',
      '--sourcemap',
      `--target=${target.bun}`,
      './src/index.ts',
      `--outfile=${out}`,
    ],
    { stdio: 'inherit', cwd: repoRoot }
  );
  if (result.status !== 0) {
    console.error(`✗ ${target.name} failed`);
    anyFailure = true;
  } else {
    console.log(`✓ ${target.name}`);
  }
}

if (anyFailure) process.exit(2);
console.log(`\nDone. Binaries written to ${outDir}.`);
