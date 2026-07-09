import { Command } from 'commander';
import chalk from 'chalk';
import {
  initCommand,
  addCommand,
  removeCommand,
  syncCommand,
  pushCommand,
  pullCommand,
  restoreCommand,
  statusCommand,
  listCommand,
  diffCommand,
  configCommand,
  applyCommand,
  undoCommand,
  scanCommand,
  secretsCommand,
  encryptionCommand,
  doctorCommand,
  bundleCommand,
  verifyCommand,
} from './commands/index.js';
import { handleError } from './errors.js';
import { VERSION, DESCRIPTION } from './constants.js';
import { checkForUpdates } from './lib/updater.js';
import { customHelp, miniBanner } from './ui/banner.js';
import { getTuckDir, pathExists } from './lib/paths.js';
import { loadManifest } from './lib/manifest.js';
import { getStatus } from './lib/git.js';
import { setJsonMode, isJsonMode, emitJsonOk } from './lib/jsonOutput.js';
import { setNonInteractive, configureColor } from './lib/agentMode.js';
import { buildCommandPath } from './lib/commandPath.js';
import { setWriteContext } from './lib/writeContext.js';
import { expandPath as expandTuckPath } from './lib/paths.js';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import { contextCommand } from './commands/context.js';
import { mcpCommand } from './commands/mcp.js';
import { presetCommand } from './commands/preset.js';
import { repoCommand } from './commands/repo.js';

const program = new Command();

program
  .name('tuck')
  .description(DESCRIPTION)
  .version(VERSION, '-v, --version', 'Display version number')
  .option(
    '--root <dir>',
    'Confine ALL writes under this directory (sandbox / dry-home mode). ' +
      'Also settable via TUCK_TARGET_ROOT. Use to run tuck without touching your real ~.'
  )
  .option(
    '--non-interactive',
    'Never prompt; fail fast with a typed error if a prompt would be required. ' +
      'Implied by --json and by a non-TTY stdin. Pair with --yes to auto-confirm.'
  )
  .configureOutput({
    outputError: (str, write) => write(chalk.red(str)),
  })
  .addHelpText('before', customHelp(VERSION))
  .helpOption('-h, --help', 'Display this help message')
  .showHelpAfterError(false);

// Register commands
program.addCommand(initCommand);
program.addCommand(addCommand);
program.addCommand(removeCommand);
program.addCommand(syncCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(restoreCommand);
program.addCommand(statusCommand);
program.addCommand(listCommand);
program.addCommand(diffCommand);
program.addCommand(configCommand);
program.addCommand(applyCommand);
program.addCommand(undoCommand);
program.addCommand(scanCommand);
program.addCommand(secretsCommand);
program.addCommand(encryptionCommand);
program.addCommand(doctorCommand);
program.addCommand(bundleCommand);
program.addCommand(verifyCommand);
program.addCommand(contextCommand);
program.addCommand(mcpCommand);
program.addCommand(presetCommand);
program.addCommand(repoCommand);

// Best-effort EARLY detection so the error handler can emit JSON even for
// failures that occur before any command action runs (e.g. during parsing).
// This is intentionally conservative (flag presence only, no command-name
// guess); the authoritative value comes from the preAction hook below, which
// reads the PARSED options and the full command path. This fixes the previous
// heuristic that mis-fired when `--json` appeared as an option *value*
// (e.g. `tuck add --message --json`) and mis-named subcommands.
if (process.argv.slice(2).includes('--json')) {
  setJsonMode(true);
}
// The `--non-interactive` global is a bare flag (no value), so a plain argv scan
// is unambiguous — mirroring the early `--json` detection above. This ensures the
// prompt gate and color suppression are honored even for failures that occur
// before any command action runs (e.g. during parsing).
if (process.argv.slice(2).includes('--non-interactive')) {
  setNonInteractive(true);
}
// Suppress ANSI for machine consumers / non-TTY stdout as early as possible so
// even pre-action diagnostics come out clean. Re-run authoritatively in preAction.
configureColor();

// Authoritative resolution of JSON mode AND the write sandbox: runs after
// parsing, before the action. Global --root / --non-interactive live on the root program.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand.opts() as { json?: boolean };
  setJsonMode(opts.json === true, buildCommandPath(actionCommand as { name(): string }));

  const globalOpts = program.opts() as { nonInteractive?: boolean };
  if (globalOpts.nonInteractive === true) setNonInteractive(true);
  // Options are now authoritative (JSON mode may have been set by opts above),
  // so recompute color suppression.
  configureColor();

  const rootOpt = (program.opts() as { root?: string }).root ?? process.env.TUCK_TARGET_ROOT;
  if (rootOpt && rootOpt.trim()) {
    const root = resolvePath(expandTuckPath(rootOpt.trim()));
    setWriteContext({ root, isSandbox: root !== resolvePath(homedir()) });
  }
});

