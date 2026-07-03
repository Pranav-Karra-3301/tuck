/**
 * Regression tests for `smartMerge` banner idempotency (batch r2-merge-template).
 *
 * The "LOCAL CUSTOMIZATIONS (preserved by tuck)" banner line contains the
 * substring `# LOCAL`, which was itself in PRESERVE_MARKERS. On the next merge
 * the banner self-matched as a preserve marker, so every `tuck apply`/`tuck
 * pull` on a shell file with any preserved block re-appended the banner and grew
 * the file without bound. These tests pin that repeated merges converge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { smartMerge, findPreservedBlocks } from '../../src/lib/merge.js';
import { TEST_HOME } from '../setup.js';

describe('smartMerge banner idempotency', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  const incoming = 'export EDITOR=vim\nalias ll="ls -la"\n';
  const localWithBlock = [
    'export EDITOR=vim',
    '',
    '# tuck:preserve',
    'export MACHINE_TOKEN=local-only',
    '',
  ].join('\n');

  it('should not duplicate the preserved banner when applied repeatedly', async () => {
    const filePath = join(TEST_HOME, '.zshrc');
    await writeFile(filePath, localWithBlock, 'utf-8');

    // First merge writes the banner + preserved block back to the live file.
    const first = await smartMerge(filePath, incoming);
    expect(first.preservedBlocks).toBe(1);
    await writeFile(filePath, first.content, 'utf-8');

    // Second merge reads the merged file back — this is the production feedback
    // loop (apply.ts writes smartMerge output to the live file, which becomes
    // the next apply's local content).
    const second = await smartMerge(filePath, incoming);
    expect(second.preservedBlocks).toBe(1);
    await writeFile(filePath, second.content, 'utf-8');

    const third = await smartMerge(filePath, incoming);
    expect(third.preservedBlocks).toBe(1);

    // Output must converge: second and third merges are byte-identical.
    expect(third.content).toBe(second.content);

    // Exactly one banner title survives, never a growing pile.
    const bannerCount = (third.content.match(/LOCAL CUSTOMIZATIONS \(preserved by tuck\)/g) ?? [])
      .length;
    expect(bannerCount).toBe(1);

    // The user's real customization is still present exactly once.
    const tokenCount = (third.content.match(/MACHINE_TOKEN=local-only/g) ?? []).length;
    expect(tokenCount).toBe(1);
  });

  it('should not start a preserved block from a marker word mentioned mid-line', () => {
    // Anchored (startsWith) matching: an ordinary comment/command that merely
    // mentions a marker word mid-line must not be treated as a block start.
    const blocks = findPreservedBlocks('echo "# keep this in sync with prod"\nexport A=1\n');
    expect(blocks).toHaveLength(0);

    // Sanity: a real marker line at the start of a line is still detected.
    const real = findPreservedBlocks('# tuck:preserve\nexport FOO=bar\n');
    expect(real.length).toBeGreaterThanOrEqual(1);
  });
});
