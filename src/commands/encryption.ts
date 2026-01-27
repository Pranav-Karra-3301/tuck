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

/**
 * Show encryption status
 */
const runStatus = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  if (!(await pathExists(getManifestPath(tuckDir)))) {
    throw new NotInitializedError();
  }

  const status = await getEncryptionStatus();

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

export const encryptionCommand = new Command('encryption')
  .description('Manage backup encryption (power user)')
  .addCommand(new Command('status').description('Show encryption status').action(runStatus))
  .addCommand(new Command('setup').description('Set up backup encryption').action(runSetup))
  .addCommand(new Command('enable').description('Enable backup encryption').action(runEnable))
  .addCommand(new Command('disable').description('Disable backup encryption').action(runDisable))
  .addCommand(new Command('rotate').description('Change encryption password').action(runRotate));

// Default action shows status
encryptionCommand.action(runStatus);