// Default action when no command is provided
const runDefaultAction = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  // Check if tuck is initialized
  if (!(await pathExists(tuckDir))) {
    if (isJsonMode()) {
      emitJsonOk({ initialized: false, trackedCount: 0, pendingChanges: 0, ahead: 0 }, 'tuck');
      return;
    }
    miniBanner();
    console.log(chalk.bold('Get started with tuck:\n'));
    console.log(chalk.cyan('  tuck init') + chalk.dim('   - Set up tuck and create a GitHub repo'));
    console.log(chalk.cyan('  tuck scan') + chalk.dim('   - Find dotfiles to track'));
    console.log();
    console.log(chalk.dim('On a new machine:'));
    console.log(chalk.cyan('  tuck apply <username>') + chalk.dim(' - Apply your dotfiles'));
    console.log();
    return;
  }

  // Load manifest to check status
  try {
    const manifest = await loadManifest(tuckDir);
    const trackedCount = Object.keys(manifest.files).length;
    const gitStatus = await getStatus(tuckDir);
    const pendingChanges = gitStatus.modified.length + gitStatus.staged.length;

    if (isJsonMode()) {
      emitJsonOk(
        { initialized: true, trackedCount, pendingChanges, ahead: gitStatus.ahead },
        'tuck'
      );
      return;
    }

    miniBanner();
    console.log(chalk.bold('Status:\n'));

    // Show tracked files count
    console.log(`  Tracked files: ${chalk.cyan(trackedCount.toString())}`);

    // Show git status
    if (pendingChanges > 0) {
      console.log(`  Pending changes: ${chalk.yellow(pendingChanges.toString())}`);
    } else {
      console.log(`  Pending changes: ${chalk.dim('none')}`);
    }

    // Show remote status
    if (gitStatus.ahead > 0) {
      console.log(`  Commits to push: ${chalk.yellow(gitStatus.ahead.toString())}`);
    }

    console.log();

    // Show what to do next
    console.log(chalk.bold('Next steps:\n'));

    if (trackedCount === 0) {
      console.log(chalk.cyan('  tuck scan') + chalk.dim('  - Find dotfiles to track'));
      console.log(chalk.cyan('  tuck add <file>') + chalk.dim(' - Track a specific file'));
    } else if (pendingChanges > 0) {
      console.log(chalk.cyan('  tuck sync') + chalk.dim('  - Commit and push your changes'));
      console.log(chalk.cyan('  tuck diff') + chalk.dim('  - Preview what changed'));
    } else if (gitStatus.ahead > 0) {
      console.log(chalk.cyan('  tuck push') + chalk.dim('  - Push commits to GitHub'));
    } else {
      console.log(chalk.dim('  All synced! Your dotfiles are up to date.'));
      console.log();
      console.log(chalk.cyan('  tuck scan') + chalk.dim('  - Find more dotfiles to track'));
      console.log(chalk.cyan('  tuck list') + chalk.dim('  - See tracked files'));
    }

    console.log();
  } catch {
    if (isJsonMode()) {
      emitJsonOk(
        { initialized: true, corrupted: true, trackedCount: 0, pendingChanges: 0, ahead: 0 },
        'tuck'
      );
      return;
    }
    // Manifest load failed, treat as not initialized
    miniBanner();
    console.log(chalk.yellow('Tuck directory exists but may be corrupted.'));
    console.log(chalk.dim('Run `tuck init` to reinitialize.'));
    console.log();
  }
};

// Apply the global --root / TUCK_TARGET_ROOT sandbox for the no-subcommand path,
// which never reaches the preAction hook (that only fires for a command action).
// Reads the option value from argv so `tuck --root <dir>` confines writes even
// when just showing the dashboard. Mirrors the preAction hook's root logic.
const applyGlobalRootFromArgv = (): void => {
  const argv = process.argv.slice(2);
  let rootOpt: string | undefined;
  const idx = argv.indexOf('--root');
  if (idx !== -1 && argv[idx + 1]) rootOpt = argv[idx + 1];
  const eq = argv.find((a) => a.startsWith('--root='));
  if (eq) rootOpt = eq.slice('--root='.length);
  rootOpt = rootOpt ?? process.env.TUCK_TARGET_ROOT;
  if (rootOpt && rootOpt.trim()) {
    const root = resolvePath(expandTuckPath(rootOpt.trim()));
    setWriteContext({ root, isSandbox: root !== resolvePath(homedir()) });
  }
};

// A bare invocation is one with NO registered subcommand token. Matching against
// the actual command names/aliases (instead of "any non-dash arg") means a
// global option VALUE like `--root /dir` is no longer mistaken for a command —
// which previously forced parseAsync and printed help + exit 1.
const knownCommandTokens = new Set<string>();
for (const cmd of program.commands) {
  knownCommandTokens.add(cmd.name());
  for (const alias of cmd.aliases()) knownCommandTokens.add(alias);
}
const hasCommand = process.argv.slice(2).some((arg) => knownCommandTokens.has(arg));

// Global error handling
process.on('uncaughtException', handleError);
process.on('unhandledRejection', (reason) => {
  handleError(reason instanceof Error ? reason : new Error(String(reason)));
});

// Check if this is a help or version request (skip update check for these)
const isHelpOrVersion =
  process.argv.includes('--help') ||
  process.argv.includes('-h') ||
  process.argv.includes('--version') ||
  process.argv.includes('-v');

// `tuck mcp ...` is an agent-facing transport (stdio JSON-RPC): the update-check
// banner/prompt would corrupt the stream and its readline could consume the
// first request line, so skip it here just like --json.
const isMcpCommand = process.argv.slice(2).includes('mcp');

// Main execution
const main = async (): Promise<void> => {
  // Check for updates (skipped for help/version, MCP, and JSON/agent mode — the
  // update banner is human-only and would corrupt structured output).
  if (!isHelpOrVersion && !isMcpCommand && !process.argv.includes('--json')) {
    await checkForUpdates();
  }

  // No subcommand → the status dashboard. Handle it directly (not via parseAsync)
  // so an undeclared root --json is not an "unknown option" error: JSON mode is
  // already set by the early argv check above, and runDefaultAction honors it.
  if (!hasCommand && !isHelpOrVersion) {
    applyGlobalRootFromArgv();
    await runDefaultAction();
  } else {
    await program.parseAsync(process.argv);
  }
};

main().catch(handleError);
