/**
 * Tests for store-seeded placeholder reuse in `processSecretsForRedaction`.
 *
 * Uses the global memfs mock (tests/setup.ts) so store writes land in the
 * in-memory volume rooted at TEST_HOME.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir } from 'fs/promises';
import { processSecretsForRedaction } from '../../../src/lib/secrets/index.js';
import { getAllSecrets } from '../../../src/lib/secrets/store.js';
import type { FileScanResult, SecretMatch } from '../../../src/lib/secrets/scanner.js';
import { TEST_TUCK_DIR } from '../../setup.js';

beforeEach(async () => {
  await mkdir(TEST_TUCK_DIR, { recursive: true });
});

const makeMatch = (value: string, placeholder: string): SecretMatch => ({
  patternId: 'generic-api-key',
  patternName: 'Generic API Key',
  severity: 'high',
  value,
  redactedValue: '***',
  line: 1,
  column: 1,
  context: '',
  placeholder,
  start: 0,
  end: value.length,
  offsetsExact: true,
});

const makeResult = (
  path: string,
  matches: SecretMatch[]
): FileScanResult => ({
  path,
  collapsedPath: path,
  hasSecrets: matches.length > 0,
  matches,
  criticalCount: 0,
  highCount: matches.length,
  mediumCount: 0,
  lowCount: 0,
  skipped: false,
});

describe('processSecretsForRedaction store-seeded reuse', () => {
  it('re-processing the same value reuses the stored placeholder (idempotent)', async () => {
    const tuckDir = TEST_TUCK_DIR;
    const livePath = '/test-home/.zshrc';
    const value = 'secret_example_e3878cb6494b410eabc3e16d15a99b08';
    const results = [makeResult(livePath, [makeMatch(value, 'LAMBDA_API_KEY')])];

    const first = await processSecretsForRedaction(results, tuckDir); // stores LAMBDA_API_KEY
    const second = await processSecretsForRedaction(results, tuckDir); // must NOT mint LAMBDA_API_KEY_1

    expect([...second.get(livePath)!.values()]).toEqual([...first.get(livePath)!.values()]);
    expect([...second.get(livePath)!.values()]).toEqual(['LAMBDA_API_KEY']);

    // Store still holds exactly one placeholder, no orphaned _1 entry.
    const stored = await getAllSecrets(tuckDir);
    expect(Object.keys(stored)).toEqual(['LAMBDA_API_KEY']);
  });

  it('two different values under the same identifier still get a _1 suffix', async () => {
    const tuckDir = TEST_TUCK_DIR;
    const results = [
      makeResult('/test-home/a', [makeMatch('valueAAAAAAAAAAAAAAAA', 'API_KEY')]),
      makeResult('/test-home/b', [makeMatch('valueBBBBBBBBBBBBBBBB', 'API_KEY')]),
    ];

    const plan = await processSecretsForRedaction(results, tuckDir);
    expect(plan.get('/test-home/a')!.get('valueAAAAAAAAAAAAAAAA')).toBe('API_KEY');
    expect(plan.get('/test-home/b')!.get('valueBBBBBBBBBBBBBBBB')).toBe('API_KEY_1');
  });

  it('reuses the stored name even when the scanner now derives a different placeholder', async () => {
    const tuckDir = TEST_TUCK_DIR;
    const value = 'stable_value_1234567890abcdef';

    // First scan stored the value under OLD_NAME.
    await processSecretsForRedaction(
      [makeResult('/test-home/a', [makeMatch(value, 'OLD_NAME')])],
      tuckDir
    );

    // Later scan derives a nicer identifier-based name, but the committed repo
    // placeholder must win for stability.
    const plan = await processSecretsForRedaction(
      [makeResult('/test-home/a', [makeMatch(value, 'NEW_NAME')])],
      tuckDir
    );
    expect(plan.get('/test-home/a')!.get(value)).toBe('OLD_NAME');
  });
});
