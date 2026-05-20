export type FileStrategy = 'copy' | 'symlink';

/**
 * Flags common to every command for agent / CI consumption.
 * Individual command option interfaces extend this when relevant.
 */
export interface CommonOptions {
  /** Emit a single structured JSON envelope on stdout instead of human UI. */
  json?: boolean;
  /** Auto-confirm every interactive prompt (or fail if input is required and missing). */
  yes?: boolean;
  /** Compute and emit the operation plan without executing side effects. */
  plan?: boolean;
  /** Human-friendly synonym for --plan that prints text not JSON. */
  dryRun?: boolean;
}

/** Supported git provider modes */
export type ProviderMode = 'github' | 'gitlab' | 'local' | 'custom';

/** Remote/provider configuration */
export interface RemoteConfig {
  /** Provider mode */
  mode: ProviderMode;
  /** Custom remote URL (for custom mode) */
  url?: string;
  /** Provider instance URL (for self-hosted GitLab, etc.) */
  providerUrl?: string;
  /** Cached username from provider */
  username?: string;
  /** Repository name */
  repoName?: string;
}

export interface TuckConfig {
  repository: {
    path: string;
    defaultBranch: string;
    autoCommit: boolean;
    autoPush: boolean;
  };
  files: {
    strategy: FileStrategy;
    backupOnRestore: boolean;
    backupDir: string;
  };
  categories: Record<
    string,
    {
      patterns: string[];
      icon?: string;
    }
  >;
  ignore: string[];
  hooks: {
    preSync?: string;
    postSync?: string;
    preRestore?: string;
    postRestore?: string;
  };
  templates: {
    enabled: boolean;
    variables: Record<string, string>;
  };
  encryption: {
    enabled: boolean;
    gpgKey?: string;
    files: string[];
  };
  ui: {
    colors: boolean;
    emoji: boolean;
    verbose: boolean;
  };
  /** Remote/provider configuration */
  remote?: RemoteConfig;
}

export interface TrackedFile {
  source: string;
  destination: string;
  category: string;
  strategy: FileStrategy;
  encrypted: boolean;
  template: boolean;
  permissions?: string;
  added: string;
  modified: string;
  checksum: string;
}

export interface TuckManifest {
  version: string;
  created: string;
  updated: string;
  machine?: string;
  files: Record<string, TrackedFile>;
}

export interface InitOptions {
  dir?: string;
  remote?: string;
  bare?: boolean;
  from?: string;
}

export interface AddOptions extends CommonOptions {
  category?: string;
  name?: string;
  symlink?: boolean;
  force?: boolean; // Skip secret scanning (secrets will not be detected)
  /** Encrypt the file at rest in the repo using the configured passphrase. */
  encrypt?: boolean;
  /** Mark this file as a template so it is rendered at restore time. */
  template?: boolean;
}

export interface RemoveOptions {
  delete?: boolean;
  keepOriginal?: boolean;
}

export interface SyncOptions extends CommonOptions {
  message?: string;
  noCommit?: boolean;
  push?: boolean; // Commander converts --no-push to push: false
  pull?: boolean; // Commander converts --no-pull to pull: false
  scan?: boolean; // Commander converts --no-scan to scan: false
  noHooks?: boolean;
  trustHooks?: boolean;
  force?: boolean; // Skip secret scanning
}

export interface PushOptions {
  force?: boolean;
  setUpstream?: string;
}

export interface PullOptions {
  rebase?: boolean;
  restore?: boolean;
}

export interface RestoreOptions extends CommonOptions {
  all?: boolean;
  symlink?: boolean;
  backup?: boolean;
  noHooks?: boolean;
  trustHooks?: boolean;
  noSecrets?: boolean;
}

export interface StatusOptions extends CommonOptions {
  short?: boolean;
}

export interface ListOptions extends CommonOptions {
  category?: string;
  paths?: boolean;
}

export interface DiffOptions extends CommonOptions {
  staged?: boolean;
  stat?: boolean;
  category?: string;
  nameOnly?: boolean;
  exitCode?: boolean;
}

export interface ApplyOptions extends CommonOptions {
  symlink?: boolean;
  category?: string;
  force?: boolean;
  noSecrets?: boolean;
}

export interface DoctorOptions extends CommonOptions {
  strict?: boolean;
  category?: 'env' | 'repo' | 'manifest' | 'security' | 'hooks';
}

export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  source: string;
  destination?: string;
}
