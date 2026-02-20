import { basename } from 'path';
import { colors as c, logger, prompts } from '../ui/index.js';
import {
  collapsePath,
  detectCategory,
  getDestinationPathFromSource,
  expandPath,
  isDirectory,
  pathExists,
  sanitizeFilename,
  validateSafeSourcePath,
} from './paths.js';
import { isFileTracked } from './manifest.js';
import { checkFileSizeThreshold, formatFileSize, getDirectoryFileCount } from './files.js';
import { shouldExcludeFromBin } from './binary.js';
import { addToTuckignore, isIgnored } from './tuckignore.js';
import {
  FileAlreadyTrackedError,
  FileNotFoundError,
  OperationCancelledError,
  PrivateKeyError,
  SecretsDetectedError,
} from '../errors.js';
import { logForceSecretBypass } from './audit.js';
import {
  getSecretsPath,
  isSecretScanningEnabled,
  processSecretsForRedaction,
  redactFile,
  scanForSecrets,
  shouldBlockOnSecrets,
  type ScanSummary,
} from './secrets/index.js';

const PRIVATE_KEY_PATTERNS = [
  /^id_rsa$/,
  /^id_dsa$/,
  /^id_ecdsa$/,
  /^id_ed25519$/,
  /^id_.*$/,
  /\.pem$/,
  /\.key$/,
  /^.*_key$/,
];

const SENSITIVE_FILE_PATTERNS = [
  /^\.netrc$/,
  /^\.aws\/credentials$/,
  /^\.docker\/config\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.kube\/config$/,
  /^\.ssh\/config$/,
  /^\.gnupg\//,
  /credentials/i,
  /secrets?/i,
  /tokens?\.json$/i,
  /\.env$/,
  /\.env\./,
];

export interface TrackPathCandidate {
  path: string;
  category?: string;
  name?: string;
}

export interface PreparedTrackFile {
  source: string;
  destination: string;
  category: string;
  filename: string;
  nameOverride?: string;
  isDir: boolean;
  fileCount: number;
  sensitive: boolean;
}

export interface PreparePathsForTrackingOptions {
  category?: string;
  name?: string;
  force?: boolean;
  allowAlreadyTracked?: boolean;
  secretHandling?: 'interactive' | 'strict';
  forceBypassCommand?: string;
}

const isPrivateKey = (collapsedPath: string): boolean => {
  const name = basename(collapsedPath);

  if (collapsedPath.includes('.ssh/') && !name.endsWith('.pub')) {
    return PRIVATE_KEY_PATTERNS.some((pattern) => pattern.test(name));
  }

  return name.endsWith('.pem') || name.endsWith('.key');
};

const isSensitiveFile = (collapsedPath: string): boolean => {
  const pathToTest = collapsedPath.startsWith('~/') ? collapsedPath.slice(2) : collapsedPath;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(pathToTest));
};

const displaySecretWarning = (summary: ScanSummary): void => {
  console.log();
  console.log(c.error(c.bold(`  Security Warning: Found ${summary.totalSecrets} potential secret(s)`)));
  console.log();

  for (const result of summary.results) {
    console.log(`  ${c.brand(result.collapsedPath)}`);

    for (const match of result.matches) {
      const severityColor =
        match.severity === 'critical'
          ? c.error
          : match.severity === 'high'
            ? c.warning
            : match.severity === 'medium'
              ? c.info
              : c.muted;

      console.log(
        `    ${c.muted(`Line ${match.line}:`)} ${match.redactedValue} ${severityColor(`[${match.severity}]`)}`
      );
    }
    console.log();
  }
};

