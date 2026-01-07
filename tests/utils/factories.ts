/**
 * Mock factories for creating test data
 */

import type { TuckConfigOutput } from '../../src/schemas/config.schema.js';
import type { TuckManifestOutput, TrackedFileOutput } from '../../src/schemas/manifest.schema.js';

/**
 * Create a valid mock config object
 */
export const createMockConfig = (
  overrides?: Partial<TuckConfigOutput>
): TuckConfigOutput => {
  return {
    repository: {
      path: '/test-home/.tuck',
      defaultBranch: 'main',
      autoCommit: true,
      autoPush: false,
      ...overrides?.repository,
    },
    files: {
      strategy: 'copy',
      backupOnRestore: true,
      backupDir: '/test-home/.tuck-backups',
      ...overrides?.files,
    },
    categories: overrides?.categories ?? {},
    ignore: overrides?.ignore ?? [],
    hooks: overrides?.hooks ?? {},
    templates: {
      enabled: false,
      variables: {},
      ...overrides?.templates,
    },
    encryption: {
      enabled: false,
      files: [],
      ...overrides?.encryption,
    },
    ui: {
      colors: true,
      emoji: true,
      verbose: false,
      ...overrides?.ui,
    },
  };
};

/**
 * Create a valid mock manifest object
 */
export const createMockManifest = (
  overrides?: Partial<TuckManifestOutput>
): TuckManifestOutput => {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    created: now,
    updated: now,
    machine: 'test-machine',
    files: overrides?.files ?? {},
    ...overrides,
  };
};

/**
 * Create a valid tracked file entry
 */
export const createMockTrackedFile = (
  overrides?: Partial<TrackedFileOutput>
): TrackedFileOutput => {
  const now = new Date().toISOString();
  return {
    source: '~/.zshrc',
    destination: 'files/shell/zshrc',
    category: 'shell',
    strategy: 'copy',
    encrypted: false,
    template: false,
    added: now,
    modified: now,
    checksum: 'abc123def456',
    ...overrides,
  };
};

/**
 * Create a manifest with multiple tracked files
 */
export const createMockManifestWithFiles = (
  files: Array<Partial<TrackedFileOutput>>
): TuckManifestOutput => {
  const manifest = createMockManifest();

  for (let i = 0; i < files.length; i++) {
    const file = createMockTrackedFile(files[i]);
    const id = files[i]?.source?.replace(/[^a-zA-Z0-9]/g, '_') || `file_${i}`;
    manifest.files[id] = file;
  }

  return manifest;
};

/**
 * Create common test dotfiles
 */
export const COMMON_TEST_FILES = {
  zshrc: {
    source: '~/.zshrc',
    destination: 'files/shell/zshrc',
    category: 'shell',
  },
  bashrc: {
    source: '~/.bashrc',
    destination: 'files/shell/bashrc',
    category: 'shell',
  },
  gitconfig: {
    source: '~/.gitconfig',
    destination: 'files/git/gitconfig',
    category: 'git',
  },
  vimrc: {
    source: '~/.vimrc',
    destination: 'files/editors/vimrc',
    category: 'editors',
  },
  tmuxConf: {
    source: '~/.tmux.conf',
    destination: 'files/terminal/tmux.conf',
    category: 'terminal',
  },
  sshConfig: {
    source: '~/.ssh/config',
    destination: 'files/ssh/config',
    category: 'ssh',
  },
};
