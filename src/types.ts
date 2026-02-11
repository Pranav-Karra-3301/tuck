export type FileStrategy = 'copy' | 'symlink';

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

export interface AddOptions {
  category?: string;
  name?: string;
  symlink?: boolean;
  force?: boolean; // Skip secret scanning (secrets will not be detected)
  // TODO: Encryption and templating are planned for a future version
  // encrypt?: boolean;
  // template?: boolean;
}

export interface RemoveOptions {
  delete?: boolean;
  keepOriginal?: boolean;
}

export interface SyncOptions {
  message?: string;
  // TODO: --all and --amend are planned for a future version
  // all?: boolean;
  // amend?: boolean;
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

export interface RestoreOptions {
  all?: boolean;
  symlink?: boolean;
  backup?: boolean;
  dryRun?: boolean;
  noHooks?: boolean;
  trustHooks?: boolean;
  noSecrets?: boolean;
}

export interface StatusOptions {
  short?: boolean;
  json?: boolean;
}

export interface ListOptions {
  category?: string;
  paths?: boolean;
  json?: boolean;
}

export interface DiffOptions {
  staged?: boolean;
  stat?: boolean;
  category?: string;
  nameOnly?: boolean;
  exitCode?: boolean;
}

export interface DoctorOptions {
  json?: boolean;
  strict?: boolean;
  category?: 'env' | 'repo' | 'manifest' | 'security' | 'hooks';
}

export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  source: string;
  destination?: string;
}
