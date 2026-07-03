/**
 * `tuck encryption encrypt-file` / `decrypt-file` non-interactive behavior.
 *
 * Regressions covered:
 *  - JSON mode must honor TUCK_PASSWORD (the old code threw "Password required"
 *    before ever reading the env var it told the user to set).
 *  - `--no-keep` must be a real, accepted flag that actually removes the
 *    plaintext (it used to hard-error as an unknown option and was a no-op).
 *  - The passphrase is never accepted on argv (no `--password` flag).
 *
 * The subcommands are driven directly (not through the parent) so their own
 * `--json` binds — the root program otherwise sets JSON mode via a global hook.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import type { Command } from 'commander';
import { TEST_HOME } from '../setup.js';

const INPUT = `${TEST_HOME}/.npmrc`;
const PLAINTEXT = '//registry.npmjs.org/:_authToken=deadbeef\n';

const getSub = async (name: string): Promise<Command> => {
  const { encryptionCommand } = await import('../../src/commands/encryption.js');
  const sub = encryptionCommand.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`subcommand ${name} not found`);
  return sub;
};

describe('encryption encrypt-file / decrypt-file (non-interactive)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.writeFileSync(INPUT, PLAINTEXT);
    process.env.TUCK_PASSWORD = 'file-pass';
  });

  afterEach(() => {
    delete process.env.TUCK_PASSWORD;
  });

  it('encrypts in JSON mode using TUCK_PASSWORD (does not demand --password)', async () => {
    const encryptFile = await getSub('encrypt-file');

    await encryptFile.parseAsync([INPUT, '--json'], { from: 'user' });

    const enc = vol.readFileSync(`${INPUT}.enc`) as Buffer;
    expect(enc.subarray(0, 5).toString('ascii')).toBe('TCKE2');
    // Plaintext preserved by default.
    expect(vol.existsSync(INPUT)).toBe(true);
  });

  it('removes the plaintext with --no-keep (flag accepted, deletion implemented)', async () => {
    const encryptFile = await getSub('encrypt-file');

    await encryptFile.parseAsync([INPUT, '--no-keep', '--json'], { from: 'user' });

    expect(vol.existsSync(`${INPUT}.enc`)).toBe(true);
    expect(vol.existsSync(INPUT)).toBe(false);
  });

  it('rejects encrypt-file in JSON mode when no password is available', async () => {
    delete process.env.TUCK_PASSWORD;
    const encryptFile = await getSub('encrypt-file');

    await expect(
      encryptFile.parseAsync([INPUT, '--json'], { from: 'user' })
    ).rejects.toMatchObject({ code: 'ENCRYPTION_ERROR' });
  });

  it('round-trips encrypt-file -> decrypt-file via TUCK_PASSWORD', async () => {
    const encryptFile = await getSub('encrypt-file');
    const decryptFile = await getSub('decrypt-file');

    await encryptFile.parseAsync([INPUT, '--json'], { from: 'user' });
    await decryptFile.parseAsync([`${INPUT}.enc`, '--out', `${INPUT}.restored`, '--json'], {
      from: 'user',
    });

    expect((vol.readFileSync(`${INPUT}.restored`) as Buffer).toString('utf-8')).toBe(PLAINTEXT);
  });

  it('does not expose a --password flag on encrypt-file or decrypt-file', async () => {
    const encryptFile = await getSub('encrypt-file');
    const decryptFile = await getSub('decrypt-file');
    expect(encryptFile.options.map((o) => o.long)).not.toContain('--password');
    expect(decryptFile.options.map((o) => o.long)).not.toContain('--password');
  });
});