const handleFileSizePolicy = async (
  collapsedPath: string,
  sizeBytes: number,
  tuckDir: string,
  secretHandling: 'interactive' | 'strict'
): Promise<boolean> => {
  const sizeLabel = formatFileSize(sizeBytes);
  const isWarn = sizeBytes >= 50 * 1024 * 1024;
  const isBlock = sizeBytes >= 100 * 1024 * 1024;

  if (!isWarn && !isBlock) {
    return true;
  }

  if (secretHandling === 'strict') {
    if (isBlock) {
      throw new OperationCancelledError('file size exceeds GitHub limit');
    }
    logger.warning(`File ${collapsedPath} is ${sizeLabel}. GitHub recommends files under 50MB.`);
    return true;
  }

  if (isBlock) {
    logger.warning(`File ${collapsedPath} is ${sizeLabel} (exceeds GitHub's 100MB limit)`);

    const action = await prompts.select('How would you like to proceed?', [
      { value: 'ignore', label: 'Add to .tuckignore and skip' },
      { value: 'cancel', label: 'Cancel operation' },
    ]);

    if (action === 'ignore') {
      await addToTuckignore(tuckDir, collapsedPath);
      logger.success(`Added ${collapsedPath} to .tuckignore`);
      return false;
    }

    throw new OperationCancelledError('file size exceeds GitHub limit');
  }

  logger.warning(`File ${collapsedPath} is ${sizeLabel}. GitHub recommends files under 50MB.`);
  const action = await prompts.select('How would you like to proceed?', [
    { value: 'continue', label: 'Track it anyway' },
    { value: 'ignore', label: 'Add to .tuckignore and skip' },
    { value: 'cancel', label: 'Cancel operation' },
  ]);

  if (action === 'ignore') {
    await addToTuckignore(tuckDir, collapsedPath);
    logger.success(`Added ${collapsedPath} to .tuckignore`);
    return false;
  }
  if (action === 'cancel') {
    throw new OperationCancelledError('file size warning');
  }

  return true;
};

const applySecretPolicy = async (
  files: PreparedTrackFile[],
  tuckDir: string,
  options: PreparePathsForTrackingOptions
): Promise<PreparedTrackFile[]> => {
  if (files.length === 0) {
    return files;
  }

  if (!(await isSecretScanningEnabled(tuckDir))) {
    return files;
  }

  const secretHandling = options.secretHandling ?? 'interactive';

  if (options.force) {
    if (secretHandling === 'interactive') {
      const confirmed = await prompts.confirmDangerous(
        'Using --force bypasses secret scanning.\n' +
          'Any secrets in these files may be committed to git and potentially exposed.',
        'force'
      );
      if (!confirmed) {
        logger.info('Operation cancelled');
        return [];
      }
    }
    logger.warning('Secret scanning bypassed with --force');
    await logForceSecretBypass(options.forceBypassCommand ?? 'tuck add --force', files.length);
    return files;
  }

  const filePaths = files.map((f) => expandPath(f.source));
  const summary = await scanForSecrets(filePaths, tuckDir);

  if (summary.filesWithSecrets === 0) {
    return files;
  }

  if (secretHandling === 'strict') {
    const shouldBlock = await shouldBlockOnSecrets(tuckDir);
    if (shouldBlock) {
      const filesWithSecrets = summary.results
        .filter((result) => result.hasSecrets)
        .map((result) => collapsePath(result.path));
      throw new SecretsDetectedError(summary.totalSecrets, filesWithSecrets);
    }
    logger.warning('Secrets detected but blockOnSecrets is disabled - proceeding with tracking');
    logger.warning('Make sure your repository is private!');
    return files;
  }

  displaySecretWarning(summary);

  const action = await prompts.select('How would you like to proceed?', [
    { value: 'abort', label: 'Abort operation', hint: 'Do not track these files' },
    {
      value: 'redact',
      label: 'Replace with placeholders',
      hint: 'Store originals in secrets.local.json (never committed)',
    },
    { value: 'ignore', label: 'Add files to .tuckignore', hint: 'Skip these files permanently' },
    { value: 'proceed', label: 'Proceed anyway', hint: 'Track files with secrets (dangerous!)' },
  ]);

  if (action === 'abort') {
    logger.info('Operation aborted');
    return [];
  }

  if (action === 'redact') {
    const redactionMaps = await processSecretsForRedaction(summary.results, tuckDir);
    let totalRedacted = 0;

    for (const result of summary.results) {
      const placeholderMap = redactionMaps.get(result.path);
      if (placeholderMap && placeholderMap.size > 0) {
        const redactionResult = await redactFile(result.path, result.matches, placeholderMap);
        totalRedacted += redactionResult.replacements.length;
      }
    }

    console.log();
    logger.success(`Replaced ${totalRedacted} secret(s) with placeholders`);
    logger.dim(`Secrets stored in: ${collapsePath(getSecretsPath(tuckDir))} (never committed)`);
    logger.dim("Run 'tuck secrets list' to see stored secrets");
    console.log();
    return files;
  }

  if (action === 'ignore') {
    const filesWithSecrets = new Set(summary.results.map((result) => result.collapsedPath));

    for (const file of files) {
      const normalizedSource = collapsePath(file.source);
      if (filesWithSecrets.has(normalizedSource)) {
        await addToTuckignore(tuckDir, file.source);
        logger.success(`Added ${normalizedSource} to .tuckignore`);
      }
    }

    const remaining = files.filter((file) => !filesWithSecrets.has(collapsePath(file.source)));
    if (remaining.length === 0) {
      logger.info('No files remaining to track');
    }
    return remaining;
  }

  const confirmed = await prompts.confirm(
    c.error('Are you SURE you want to track files containing secrets?'),
    false
  );
  if (!confirmed) {
    logger.info('Operation aborted');
    return [];
  }

  logger.warning('Proceeding with secrets - be careful not to push to a public repository!');
  return files;
};

