import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { expandPath, getTuckDir, pathExists } from './paths.js';

const LEGACY_SNAPSHOTS_DIRNAME = 'backups';
const LEGACY_AUDIT_LOG_FILENAME = 'audit.log';
const LEGACY_FALLBACK_KEYSTORE_FILENAME = '.tuck-keystore.enc';

export const LOCAL_SECRETS_FILENAME = 'secrets.local.json';

export const REPO_RUNTIME_GITIGNORE_PATTERNS = [
  LOCAL_SECRETS_FILENAME,
  `${LEGACY_SNAPSHOTS_DIRNAME}/`,
  LEGACY_AUDIT_LOG_FILENAME,
  LEGACY_FALLBACK_KEYSTORE_FILENAME,
] as const;

export const REPO_STAGE_BLOCKLIST = new Set<string>([
  '.git',
  LOCAL_SECRETS_FILENAME,
  LEGACY_SNAPSHOTS_DIRNAME,
  LEGACY_AUDIT_LOG_FILENAME,
  LEGACY_FALLBACK_KEYSTORE_FILENAME,
]);

const getBaseStateHome = (): string => {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    return expandPath(xdgStateHome);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return expandPath(localAppData);
    }
    return join(homedir(), 'AppData', 'Local');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }

  return join(homedir(), '.local', 'state');
};

export const getStateDir = (): string => {
  return join(getBaseStateHome(), 'tuck');
};

export const getSnapshotsDir = (): string => {
  return join(getStateDir(), 'snapshots');
};

export const getAuditLogPath = (): string => {
  return join(getStateDir(), 'audit.log');
};

export const getFallbackKeystorePath = (): string => {
  return join(getStateDir(), 'keystore', LEGACY_FALLBACK_KEYSTORE_FILENAME);
};

export const getLegacySnapshotsDir = (tuckDir = getTuckDir()): string => {
  return join(tuckDir, LEGACY_SNAPSHOTS_DIRNAME);
};

export const getLegacyAuditLogPath = (tuckDir = getTuckDir()): string => {
  return join(tuckDir, LEGACY_AUDIT_LOG_FILENAME);
};

export const getLegacyFallbackKeystorePath = (tuckDir = getTuckDir()): string => {
  return join(tuckDir, LEGACY_FALLBACK_KEYSTORE_FILENAME);
};

export const ensureRuntimeArtifactsGitignored = async (tuckDir: string): Promise<void> => {
  const gitignorePath = join(tuckDir, '.gitignore');
  const currentContent = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, 'utf-8') : '';
  const existingPatterns = new Set(
    currentContent
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  const missingPatterns = REPO_RUNTIME_GITIGNORE_PATTERNS.filter(
    (pattern) => !existingPatterns.has(pattern)
  );

  if (missingPatterns.length === 0) {
    return;
  }

  const trimmed = currentContent.trim();
  const updatedContent = [
    trimmed,
    trimmed ? '' : undefined,
    '# Local secrets and legacy runtime state',
    ...missingPatterns,
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  await writeFile(gitignorePath, updatedContent, 'utf-8');
};
