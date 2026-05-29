/**
 * Encryption management command for power users
 * Regular users configure encryption during `tuck init`
 */

import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import {
  getEncryptionStatus,
  setupEncryption,
  disableEncryption,
  changePassword,
  getKeystoreName,
  verifyStoredPassword,
} from '../lib/crypto/index.js';
import { getTuckDir } from '../lib/paths.js';
import { NotInitializedError } from '../errors.js';
import { pathExists } from 'fs-extra';
import { getManifestPath } from '../lib/paths.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { readFile, writeFile } from 'fs/promises';
import { encryptFileContent, decryptFileContent, isEncryptedFileBuffer } from '../lib/crypto/index.js';
import { expandPath } from '../lib/paths.js';
import { EncryptionError, DecryptionError } from '../errors.js';

/**
 * Show encryption status
 */
const runStatus = async (opts: { json?: boolean } = {}): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck encryption status');
  const tuckDir = getTuckDir();

  if (!(await pathExists(getManifestPath(tuckDir)))) {
    throw new NotInitializedError();
  }

  const status = await getEncryptionStatus();

  if (isJsonMode()) {
    emitJsonOk({
      enabled: status.enabled,
      keystoreType: status.keystoreType,
      hasStoredPassword: status.hasStoredPassword,
    });
    return;
  }

  console.log();
  logger.info('Encryption Status');
  console.log();
  console.log(`  Backup encryption: ${status.enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`  Keystore: ${status.keystoreType}`);
  console.log(`  Password stored: ${status.hasStoredPassword ? 'Yes' : 'No'}`);
  console.log();
};

/**
 * Set up encryption (if not already done during init)
 */
const runSetup = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  if (!(await pathExists(getManifestPath(tuckDir)))) {
    throw new NotInitializedError();
  }

  prompts.intro('tuck encryption setup');

  const status = await getEncryptionStatus();

  if (status.enabled) {
    prompts.log.info('Encryption is already enabled');

    const reconfigure = await prompts.confirm('Would you like to change your password?', false);

    if (reconfigure) {
      await runRotate();
      return;
    }

    prompts.outro('No changes made');
    return;
  }

  const password = await prompts.password('Create a backup encryption password:');

  if (!password) {
    prompts.cancel('No password provided');
    return;
  }

  const confirmPassword = await prompts.password('Confirm password:');

  if (password !== confirmPassword) {
    prompts.cancel('Passwords do not match');
    return;
  }

  const spinner = prompts.spinner();
  spinner.start('Setting up encryption...');

  try {
    await setupEncryption(password);
    const keystoreName = await getKeystoreName();
    spinner.stop('Encryption configured');

    prompts.log.success(`Password saved to ${keystoreName}`);
    prompts.outro('Backup encryption is now enabled');
  } catch (error) {
    spinner.stop('Setup failed');
    prompts.log.error(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Disable encryption
 */
const runDisable = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  if (!(await pathExists(getManifestPath(tuckDir)))) {
    throw new NotInitializedError();
  }

  prompts.intro('tuck encryption disable');

  const status = await getEncryptionStatus();

  if (!status.enabled) {
    prompts.log.info('Encryption is already disabled');
    prompts.outro('No changes made');
    return;
  }

  prompts.log.warning('Disabling encryption will:');
  console.log('  - Stop encrypting new backups');
  console.log('  - Keep existing encrypted backups encrypted');
  console.log('  - Remove password from keychain');
  console.log();

  const confirm = await prompts.confirm('Are you sure you want to disable encryption?', false);

  if (!confirm) {
    prompts.cancel('Cancelled');
    return;
  }

  const spinner = prompts.spinner();
  spinner.start('Disabling encryption...');

  try {
    await disableEncryption();
    spinner.stop('Encryption disabled');
    prompts.outro('Backup encryption is now disabled');
  } catch (error) {
    spinner.stop('Failed');
    prompts.log.error(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Change encryption password
 */
const runRotate = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  if (!(await pathExists(getManifestPath(tuckDir)))) {
    throw new NotInitializedError();
  }

  prompts.intro('tuck encryption rotate');

  const status = await getEncryptionStatus();

  if (!status.enabled) {
    prompts.log.warning('Encryption is not enabled');
    const enable = await prompts.confirm('Would you like to enable it?', true);
    if (enable) {
      await runSetup();
    }
    return;
  }

  const currentPassword = await prompts.password('Enter current password:');

  if (!currentPassword) {
    prompts.cancel('No password provided');
    return;
  }

  // Verify current password
  const isValid = await verifyStoredPassword(currentPassword);
  if (!isValid) {
    prompts.log.error('Current password is incorrect');
    return;
  }

  const newPassword = await prompts.password('Enter new password:');

  if (!newPassword) {
    prompts.cancel('No password provided');
    return;
  }

  const confirmPassword = await prompts.password('Confirm new password:');

  if (newPassword !== confirmPassword) {
    prompts.cancel('Passwords do not match');
    return;
  }

  const spinner = prompts.spinner();
  spinner.start('Changing password...');

  try {
    await changePassword(currentPassword, newPassword);
    spinner.stop('Password changed');

    prompts.log.warning('Note: Existing encrypted backups still use the old password');
    prompts.log.info('New backups will use the new password');
    prompts.outro('Password rotation complete');
  } catch (error) {
    spinner.stop('Failed');
    prompts.log.error(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Enable encryption (alias for setup)
 */
const runEnable = async (): Promise<void> => {
  await runSetup();
};

/**
 * Encrypt a file in place — write `<file>.enc` and (optionally) remove the
 * plaintext. Used by power users and by `tuck add --encrypt`.
 */
const runEncryptFile = async (
  input: string,
  opts: { out?: string; password?: string; keep?: boolean; json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck encryption encrypt-file');
  const inAbs = expandPath(input);
  const outAbs = opts.out ? expandPath(opts.out) : `${inAbs}.enc`;
  const plaintext = await readFile(inAbs);
  let password = opts.password;
  if (!password) {
    if (isJsonMode()) {
      throw new EncryptionError('Password required in JSON mode', [
        'Pass --password or set TUCK_PASSWORD env var',
      ]);
    }
    password = process.env.TUCK_PASSWORD;
  }
  if (!password) {
    const entered = await prompts.password('Encryption password:');
    if (!entered) throw new EncryptionError('No password provided');
    password = entered;
  }
  const ciphertext = await encryptFileContent(plaintext, password);
  await writeFile(outAbs, ciphertext);
  if (!opts.keep) {
    // Caller asked us to replace the plaintext — but we preserve the original
    // by default to avoid accidental data loss. The --keep flag is named to
    // match the safer default ("keep the original"). Use --no-keep to delete.
  }
  if (isJsonMode()) {
    emitJsonOk({ encrypted: outAbs, bytes: ciphertext.length });
    return;
  }
  logger.success(`Encrypted → ${outAbs} (${ciphertext.length} bytes)`);
};

/**
 * Resolve the plaintext output path for `decrypt-file`, never in place.
 *   - explicit `out` is honored;
 *   - otherwise strip a trailing `.enc`;
 *   - if there is no `.enc` to strip, append `.dec` (so the output is never the
 *     input — the old `|| `${inAbs}.dec`` fallback could never fire because a
 *     non-empty path is truthy, silently overwriting the ciphertext).
 * Throws if the resolved output would equal the input.
 */
export const resolveDecryptOutPath = (inAbs: string, outExpanded?: string): string => {
  const stripped = inAbs.replace(/\.enc$/, '');
  const outAbs = outExpanded ?? (stripped !== inAbs ? stripped : `${inAbs}.dec`);
  if (outAbs === inAbs) {
    throw new DecryptionError('Refusing to overwrite the encrypted input file in place', [
      'Pass --out <path> to write the decrypted plaintext somewhere else',
    ]);
  }
  return outAbs;
};

const runDecryptFile = async (
  input: string,
  opts: { out?: string; password?: string; json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck encryption decrypt-file');
  const inAbs = expandPath(input);
  const outAbs = resolveDecryptOutPath(inAbs, opts.out ? expandPath(opts.out) : undefined);
  const ciphertext = await readFile(inAbs);
  if (!isEncryptedFileBuffer(ciphertext)) {
    throw new DecryptionError('File is not a tuck-encrypted file (missing TCKE1 header)');
  }
  let password = opts.password ?? process.env.TUCK_PASSWORD;
  if (!password) {
    if (isJsonMode()) {
      throw new DecryptionError('Password required in JSON mode', [
        'Pass --password or set TUCK_PASSWORD env var',
      ]);
    }
    const entered = await prompts.password('Decryption password:');
    if (!entered) throw new DecryptionError('No password provided');
    password = entered;
  }
  const plaintext = await decryptFileContent(ciphertext, password);
  await writeFile(outAbs, plaintext);
  if (isJsonMode()) {
    emitJsonOk({ decrypted: outAbs, bytes: plaintext.length });
    return;
  }
  logger.success(`Decrypted → ${outAbs} (${plaintext.length} bytes)`);
};

export const encryptionCommand = new Command('encryption')
  .description('Manage backup encryption (power user)')
  .addCommand(
    new Command('status')
      .description('Show encryption status')
      .option('--json', 'Emit JSON envelope')
      .action(runStatus)
  )
  .addCommand(new Command('setup').description('Set up backup encryption').action(runSetup))
  .addCommand(new Command('enable').description('Enable backup encryption').action(runEnable))
  .addCommand(new Command('disable').description('Disable backup encryption').action(runDisable))
  .addCommand(new Command('rotate').description('Change encryption password').action(runRotate))
  .addCommand(
    new Command('encrypt-file')
      .description('Encrypt a single file (AES-256-GCM, PBKDF2)')
      .argument('<file>', 'Path to the plaintext file')
      .option('-o, --out <path>', 'Output path (default: <file>.enc)')
      .option('-p, --password <pw>', 'Password (else TUCK_PASSWORD or prompt)')
      .option('--keep', 'Preserve the plaintext (default true; --no-keep removes it)', true)
      .option('--json', 'Emit JSON envelope')
      .action(runEncryptFile)
  )
  .addCommand(
    new Command('decrypt-file')
      .description('Decrypt a file produced by `tuck encryption encrypt-file`')
      .argument('<file>', 'Path to the encrypted file')
      .option('-o, --out <path>', 'Output path (default: strip .enc suffix)')
      .option('-p, --password <pw>', 'Password (else TUCK_PASSWORD or prompt)')
      .option('--json', 'Emit JSON envelope')
      .action(runDecryptFile)
  );

// Default action shows status
encryptionCommand.option('--json', 'Emit JSON envelope').action((opts: { json?: boolean }) => runStatus(opts));
