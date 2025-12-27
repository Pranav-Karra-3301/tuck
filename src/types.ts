export type FileStrategy = 'copy' | 'symlink';

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
  encrypt?: boolean;
  template?: boolean;
}

export interface RemoveOptions {
  delete?: boolean;
  keepOriginal?: boolean;
}

export interface SyncOptions {
  message?: string;
  all?: boolean;
  noCommit?: boolean;
  noPush?: boolean;
  amend?: boolean;
  noHooks?: boolean;
  trustHooks?: boolean;
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
}

export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  source: string;
  destination?: string;
}
