/**
 * preset apply safety unit tests.
 *
 * `tuck preset apply` writes files to disk from a (potentially untrusted)
 * preset manifest. It must (a) never write outside the user's home and (b)
 * never silently clobber existing files without consent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { TEST_HOME } from '../setup.js';
import {
  assertPresetTargetsSafe,
  decidePresetOverwrite,
  bundledRegistryDir,
  applyAction,
  translateAction,
} from '../../src/commands/preset.js';

// Spy on the snapshot helper so we can assert it is (or is not) called with the
// existing targets — without exercising the real Time Machine internals.
const createPreApplySnapshotMock = vi.fn(async () => ({}));
vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: (...args: unknown[]) => createPreApplySnapshotMock(...args),
}));

// Silence UI; capture confirm so we control the interactive overwrite path.
const confirmMock = vi.fn().mockResolvedValue(true);
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: (...a: unknown[]) => confirmMock(...a),
    note: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    dim: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    cyan: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
  },
}));

describe('assertPresetTargetsSafe', () => {
  it('accepts targets inside $HOME', () => {
    expect(() =>
      assertPresetTargetsSafe([
        { target: '/test-home/.claude/CLAUDE.md' },
        { target: '/test-home/.zshrc' },
      ])
    ).not.toThrow();
  });

  it('rejects an absolute target outside $HOME', () => {
    expect(() => assertPresetTargetsSafe([{ target: '/etc/cron.d/evil' }])).toThrow();
  });

  it('rejects a ~-relative target that escapes $HOME via ..', () => {
    expect(() => assertPresetTargetsSafe([{ target: '~/../../tmp/evil' }])).toThrow();
  });

  it('rejects the whole batch if any single target is unsafe', () => {
    expect(() =>
      assertPresetTargetsSafe([{ target: '/test-home/.config/ok' }, { target: '/root/.bashrc' }])
    ).toThrow();
  });
});

describe('decidePresetOverwrite', () => {
  it('proceeds when nothing would be overwritten', () => {
    expect(decidePresetOverwrite(0, { nonInteractive: true })).toBe('proceed');
  });

  it('proceeds when --yes is given even if files exist', () => {
    expect(decidePresetOverwrite(3, { yes: true, nonInteractive: true })).toBe('proceed');
  });

  it('refuses in non-interactive mode without --yes when files exist', () => {
    expect(decidePresetOverwrite(2, { nonInteractive: true })).toBe('refuse');
  });

  it('asks for confirmation in interactive mode without --yes when files exist', () => {
    expect(decidePresetOverwrite(2, { nonInteractive: false })).toBe('confirm');
  });
});

/**
 * applyAction integration tests.
 *
 * applyAction is not exported, so we drive it through the public `preset`
 * Commander tree (`preset apply <path>`), with a temp preset.json + source
 * files staged in memfs. These exercise the new safety logic added this
 * session: target validation, snapshot-before-overwrite, the non-interactive
 * overwrite refusal, and the --json envelope.
 */
