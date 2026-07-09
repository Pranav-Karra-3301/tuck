/**
 * Secret-gate regression tests for the track pipeline.
 *
 * These cover two holes that let secrets slip past `tuck add`:
 *   1. A tracked DIRECTORY candidate was handed to the scanner verbatim; the
 *      scanner skips directories ("Is a directory"), so a credentials file inside
 *      a tracked directory was committed completely unscanned.
 *   2. The interactive 'Add to .tuckignore' action matched scan results by
 *      collapsePath(source), which never equals a REPO-scoped file's identity
 *      (`<repoKey>:<repoRelative>`) — so a repo file the user chose to ignore was
 *      tracked (secret included) anyway.
 *
 * They run against the global memfs sandbox (os.homedir() -> /test-home).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, initTestTuck } from '../utils/testHelpers.js';
import { SecretsDetectedError } from '../../src/errors.js';

// A reliable built-in secret pattern (AWS access key id).
const AWS_SECRET = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n';

const selectMock = vi.fn();
const textMock = vi.fn();

// Minimal ui mock: strict-mode paths need only logger; the interactive 'ignore'
// path needs a controllable prompts.select plus colour/logging stubs.
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
    },
    prompts: {
      select: selectMock,
      text: textMock,
      confirm: vi.fn().mockResolvedValue(false),
      confirmDangerous: vi.fn().mockResolvedValue(false),
    },
  };
});

describe('track pipeline secret gate', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('blocks tracking when a secret lives inside a tracked directory (strict mode)', async () => {
    await initTestTuck();

    // A directory candidate whose SECRET is in an inner file — the scanner skips
    // the directory path itself, so without expansion this passes the gate.
    const dir = join(TEST_HOME, '.config', 'sometool');
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(join(dir, 'credentials'), AWS_SECRET);

    const { preparePathsForTracking } = await import('../../src/lib/trackPipeline.js');

    await expect(
      preparePathsForTracking([{ path: dir }], TEST_TUCK_DIR, { secretHandling: 'strict' })
    ).rejects.toBeInstanceOf(SecretsDetectedError);
  });

  it('excludes a repo-scoped file from tracking when the user chooses the .tuckignore action', async () => {
    selectMock.mockResolvedValue('ignore');
    await initTestTuck();

    // A git repo OUTSIDE the mocked home to prove repo-scoped tracking is not
    // home-confined; the explicit repoKey keeps the derived identity deterministic.
    const repoRoot = '/work/myrepo';
    vol.mkdirSync(join(repoRoot, '.git'), { recursive: true });
    vol.writeFileSync(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main');
    vol.writeFileSync(join(repoRoot, '.env'), AWS_SECRET);

    const { preparePathsForTracking } = await import('../../src/lib/trackPipeline.js');

    const prepared = await preparePathsForTracking([{ path: join(repoRoot, '.env') }], TEST_TUCK_DIR, {
      repo: repoRoot,
      repoKey: 'myrepo',
      secretHandling: 'interactive',
    });

    // The secret-bearing repo file must be filtered out — never returned for
    // tracking despite the identity-vs-live-path mismatch.
    expect(prepared).toHaveLength(0);
  });

  it('allowlists findings and tracks the file when the user chooses "Mark as safe"', async () => {
    selectMock.mockResolvedValue('allow');
    textMock.mockResolvedValue('example value from docs');
    await initTestTuck();

    const filePath = join(TEST_HOME, '.config', 'app.conf');
    vol.mkdirSync(join(TEST_HOME, '.config'), { recursive: true });
    vol.writeFileSync(filePath, AWS_SECRET);

    const { preparePathsForTracking } = await import('../../src/lib/trackPipeline.js');
    const { listAllowlistEntries } = await import('../../src/lib/secrets/allowlist.js');

    const prepared = await preparePathsForTracking([{ path: filePath }], TEST_TUCK_DIR, {
      secretHandling: 'interactive',
    });

    // The file is tracked (returned) because the finding is now allowlisted...
    expect(prepared).toHaveLength(1);
    // ...and a committed, auditable allowlist entry was recorded.
    const entries = await listAllowlistEntries(TEST_TUCK_DIR);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].reason).toBe('example value from docs');

    // A subsequent scan of the same file no longer flags it.
    const { scanForSecrets } = await import('../../src/lib/secrets/index.js');
    const rescan = await scanForSecrets([filePath], TEST_TUCK_DIR);
    expect(rescan.filesWithSecrets).toBe(0);
  });
});
