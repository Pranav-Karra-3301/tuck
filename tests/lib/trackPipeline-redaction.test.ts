/**
 * Repo-only redaction regression test (issue #100 RC5).
 *
 * When the user chooses "Replace with placeholders" during `tuck add`, tuck used
 * to rewrite the LIVE file in $HOME — breaking the user's live shell/config while
 * only the repo copy was ever supposed to carry placeholders. The new contract:
 *
 *   - the live file is left BYTE-IDENTICAL,
 *   - only the repository copy gets `{{PLACEHOLDER}}` substitutions,
 *   - no cleartext secret (or its tail) survives in the repo copy,
 *   - the manifest checksum reflects the REDACTED repo copy.
 *
 * Runs against the global memfs sandbox (os.homedir() -> /test-home).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  TEST_HOME,
  TEST_TUCK_DIR,
  initTestTuck,
} from '../utils/testHelpers.js';
import { clearManifestCache } from '../../src/lib/manifest.js';

const selectMock = vi.fn();

// Minimal ui mock: the redact path drives prompts.select, and both the pipeline
// and fileTracking emit through logger; colours are identity passthroughs.
vi.mock('../../src/ui/index.js', () => {
  const identity = (s: string) => s;
  const colors = new Proxy({}, { get: () => identity }) as Record<string, (s: string) => string>;
  return {
    colors,
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      warn: vi.fn(),
      dim: vi.fn(),
      debug: vi.fn(),
      heading: vi.fn(),
      file: vi.fn(),
    },
    prompts: {
      select: selectMock,
      confirm: vi.fn().mockResolvedValue(false),
      confirmDangerous: vi.fn().mockResolvedValue(false),
    },
  };
});

const SECRET_LINE =
  'export LAMBDA_API_KEY=secret_example_e3878cb6494b410eabc3e16d15a99b08.SecondHalfOfKey12345';

describe('track pipeline repo-only redaction', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('leaves the live file untouched and redacts only the repo copy', async () => {
    selectMock.mockResolvedValue('redact');
    await initTestTuck();

    const live = join(TEST_HOME, '.zshrc');
    const original = `# comment\n${SECRET_LINE}\nalias ll="ls -la"\n`;
    vol.writeFileSync(live, original);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { preparePathsForTracking } = await import('../../src/lib/trackPipeline.js');
    const { trackFilesWithProgress } = await import('../../src/lib/fileTracking.js');
    const { loadManifest } = await import('../../src/lib/manifest.js');
    const { getFileChecksum } = await import('../../src/lib/files.js');

    const prepared = await preparePathsForTracking([{ path: '~/.zshrc' }], TEST_TUCK_DIR, {
      secretHandling: 'interactive',
    });

    expect(prepared).toHaveLength(1);
    // The redaction plan is attached to the candidate, not applied yet.
    expect(prepared[0].redactions?.length).toBeGreaterThan(0);

    // Map PreparedTrackFile -> FileToTrack the same way `tuck add` does, carrying
    // the redaction plan across so it lands on the repo copy after the copy step.
    const result = await trackFilesWithProgress(
      [
        {
          path: prepared[0].source,
          category: prepared[0].category,
          redactions: prepared[0].redactions,
        },
      ],
      TEST_TUCK_DIR,
      { showCategory: false, delayBetween: 0 }
    );
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // LIVE FILE: byte-identical — never rewritten.
    expect(vol.readFileSync(live, 'utf-8')).toBe(original);

    // REPO COPY: placeholder in, cleartext (and its tail) out.
    const manifest = await loadManifest(TEST_TUCK_DIR);
    const entry = Object.values(manifest.files).find((f) => f.source === '~/.zshrc');
    expect(entry).toBeDefined();
    const repoAbs = join(TEST_TUCK_DIR, entry!.destination);
    const repoCopy = vol.readFileSync(repoAbs, 'utf-8') as string;

    expect(repoCopy).toContain('export LAMBDA_API_KEY={{LAMBDA_API_KEY}}');
    expect(repoCopy).not.toContain('secret_example');
    expect(repoCopy).not.toContain('SecondHalfOfKey12345');

    // Manifest checksum matches the REDACTED repo copy (not the live cleartext).
    expect(entry!.checksum).toBe(await getFileChecksum(repoAbs));

    logSpy.mockRestore();
  });
});