export const preparePathsForTracking = async (
  candidates: TrackPathCandidate[],
  tuckDir: string,
  options: PreparePathsForTrackingOptions = {}
): Promise<PreparedTrackFile[]> => {
  const secretHandling = options.secretHandling ?? 'interactive';
  const prepared: PreparedTrackFile[] = [];

  for (const candidate of candidates) {
    const expandedPath = expandPath(candidate.path);
    const collapsedPath = collapsePath(expandedPath);
    validateSafeSourcePath(collapsedPath);

    if (isPrivateKey(collapsedPath)) {
      throw new PrivateKeyError(candidate.path);
    }

    if (!(await pathExists(expandedPath))) {
      throw new FileNotFoundError(candidate.path);
    }

    if (!options.allowAlreadyTracked && (await isFileTracked(tuckDir, collapsedPath))) {
      throw new FileAlreadyTrackedError(candidate.path);
    }

    if (await isIgnored(tuckDir, collapsedPath)) {
      logger.info(`Skipping ${collapsedPath} (in .tuckignore)`);
      continue;
    }

    if (await shouldExcludeFromBin(expandedPath)) {
      const sizeCheck = await checkFileSizeThreshold(expandedPath);
      logger.info(
        `Skipping binary executable: ${collapsedPath}` +
          `${sizeCheck.size > 0 ? ` (${formatFileSize(sizeCheck.size)})` : ''}` +
          ' - Add to .tuckignore to customize'
      );
      continue;
    }

    const sizeCheck = await checkFileSizeThreshold(expandedPath);
    const shouldTrack = await handleFileSizePolicy(
      collapsedPath,
      sizeCheck.size,
      tuckDir,
      secretHandling
    );
    if (!shouldTrack) {
      continue;
    }

    const isDir = await isDirectory(expandedPath);
    const fileCount = isDir ? await getDirectoryFileCount(expandedPath) : 1;
    const category = candidate.category || options.category || detectCategory(expandedPath);
    const customName = candidate.name ?? options.name;
    const nameOverride = customName ? sanitizeFilename(customName) : undefined;
    const filename = nameOverride || sanitizeFilename(expandedPath);

    prepared.push({
      source: collapsedPath,
      destination: getDestinationPathFromSource(tuckDir, category, expandedPath, nameOverride),
      category,
      filename,
      nameOverride,
      isDir,
      fileCount,
      sensitive: isSensitiveFile(collapsedPath),
    });
  }

  return applySecretPolicy(prepared, tuckDir, options);
};
