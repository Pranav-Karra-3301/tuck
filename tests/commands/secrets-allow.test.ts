/**
 * Integration tests for `tuck secrets allow`.
 *
 * These run against the global memfs sandbox with the REAL scanner, store, and
 * allowlist (no module mocks) so they prove the end-to-end contract: a finding
 * the scanner flags can be marked safe once, after which every scan honors the
 * committed allowlist — and removing the entry re-arms the finding.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, initTestTuck } from '../utils/testHelpers.js';
import { scanForSecrets } from '../../src/lib/secrets/index.js';
import {
  listAllowlistEntries,
  getAllowlistPath,
  computeFingerprint,
} from '../../src/lib/secrets/allowlist.js';

const AWS_LINE = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n';
const AWS_VALUE = 'AKIAIOSFODNN7EXAMPLE';
const CONFIG_PATH = join(TEST_HOME, '.config', 'app.conf');

describe('tuck secrets allow (integration)', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });
  afterEach(() => {
    vol.reset();
  });

  it('add --file marks a scanner finding safe and every later scan honors it', async () => {
    await initTestTuck();
    vol.mkdirSync(join(TEST_HOME, '.config'), { recursive: true });
    vol.writeFileSync(CONFIG_PATH, AWS_LINE);

    // Baseline: the scanner flags the AWS key.
    const before = await scanForSecrets([CONFIG_PATH], TEST_TUCK_DIR);
    expect(before.filesWithSecrets).toBe(1);
    expect(before.totalSecrets).toBeGreaterThanOrEqual(1);

    // Allowlist it non-interactively (no TTY in tests -> allowlists all findings).
    const { secretsCommand } = await import('../../src/commands/secrets.js');
    await secretsCommand.parseAsync(
      ['allow', 'add', '--file', CONFIG_PATH, '--reason', 'example key from AWS docs'],
      { from: 'user' }
    );

    // The committed allowlist now holds a fingerprint-only entry (never the value).
    const entries = await listAllowlistEntries(TEST_TUCK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].fingerprint).toBe(computeFingerprint(AWS_VALUE));
    expect(entries[0].reason).toBe('example key from AWS docs');
    const rawAllowlist = vol.readFileSync(getAllowlistPath(TEST_TUCK_DIR), 'utf-8') as string;
    expect(rawAllowlist).not.toContain(AWS_VALUE);

    // Subsequent scans skip the allowlisted finding.
    const after = await scanForSecrets([CONFIG_PATH], TEST_TUCK_DIR);
    expect(after.filesWithSecrets).toBe(0);
    expect(after.totalSecrets).toBe(0);
  });

  it('remove re-arms the finding', async () => {
    await initTestTuck();
    vol.mkdirSync(join(TEST_HOME, '.config'), { recursive: true });
    vol.writeFileSync(CONFIG_PATH, AWS_LINE);

    const { secretsCommand } = await import('../../src/commands/secrets.js');
    await secretsCommand.parseAsync(
      ['allow', 'add', '--file', CONFIG_PATH, '--reason', 'docs example'],
      { from: 'user' }
    );
    expect((await scanForSecrets([CONFIG_PATH], TEST_TUCK_DIR)).filesWithSecrets).toBe(0);

    const fingerprint = computeFingerprint(AWS_VALUE);
    await secretsCommand.parseAsync(['allow', 'remove', fingerprint.slice(0, 12)], {
      from: 'user',
    });

    expect(await listAllowlistEntries(TEST_TUCK_DIR)).toHaveLength(0);
    expect((await scanForSecrets([CONFIG_PATH], TEST_TUCK_DIR)).filesWithSecrets).toBe(1);
  });

  it('add --file --pattern only allowlists the matching pattern', async () => {
    await initTestTuck();
    vol.mkdirSync(join(TEST_HOME, '.config'), { recursive: true });
    vol.writeFileSync(CONFIG_PATH, AWS_LINE);

    const { secretsCommand } = await import('../../src/commands/secrets.js');
    // A pattern id that does not match the AWS finding -> nothing allowlisted.
    await secretsCommand.parseAsync(
      ['allow', 'add', '--file', CONFIG_PATH, '--pattern', 'no-such-pattern', '--reason', 'x'],
      { from: 'user' }
    );
    expect(await listAllowlistEntries(TEST_TUCK_DIR)).toHaveLength(0);
    expect((await scanForSecrets([CONFIG_PATH], TEST_TUCK_DIR)).filesWithSecrets).toBe(1);
  });
});
