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
  /** Logical group above category. Defaults to "default". */
  bundle: string;
  /**
   * Dot-delimited JSON key path when this entry tracks only a SUBTREE of a JSON
   * file (e.g. `mcpServers`). The repo copy holds just that subtree; apply/
   * restore deep-merge it back into the live file. Absent for whole-file entries.
   */
  jsonKey?: string;
}

export interface BundleMetadata {
  description?: string;
  created: string;
}

export interface TuckManifest {
  version: string;
  created: string;
  updated: string;
  machine?: string;
  files: Record<string, TrackedFile>;
  bundles: Record<string, BundleMetadata>;
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
  /** Bundle to assign the tracked file to. Defaults to "default". */
  bundle?: string;
  /**
   * Track the file as REPO-scoped: it lives inside a git repo (optionally at
   * the given dir; auto-detected from the path otherwise) whose absolute path
   * differs per machine. Stored by stable (repoKey, repoRelative).
   */
  repo?: string | boolean;
  /** Explicit repoKey override (advanced; default derives from the remote). */
  repoKey?: string;
  /**
   * Track only the JSON subtree at this dot-delimited key path (e.g.
   * `mcpServers`) instead of the whole file. On apply/restore the subtree is
   * deep-merged back into the live file, leaving all other keys untouched.
   */
  key?: string;
}

export interface RemoveOptions extends CommonOptions {
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

export interface PushOptions extends CommonOptions {
  force?: boolean;
  // Boolean trigger: set the upstream for the CURRENT branch on push.
  // (Was historically typed as a string ref, which let `--set-upstream <name>`
  // push a ref named after the flag value instead of the current branch.)
  setUpstream?: boolean;
}

export interface PullOptions extends CommonOptions {
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
  /** Bind an as-yet-unknown repo to this root before restoring repo-scoped files. */
  repoRoot?: string;
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
  /** Scope apply to a single bundle. Defaults to all bundles when unset. */
  bundle?: string;
  /** Bind an as-yet-unknown repo to this root before applying repo-scoped files. */
  repoRoot?: string;
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