describe('preset apply (integration)', () => {
  const PRESET_DIR = join(TEST_HOME, 'my-preset');

  /**
   * Stage a preset directory in memfs:
   *   <dir>/preset.json + <dir>/<each source file>.
   * Targets default to ~/.config/<n> so they resolve under the test home.
   */
  const stagePreset = (
    files: Array<{ source: string; target: string; template?: boolean; content?: string }>,
    presetName = 'demo'
  ): void => {
    vol.mkdirSync(PRESET_DIR, { recursive: true });
    const preset = {
      name: presetName,
      version: '1.0.0',
      description: 'test preset',
      provides: [
        {
          category: 'agents',
          files: files.map((f) => ({ source: f.source, target: f.target, template: f.template })),
        },
      ],
    };
    vol.writeFileSync(join(PRESET_DIR, 'preset.json'), JSON.stringify(preset));
    for (const f of files) {
      const srcAbs = join(PRESET_DIR, f.source);
      vol.mkdirSync(join(srcAbs, '..'), { recursive: true });
      vol.writeFileSync(srcAbs, f.content ?? `content of ${f.source}`);
    }
  };

  const runApply = async (args: string[]): Promise<void> => {
    const { presetCommand } = await import('../../src/commands/preset.js');
    await presetCommand.parseAsync(['node', 'tuck', 'apply', ...args]);
  };

  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    createPreApplySnapshotMock.mockClear();
    confirmMock.mockClear().mockResolvedValue(true);
    const { setJsonMode, __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
    __resetJsonEmitState();
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  const jsonEnvelope = (): { ok: boolean; command: string; data?: any; error?: any } => {
    const jsonLine = writes.find((w) => w.trim().startsWith('{'));
    return JSON.parse((jsonLine ?? writes.join('')).trim());
  };

  it('writes preset files to disk (fresh targets, no overwrite)', async () => {
    stagePreset([
      { source: 'files/CLAUDE.md', target: '~/.claude/CLAUDE.md', content: 'hello claude' },
      { source: 'files/zshrc', target: '~/.config/zshrc', content: 'export A=1' },
    ]);

    await runApply([PRESET_DIR, '--json']);

    // Files landed under the (mocked) home. Built with resolve() to match
    // resolveWriteTarget's output on both POSIX and Windows (drive-prefixed).
    expect(vol.readFileSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(
      'hello claude'
    );
    expect(vol.readFileSync(resolve(TEST_HOME, '.config', 'zshrc'), 'utf-8')).toBe('export A=1');

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck preset apply');
    expect(env.data.applied).toBe('demo');
    expect(env.data.files).toBe(2);

    // Nothing existed beforehand, so no snapshot is taken.
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('refuses to overwrite in non-interactive json mode without --yes and writes nothing', async () => {
    stagePreset([{ source: 'files/CLAUDE.md', target: '~/.claude/CLAUDE.md', content: 'NEW' }]);
    // Pre-existing target → would be clobbered. resolve() matches the write
    // target production checks via pathExists() (drive-prefixed on Windows).
    vol.mkdirSync(resolve(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'), 'ORIGINAL');

    await expect(runApply([PRESET_DIR, '--json'])).rejects.toMatchObject({
      code: 'PRESET_OVERWRITE_REFUSED',
    });

    // The existing file is untouched and no snapshot/copy occurred.
    expect(vol.readFileSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'), 'utf-8')).toBe('ORIGINAL');
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('overwrites with --yes and snapshots the existing target first', async () => {
    stagePreset([{ source: 'files/CLAUDE.md', target: '~/.claude/CLAUDE.md', content: 'NEW' }]);
    vol.mkdirSync(resolve(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'), 'ORIGINAL');

    await runApply([PRESET_DIR, '--json', '--yes']);

    expect(vol.readFileSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'), 'utf-8')).toBe('NEW');

    // Snapshot taken before the clobber, with the existing target. The target
    // comes from resolveWriteTarget (resolve-based), so the expected value must
    // also use resolve() to match on Windows (drive-prefixed) as well as POSIX.
    expect(createPreApplySnapshotMock).toHaveBeenCalledTimes(1);
    const [snapTargets] = createPreApplySnapshotMock.mock.calls[0] as [string[], string];
    expect(snapTargets).toEqual([resolve(TEST_HOME, '.claude', 'CLAUDE.md')]);

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.data.applied).toBe('demo');
  });

  it('rejects a preset whose target escapes home and writes nothing', async () => {
    stagePreset([{ source: 'files/evil', target: '/etc/cron.d/evil', content: 'x' }]);

    await expect(runApply([PRESET_DIR, '--json'])).rejects.toThrow();

    // Guard runs before any mkdir/write — the unsafe destination never appears.
    expect(vol.existsSync('/etc/cron.d/evil')).toBe(false);
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('--plan in json mode emits the plan and writes nothing to disk', async () => {
    stagePreset([{ source: 'files/CLAUDE.md', target: '~/.claude/CLAUDE.md', content: 'planme' }]);

    await runApply([PRESET_DIR, '--json', '--plan']);

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.data.preset).toBe('demo');
    expect(Array.isArray(env.data.plan)).toBe(true);
    // plan target is resolveWriteTarget output (resolve-based) — match with resolve().
    expect(env.data.plan[0].target).toBe(resolve(TEST_HOME, '.claude', 'CLAUDE.md'));

    // Plan is read-only: target not written, no snapshot.
    expect(vol.existsSync(resolve(TEST_HOME, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    "applies the preset file's declared permissions to the written target",
    async () => {
      // Stage a preset whose (non-template) file declares a hardened mode, like
      // an SSH/credential config. The permissions field was parsed but never
      // chmod'd, so the hardening was silently dropped.
      vol.mkdirSync(PRESET_DIR, { recursive: true });
      vol.writeFileSync(
        join(PRESET_DIR, 'preset.json'),
        JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          description: 'test preset',
          provides: [
            {
              category: 'ssh',
              files: [{ source: 'files/config', target: '~/.ssh/config', permissions: '600' }],
            },
          ],
        })
      );
      vol.mkdirSync(join(PRESET_DIR, 'files'), { recursive: true });
      vol.writeFileSync(join(PRESET_DIR, 'files', 'config'), 'Host *\n');

      // Call applyAction directly with a clean opts object — the shared
      // Commander `apply` subcommand leaks boolean option state (e.g. --plan)
      // across parseAsync calls, which would otherwise divert this run.
      await applyAction(PRESET_DIR, { yes: true });

      const target = resolve(TEST_HOME, '.ssh', 'config');
      expect(vol.existsSync(target)).toBe(true);
      const mode = vol.statSync(target).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    }
  );
});

/**
 * preset translate — cross-agent instructions translation (IDEAS 1.8 v1).
 *
 * translateAction materializes one canonical instructions file into each
 * agent's global instruction path. It reuses the same safety machinery as
 * `preset apply` (home-confined targets, snapshot + overwrite refusal), so the
 * tests focus on the fan-out, the self-target skip, and the refusal path.
 */
describe('preset translate', () => {
  const SOURCE = join(TEST_HOME, 'canonical-instructions.md');
  const CLAUDE = resolve(TEST_HOME, '.claude', 'CLAUDE.md');
  const CODEX = resolve(TEST_HOME, '.codex', 'AGENTS.md');

  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    createPreApplySnapshotMock.mockClear();
    confirmMock.mockClear().mockResolvedValue(true);
    const { setJsonMode, __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
    __resetJsonEmitState();
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  const jsonEnvelope = (): { ok: boolean; command: string; data?: any; error?: any } => {
    const jsonLine = writes.find((w) => w.trim().startsWith('{'));
    return JSON.parse((jsonLine ?? writes.join('')).trim());
  };

  it('materializes the canonical file for both default agents (claude + codex)', async () => {
    vol.writeFileSync(SOURCE, '# my canonical rules');

    await translateAction(SOURCE, { json: true, yes: true });

    expect(vol.readFileSync(CLAUDE, 'utf-8')).toBe('# my canonical rules');
    expect(vol.readFileSync(CODEX, 'utf-8')).toBe('# my canonical rules');

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck preset translate');
    expect(env.data.translated).toBe(2);
    // Fresh targets → no snapshot.
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('skips the target that is the source itself', async () => {
    // Source IS Claude's instruction file → only Codex should be written.
    vol.mkdirSync(resolve(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(CLAUDE, '# claude rules');

    await translateAction(CLAUDE, { json: true, yes: true });

    const env = jsonEnvelope();
    expect(env.data.translated).toBe(1);
    expect(vol.readFileSync(CODEX, 'utf-8')).toBe('# claude rules');
  });

  it('skips a target that is a symlink resolving to the source (no circular symlink)', async () => {
    // User previously ran `ln -s ~/.codex/AGENTS.md ~/.claude/CLAUDE.md`, then
    // translates from the Claude path. The Codex target is the real file that
    // the Claude symlink points at. A lexical compare misses this; with --link
    // the old code would rm the real AGENTS.md and create a circular symlink,
    // leaving both files unreadable. The realpath guard must skip Codex.
    vol.mkdirSync(resolve(TEST_HOME, '.codex'), { recursive: true });
    vol.mkdirSync(resolve(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(CODEX, '# canonical rules');
    vol.symlinkSync(CODEX, CLAUDE);

    await translateAction(CLAUDE, { json: true, yes: true, link: true });

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    // Nothing to translate: both requested targets resolve to the one file.
    expect(env.data.translated).toBe(0);
    // The real source survives with its content intact (not rm'd).
    expect(vol.readFileSync(CODEX, 'utf-8')).toBe('# canonical rules');
    // The Claude symlink still points at the real file (readable, no ELOOP).
    expect(vol.readFileSync(CLAUDE, 'utf-8')).toBe('# canonical rules');
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('refuses to overwrite non-interactively without --yes and writes nothing', async () => {
    vol.writeFileSync(SOURCE, 'NEW');
    vol.mkdirSync(resolve(TEST_HOME, '.codex'), { recursive: true });
    vol.writeFileSync(CODEX, 'ORIGINAL');

    await expect(translateAction(SOURCE, { json: true })).rejects.toMatchObject({
      code: 'PRESET_OVERWRITE_REFUSED',
    });

    // Existing untouched; the fresh Claude target never got created either.
    expect(vol.readFileSync(CODEX, 'utf-8')).toBe('ORIGINAL');
    expect(vol.existsSync(CLAUDE)).toBe(false);
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
  });

  it('overwrites with --yes and snapshots the existing target first', async () => {
    vol.writeFileSync(SOURCE, 'NEW');
    vol.mkdirSync(resolve(TEST_HOME, '.codex'), { recursive: true });
    vol.writeFileSync(CODEX, 'ORIGINAL');

    await translateAction(SOURCE, { json: true, yes: true });

    expect(vol.readFileSync(CODEX, 'utf-8')).toBe('NEW');
    expect(createPreApplySnapshotMock).toHaveBeenCalledTimes(1);
    const [snapTargets] = createPreApplySnapshotMock.mock.calls[0] as [string[], string];
    expect(snapTargets).toEqual([CODEX]);
  });

  it('--plan emits the plan and writes nothing', async () => {
    vol.writeFileSync(SOURCE, 'planme');

    await translateAction(SOURCE, { json: true, plan: true });

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data.plan)).toBe(true);
    expect(env.data.plan.length).toBe(2);
    expect(vol.existsSync(CLAUDE)).toBe(false);
    expect(vol.existsSync(CODEX)).toBe(false);
  });

  it('rejects an unknown target agent', async () => {
    vol.writeFileSync(SOURCE, 'x');
    await expect(
      translateAction(SOURCE, { to: 'claude-code,bogus', json: true, yes: true })
    ).rejects.toMatchObject({ code: 'UNKNOWN_TRANSLATION_TARGET' });
  });

  it('errors when no source is given and no canonical file exists', async () => {
    await expect(translateAction(undefined, { json: true, yes: true })).rejects.toMatchObject({
      code: 'PRESET_SOURCE_MISSING',
    });
  });
});

describe('bundledRegistryDir', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('returns the first candidate that exists rather than always candidates[0]', () => {
    // <repoRoot>/src/templates/presets — the second candidate, which is what the
    // published (dist) build actually resolves to. candidates[0] resolves outside
    // the package there and does not exist.
    const secondCandidate = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/templates/presets'
    );
    vol.mkdirSync(secondCandidate, { recursive: true });

    expect(bundledRegistryDir()).toBe(secondCandidate);
  });
});
