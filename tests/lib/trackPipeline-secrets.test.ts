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

  it('redact action records the redacted live paths and restores them after tracking (issue #100)', async () => {
    selectMock.mockResolvedValue('redact');
    await initTestTuck();

    const file = join(TEST_HOME, '.testrc');
    const original = 'export MY_API_KEY=secret_0123456789abcdef0123456789abcdef\n';
    vol.writeFileSync(file, original);

    const { preparePathsForTracking, restoreRedactedLiveFiles } = await import(
      '../../src/lib/trackPipeline.js'
    );

    const prepared = await preparePathsForTracking([{ path: file }], TEST_TUCK_DIR, {
      secretHandling: 'interactive',
    });
    expect(prepared).toHaveLength(1);

    // The live file is redacted for the upcoming copy into the repo — but the
    // variable name must survive (only the VALUE is a secret), and the pipeline
    // must remember which live paths it rewrote.
    const redacted = vol.readFileSync(file, 'utf-8') as string;
    expect(redacted).toContain('MY_API_KEY={{');
    expect(redacted).not.toContain('secret_0123456789');
    expect(prepared[0].redactedLivePaths).toEqual([file]);

    // After the repo copy exists, the caller restores the live file so the
    // user's actual config keeps working.
    await restoreRedactedLiveFiles(prepared, TEST_TUCK_DIR);
    expect(vol.readFileSync(file, 'utf-8')).toBe(original);
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
});
