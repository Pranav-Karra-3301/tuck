import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

interface TestFileDiff {
  source: string;
  destination: string;
  hasChanges: boolean;
  isBinary?: boolean;
  isDirectory?: boolean;
  fileCount?: number;
  systemSize?: number;
  repoSize?: number;
  systemContent?: string;
  repoContent?: string;
}

// Mock UI
vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('general'),
    text: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
    },
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: '',
    })),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('diff command', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  describe('diff formatting', () => {
    it('should format file missing on system correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff: TestFileDiff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        repoContent: 'line 1\nline 2',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File missing on system');
      expect(output).toContain('Repository content:');
      expect(output).toContain('+ line 1');
      expect(output).toContain('+ line 2');
    });

    it('should format file not in repo correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff: TestFileDiff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: 'line 1\nline 2',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('File not yet synced to repository');
      expect(output).toContain('System content:');
      expect(output).toContain('- line 1');
      expect(output).toContain('- line 2');
    });

    it('should format line-by-line diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff: TestFileDiff = {
        source: '~/.test.txt',
        destination: 'files/test.txt',
        hasChanges: true,
        systemContent: 'line 1\nline 2\nline 3\nline 4',
        repoContent: 'line 1\nmodified\nline 3\nline 4',
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('- line 2');
      expect(output).toContain('+ modified');
    });

    it('should format binary file diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff: TestFileDiff = {
        source: '~/.test-binary',
        destination: 'files/test-binary',
        hasChanges: true,
        isBinary: true,
        systemSize: 100,
        repoSize: 200,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('Binary files differ');
      expect(output).toContain('System:');
      expect(output).toContain('Repo:');
      expect(output).toContain('100 B');
      expect(output).toContain('200 B');
    });

    it('should format directory diff correctly', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const diff: TestFileDiff = {
        source: '~/.config/test',
        destination: 'files/test',
        hasChanges: true,
        isDirectory: true,
        fileCount: 5,
      };

      const output = formatUnifiedDiff(diff);

      expect(output).toContain('Directory content changed');
      expect(output).toContain('Contains 5 files');
    });
  });

  describe('FileDiff shape (real getFileDiff)', () => {
    const seedPlainText = (repoBody: string, liveBody: string): void => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), repoBody);
      vol.writeFileSync('/test-home/.zshrc', liveBody);
    };

    it('populates the required fields from the manifest entry and live/repo state', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      seedPlainText('repo\n', 'live\n');

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');

      expect(diff).not.toBeNull();
      // source echoes the requested key; destination comes from the manifest entry.
      expect(diff?.source).toBe('~/.zshrc');
      expect(diff?.destination).toBe('files/shell/zshrc');
      // A real byte difference must be reported as a change with both sides present.
      expect(diff?.hasChanges).toBe(true);
      expect(diff?.systemContent).toBe('live\n');
      expect(diff?.repoContent).toBe('repo\n');
    });

    it('leaves directory/binary optional fields unset for a plain text file', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      seedPlainText('repo\n', 'live\n');

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');

      expect(diff).not.toBeNull();
      // A plain text change never populates the directory/binary discriminators.
      expect(diff?.isBinary).toBeUndefined();
      expect(diff?.isDirectory).toBeUndefined();
      expect(diff?.fileCount).toBeUndefined();
    });
  });

  describe('manifest path safety', () => {
    it('rejects unsafe repository destination paths from manifest entries', async () => {
      const { runDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/../../outside',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      await expect(runDiff([], {})).rejects.toThrow('Unsafe manifest destination');
    });
  });

  describe('formatUnifiedDiff context bounding', () => {
    const bigFile = (changedIndex: number, changedTo: string): string =>
      Array.from({ length: 100 }, (_, i) => (i === changedIndex ? changedTo : `line ${i}`)).join(
        '\n'
      );

    it('should bound trailing context to a few lines when only one line changed', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const output = formatUnifiedDiff({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        hasChanges: true,
        systemContent: bigFile(50, 'line 50'),
        repoContent: bigFile(50, 'CHANGED'),
      });

      // The change and its immediate neighbours are shown…
      expect(output).toContain('CHANGED');
      expect(output).toContain('line 49');
      expect(output).toContain('line 51');
      // …but the entire remainder of the file is NOT dumped as "context".
      expect(output).not.toContain('line 90');
      expect(output).not.toContain('line 99');
      // Exactly one hunk for a single contiguous change.
      const hunks = output.split('\n').filter((l) => l.includes('@@ -'));
      expect(hunks).toHaveLength(1);
    });

    it('should open a separate hunk for each well-separated change', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      const system = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const repo = Array.from({ length: 100 }, (_, i) => {
        if (i === 10) return 'CHANGED_A';
        if (i === 80) return 'CHANGED_B';
        return `line ${i}`;
      }).join('\n');

      const output = formatUnifiedDiff({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        hasChanges: true,
        systemContent: system,
        repoContent: repo,
      });

      expect(output).toContain('CHANGED_A');
      expect(output).toContain('CHANGED_B');
      const hunks = output.split('\n').filter((l) => l.includes('@@ -'));
      expect(hunks).toHaveLength(2);
    });

    it('realigns after a prepended line instead of mislabeling the whole tail', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      // One line ('x') prepended: a real Myers diff reports a single insertion,
      // whereas a positional index-aligned compare would mislabel a/b/c as
      // changed because every line shifts by one.
      const output = formatUnifiedDiff({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        hasChanges: true,
        systemContent: 'a\nb\nc',
        repoContent: 'x\na\nb\nc',
      });

      const changeLines = output
        .split('\n')
        .filter((l) => /^[+-] /.test(l))
        .map((l) => l.replace(/^([+-]) /, '$1'));

      // Exactly one added line ('+x') and NO removed lines: a, b, c stay put.
      // A positional index-aligned compare would instead emit '-a/+x', '-b/+a',
      // '-c/+b', '+c' — churning the entire tail — so this pins the realignment.
      expect(changeLines).toEqual(['+x']);
      // The unchanged tail appears as dimmed context lines ('  a' etc.), which
      // carry no +/- change marker.
      expect(output).toContain('  a');
      expect(output).toContain('  b');
      expect(output).toContain('  c');
    });

    it('emits accurate @@ old/new hunk ranges for a single-line modification', async () => {
      const { formatUnifiedDiff } = await import('../../src/commands/diff.js');

      // Change line 2 of a 4-line file. With 3 lines of context the hunk spans
      // the whole file: old and new both have 4 lines starting at line 1.
      const output = formatUnifiedDiff({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        hasChanges: true,
        systemContent: 'line 1\nline 2\nline 3\nline 4',
        repoContent: 'line 1\nMODIFIED\nline 3\nline 4',
      });

      const header = output.split('\n').find((l) => l.includes('@@ -'));
      expect(header).toBeDefined();
      // Strip color codes before asserting the exact range string.
      // eslint-disable-next-line no-control-regex
      const plain = header!.replace(/\[[0-9;]*m/g, '');
      expect(plain).toBe('@@ -1,4 +1,4 @@');
    });
  });

  describe('template/encryption awareness', () => {
    it('should report no change for an in-sync template file (compares materialized repo)', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['tmpl'] = createMockTrackedFile({
        source: '~/.tmpl',
        destination: 'files/misc/tmpl',
        template: true,
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      // Repo holds the un-rendered template source; live holds the rendered form.
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/misc'), { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/misc/tmpl'), 'H={{ home }}\n');
      vol.writeFileSync('/test-home/.tmpl', 'H=/test-home\n');

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.tmpl');
      expect(diff?.hasChanges).toBe(false);
    });

    it('should diff against the materialized repo content, not the raw template source', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['tmpl'] = createMockTrackedFile({
        source: '~/.tmpl',
        destination: 'files/misc/tmpl',
        template: true,
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/misc'), { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/misc/tmpl'), 'H={{ home }}\n');
      vol.writeFileSync('/test-home/.tmpl', 'H=/somewhere-else\n');

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.tmpl');
      expect(diff?.hasChanges).toBe(true);
      // repoContent is the rendered form, never the literal "{{ home }}".
      expect(diff?.repoContent).toBe('H=/test-home\n');
      expect(diff?.repoContent).not.toContain('{{');
    });

    it('redacts a stored secret in template systemContent/repoContent (never prints cleartext)', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      const SECRET = 'S3CRET-tmpl-777';
      const manifest = createMockManifest();
      manifest.files['tmpl'] = createMockTrackedFile({
        source: '~/.tmpl',
        destination: 'files/misc/tmpl',
        template: true,
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/misc'), { recursive: true });
      // Repo template renders to a body that embeds the cleartext secret, and the
      // live file also carries the cleartext secret plus a real edit so a diff is
      // produced.
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/misc/tmpl'), `token=${SECRET}\nH={{ home }}\n`);
      vol.writeFileSync('/test-home/.tmpl', `token=${SECRET}\nH=/test-home\nexport EXTRA=1\n`);
      const { setSecret } = await import('../../src/lib/secrets/store.js');
      await setSecret(TEST_TUCK_DIR, 'TOK', SECRET);

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.tmpl');
      expect(diff?.hasChanges).toBe(true);
      // Both displayed strings are redacted — the real secret never leaks into
      // `tuck diff` output for template/encrypted files.
      expect(diff?.systemContent).toContain('{{TOK}}');
      expect(diff?.systemContent).not.toContain(SECRET);
      expect(diff?.repoContent).toContain('{{TOK}}');
      expect(diff?.repoContent).not.toContain(SECRET);
    });

    it('should return null for a repo-scoped file whose repo is not bound on this machine', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['eslint'] = createMockTrackedFile({
        source: 'someproj-a1b2c3d4:.eslintrc',
        destination: 'files/repos/someproj-a1b2c3d4/.eslintrc',
        scope: 'repo',
        repoKey: 'someproj-a1b2c3d4',
        repoRelative: '.eslintrc',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

      // No repos.json binding exists → must resolve to null, never throw or
      // fabricate a cwd-relative path.
      const diff = await getFileDiff(TEST_TUCK_DIR, 'someproj-a1b2c3d4:.eslintrc');
      expect(diff).toBeNull();
    });
  });

  describe('secret-placeholder awareness (issue #100)', () => {
    const SECRET = 'S3CRET-diff-999';

    const setupTracked = async (): Promise<void> => {
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
      // Repo copy holds the placeholder; the manifest checksum is irrelevant to
      // getFileDiff (it compares live vs repo directly).
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'token={{TOK}}\n');
      const { setSecret } = await import('../../src/lib/secrets/store.js');
      await setSecret(TEST_TUCK_DIR, 'TOK', SECRET);
    };

    it('reports no change when the live file differs only by the redacted secret', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      await setupTracked();
      vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\n`);

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');
      expect(diff?.hasChanges).toBe(false);
    });

    it('reports a real edit AND never prints the cleartext secret in systemContent', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      await setupTracked();
      vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\nexport EXTRA=1\n`);

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');
      expect(diff?.hasChanges).toBe(true);
      // The displayed system content is REDACTED — the real secret never leaks
      // into `tuck diff` output.
      expect(diff?.systemContent).toContain('{{TOK}}');
      expect(diff?.systemContent).not.toContain(SECRET);
      expect(diff?.systemContent).toContain('export EXTRA=1');
    });

    it('redacts systemContent in the missing-repo branch (never prints cleartext)', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      await setupTracked();
      // Repo copy is GONE — the branch that dumps the whole live file as
      // systemContent must still redact known secrets before display.
      vol.unlinkSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'));
      vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\n`);

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');
      expect(diff?.hasChanges).toBe(true);
      expect(diff?.systemContent).toContain('{{TOK}}');
      expect(diff?.systemContent).not.toContain(SECRET);
    });

    it('never touches the secrets store when raw checksums already match (lazy load)', async () => {
      const { getFileDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'plain\n');
      vol.writeFileSync('/test-home/.zshrc', 'plain\n');
      // A CORRUPT secrets store makes loadSecretsStore throw — so if the lazy
      // path (no valueMap threaded) touched the store for a raw-equal file,
      // this call would reject instead of reporting "no changes".
      vol.writeFileSync(join(TEST_TUCK_DIR, 'secrets.local.json'), '{not json');

      const diff = await getFileDiff(TEST_TUCK_DIR, '~/.zshrc');
      expect(diff?.hasChanges).toBe(false);
    });
  });

  describe('--exit-code with --name-only', () => {
    it('should exit 1 when drift exists even in name-only mode', async () => {
      const { runDiff } = await import('../../src/commands/diff.js');
      const manifest = createMockManifest();
      manifest.files['zshrc'] = createMockTrackedFile({
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
      vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'repo\n');
      vol.writeFileSync('/test-home/.zshrc', 'live\n');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

      await expect(runDiff([], { nameOnly: true, exitCode: true })).rejects.toThrow(
        'process.exit:1'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});
