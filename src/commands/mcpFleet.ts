/**
 * `tuck mcp` fleet subcommands — declare MCP servers once, render per client.
 *
 * The fleet lives in `mcp-servers.json` inside the tuck repo (git-versioned,
 * secret-free — it only holds `{{PLACEHOLDER}}` references). These subcommands
 * manage that file and project it into each MCP client's native config format,
 * injecting credentials from tuck's secret backends at apply time.
 *
 *   add / list / remove / show   — manage server definitions
 *   clients                       — list supported clients + config paths
 *   render                        — preview rendered client configs (read-only)
 *   apply                         — write rendered configs into client files
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { prompts, logger, colors as c } from '../ui/index.js';
import { getTuckDir, collapsePath, pathExists } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { loadConfig } from '../lib/config.js';
import { createResolver } from '../lib/secretBackends/index.js';
import { createBackup } from '../lib/backup.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { NotInitializedError, TuckError } from '../errors.js';
import {
  loadFleet,
  setServer,
  removeServer,
  getServer,
  listClients,
  clientDisplayName,
  resolveClientConfigPath,
  collectServerPlaceholders,
  serverTargetsClient,
  renderClient,
  mergeClientConfig,
} from '../lib/mcp/index.js';
import {
  MCP_CLIENT_IDS,
  MCP_SERVER_NAME_RE,
  mcpClientIdSchema,
  mcpTransportSchema,
  type McpClientId,
  type McpServerInput,
  type McpServerOutput,
} from '../schemas/mcpServers.schema.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ensureInitialized = async (): Promise<string> => {
  const tuckDir = getTuckDir();
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
  return tuckDir;
};

const interactive = (): boolean => Boolean(process.stdout.isTTY) && !isJsonMode();

/**
 * Parse repeated `KEY=VALUE` flags into a record, rejecting malformed pairs.
 *
 * Shared canonical implementation used by `tuck mcp add` (`--env`/`--header`)
 * and `tuck rules track` (`--var`); callers supply their own error framing so
 * the thrown message/code/suggestions stay identical to the pre-dedup behavior.
 */
export const parseKeyValuePairs = (
  pairs: string[] | undefined,
  opts: {
    /** Build the error message for the offending, malformed pair. */
    message: (pair: string) => string;
    /** TuckError code to raise on a malformed pair. */
    errorCode: string;
    /** Optional resolution hints attached to the thrown error. */
    suggestions?: string[];
    /** Trim surrounding whitespace from the parsed key. */
    trimKey?: boolean;
  }
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new TuckError(opts.message(pair), opts.errorCode, opts.suggestions);
    }
    const key = opts.trimKey ? pair.slice(0, eq).trim() : pair.slice(0, eq);
    out[key] = pair.slice(eq + 1);
  }
  return out;
};

/** Parse repeated `KEY=VALUE` flags into a record, rejecting malformed pairs. */
const parseKeyValues = (pairs: string[] | undefined, flag: string): Record<string, string> =>
  parseKeyValuePairs(pairs, {
    message: (pair) => `Invalid ${flag} value: "${pair}"`,
    errorCode: 'MCP_ARG_INVALID',
    suggestions: [`Use ${flag} KEY=VALUE (e.g. ${flag} API_KEY={{OPENAI_KEY}}).`],
  });

const parseClients = (values: string[] | undefined): McpClientId[] => {
  const out: McpClientId[] = [];
  for (const value of values ?? []) {
    const parsed = mcpClientIdSchema.safeParse(value);
    if (!parsed.success) {
      throw new TuckError(
        `Unknown MCP client: "${value}"`,
        'MCP_CLIENT_UNKNOWN',
        [`Supported clients: ${MCP_CLIENT_IDS.join(', ')}.`]
      );
    }
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
};

const validateServerName = (name: string): void => {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    throw new TuckError(
      `Invalid MCP server name: "${name}"`,
      'MCP_SERVER_NAME_INVALID',
      ['Names may only contain letters, digits, dot, dash, and underscore.']
    );
  }
};

const targetsSummary = (server: McpServerOutput): string =>
  server.clients.length === 0 ? 'all clients' : server.clients.join(', ');

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

interface AddOptions {
  transport?: string;
  command?: string;
  arg?: string[];
  env?: string[];
  url?: string;
  header?: string[];
  client?: string[];
  description?: string;
  disabled?: boolean;
  json?: boolean;
}

export const addAction = async (name: string, opts: AddOptions): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp add');
  const tuckDir = await ensureInitialized();
  validateServerName(name);

  const transportParsed = mcpTransportSchema.safeParse(opts.transport ?? 'stdio');
  if (!transportParsed.success) {
    throw new TuckError(
      `Invalid transport: "${opts.transport}"`,
      'MCP_TRANSPORT_INVALID',
      ['Supported transports: stdio, http, sse.']
    );
  }
  const transport = transportParsed.data;

  let command = opts.command;
  let url = opts.url;

  // Fill required fields interactively when running in a TTY.
  if (transport === 'stdio' && !command && interactive()) {
    command = (await prompts.text('Command to run (e.g. npx)', { placeholder: 'npx' })).trim();
  }
  if (transport !== 'stdio' && !url && interactive()) {
    url = (await prompts.text('Server URL', { placeholder: 'https://' })).trim();
  }

  const definition: McpServerInput = {
    transport,
    args: opts.arg ?? [],
    env: parseKeyValues(opts.env, '--env'),
    headers: parseKeyValues(opts.header, '--header'),
    clients: parseClients(opts.client),
    enabled: !opts.disabled,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };

  const { existed, server } = await setServer(tuckDir, name, definition);
  const placeholders = collectServerPlaceholders(server);

  if (isJsonMode()) {
    emitJsonOk({ name, created: !existed, server, placeholders });
    return;
  }

  logger.success(
    `${existed ? 'Updated' : 'Added'} MCP server ${c.cyan(name)} (${server.transport}, → ${targetsSummary(server)})`
  );
  if (placeholders.length > 0) {
    logger.info(
      `References secret${placeholders.length === 1 ? '' : 's'}: ${placeholders.map((p) => c.yellow(p)).join(', ')}`
    );
  }
  logger.info(`Run ${c.cyan('tuck mcp apply')} to write it into your clients.`);
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp list');
  const tuckDir = await ensureInitialized();
  const fleet = await loadFleet(tuckDir);
  const entries = Object.entries(fleet.servers);

  if (isJsonMode()) {
    emitJsonOk({
      count: entries.length,
      servers: entries.map(([name, server]) => ({
        name,
        transport: server.transport,
        enabled: server.enabled,
        clients: server.clients,
        placeholders: collectServerPlaceholders(server),
      })),
    });
    return;
  }

  if (entries.length === 0) {
    logger.info('No MCP servers defined. Add one with `tuck mcp add <name>`.');
    return;
  }

  console.log();
  console.log(c.bold('MCP fleet:'));
  for (const [name, server] of entries) {
    const status = server.enabled ? '' : c.dim(' (disabled)');
    const target =
      server.transport === 'stdio' ? server.command ?? '' : server.url ?? '';
    console.log(
      `  ${c.cyan(name.padEnd(20))} ${c.dim(server.transport.padEnd(6))} ${target}${status}`
    );
    console.log(`    ${c.dim(`→ ${targetsSummary(server)}`)}`);
  }
  console.log();
};

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export const removeAction = async (
  name: string,
  opts: { json?: boolean; force?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp remove');
  const tuckDir = await ensureInitialized();

  const server = await getServer(tuckDir, name);
  if (!server) {
    throw new TuckError(`MCP server not found: ${name}`, 'MCP_SERVER_NOT_FOUND');
  }

  if (!opts.force && interactive()) {
    const confirmed = await prompts.confirm(`Remove MCP server "${name}" from the fleet?`, false);
    if (!confirmed) {
      logger.info('Cancelled.');
      return;
    }
  }

  await removeServer(tuckDir, name);

  if (isJsonMode()) {
    emitJsonOk({ removed: name });
    return;
  }
  logger.success(`Removed MCP server ${c.cyan(name)} from the fleet.`);
  logger.info(
    `Existing client configs are untouched; edit or re-run ${c.cyan('tuck mcp apply')} as needed.`
  );
};

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export const showAction = async (name: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp show');
  const tuckDir = await ensureInitialized();

  const server = await getServer(tuckDir, name);
  if (!server) {
    throw new TuckError(`MCP server not found: ${name}`, 'MCP_SERVER_NOT_FOUND');
  }

  const targets = listClients()
    .filter((client) => serverTargetsClient(server, client.id))
    .map((client) => ({
      id: client.id,
      displayName: client.displayName,
      configPath: collapsePath(resolveClientConfigPath(client.id)),
    }));
  const placeholders = collectServerPlaceholders(server);

  if (isJsonMode()) {
    emitJsonOk({ name, server, targets, placeholders });
    return;
  }

  console.log();
  console.log(c.bold(`MCP server: ${c.cyan(name)}`));
  console.log(`  transport   ${server.transport}`);
  if (server.command) console.log(`  command     ${server.command} ${server.args.join(' ')}`);
  if (server.url) console.log(`  url         ${server.url}`);
  if (server.description) console.log(`  description ${server.description}`);
  if (Object.keys(server.env).length > 0) {
    console.log(`  env         ${Object.keys(server.env).join(', ')}`);
  }
  if (placeholders.length > 0) {
    console.log(`  secrets     ${placeholders.map((p) => c.yellow(p)).join(', ')}`);
  }
  console.log(`  enabled     ${server.enabled}`);
  console.log();
  console.log(c.bold('  Renders to:'));
  for (const t of targets) {
    console.log(`    ${c.cyan(t.displayName.padEnd(16))} ${c.dim(t.configPath)}`);
  }
  console.log();
};

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------

export const clientsAction = (opts: { json?: boolean }): void => {
  if (opts.json) setJsonMode(true, 'tuck mcp clients');
  const clients = listClients().map((client) => ({
    id: client.id,
    displayName: client.displayName,
    configPath: collapsePath(resolveClientConfigPath(client.id)),
  }));

  if (isJsonMode()) {
    emitJsonOk({ clients });
    return;
  }

  console.log();
  console.log(c.bold('Supported MCP clients:'));
  for (const client of clients) {
    console.log(`  ${c.cyan(client.displayName.padEnd(16))} ${c.dim(client.configPath)}`);
  }
  console.log();
};

// ---------------------------------------------------------------------------
// secret resolution shared by render/apply
// ---------------------------------------------------------------------------

/** Resolve the union of placeholders used by servers targeting `clients`. */
const resolveFleetSecrets = async (
  tuckDir: string,
  fleet: Awaited<ReturnType<typeof loadFleet>>,
  clients: McpClientId[],
  failOnAuthRequired: boolean
): Promise<Record<string, string>> => {
  const names = new Set<string>();
  for (const server of Object.values(fleet.servers)) {
    const targeted = clients.some((client) => serverTargetsClient(server, client));
    if (!targeted) continue;
    for (const placeholder of collectServerPlaceholders(server)) names.add(placeholder);
  }
  if (names.size === 0) return {};

  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);
  try {
    return await resolver.resolveToMap([...names], { failOnAuthRequired });
  } finally {
    await resolver.lockAll();
  }
};

const resolveTargetClients = (clientOpt: string[] | undefined): McpClientId[] =>
  clientOpt && clientOpt.length > 0 ? parseClients(clientOpt) : [...MCP_CLIENT_IDS];

// ---------------------------------------------------------------------------
// render (read-only preview)
// ---------------------------------------------------------------------------

export const renderAction = async (opts: {
  client?: string[];
  withSecrets?: boolean;
  json?: boolean;
}): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp render');
  const tuckDir = await ensureInitialized();
  const fleet = await loadFleet(tuckDir);
  const clients = resolveTargetClients(opts.client);

  // By default placeholders are left verbatim so no secret is ever printed.
  const secrets = opts.withSecrets
    ? await resolveFleetSecrets(tuckDir, fleet, clients, !interactive())
    : {};

  const outputs = clients.map((client) => {
    const result = renderClient(fleet, client, secrets);
    const container: Record<string, unknown> = {};
    for (const { name, entry } of result.rendered) container[name] = entry;
    return {
      client,
      displayName: clientDisplayName(client),
      configPath: collapsePath(resolveClientConfigPath(client)),
      containerKey: result.containerKey,
      config: { [result.containerKey]: container },
      unsupported: result.unsupported,
      unresolved: result.unresolved,
    };
  });

  if (isJsonMode()) {
    emitJsonOk({ withSecrets: Boolean(opts.withSecrets), clients: outputs });
    return;
  }

  for (const out of outputs) {
    console.log();
    console.log(`${c.bold(out.displayName)} ${c.dim(out.configPath)}`);
    console.log(JSON.stringify(out.config, null, 2));
    if (out.unsupported.length > 0) {
      logger.warning(
        `Skipped (unsupported transport for ${out.displayName}): ${out.unsupported.join(', ')}`
      );
    }
    if (out.unresolved.length > 0 && opts.withSecrets) {
      logger.warning(`Unresolved secrets: ${out.unresolved.join(', ')}`);
    }
  }
  console.log();
};

// ---------------------------------------------------------------------------
// apply (writes client configs)
// ---------------------------------------------------------------------------

/** Read a client's existing config, refusing to clobber unparseable JSON. */
const readExistingClientConfig = async (
  configPath: string
): Promise<Record<string, unknown> | undefined> => {
  if (!(await pathExists(configPath))) return undefined;
  const text = await readFile(configPath, 'utf-8');
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TuckError(
      `Existing client config is not valid JSON: ${collapsePath(configPath)}`,
      'MCP_CLIENT_CONFIG_INVALID',
      [
        `Fix or move ${collapsePath(configPath)} before applying.`,
        error instanceof Error ? error.message : String(error),
      ]
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TuckError(
      `Existing client config is not a JSON object: ${collapsePath(configPath)}`,
      'MCP_CLIENT_CONFIG_INVALID'
    );
  }
  return parsed as Record<string, unknown>;
};

interface ApplyOptions {
  client?: string[];
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ApplyClientPlan {
  client: McpClientId;
  displayName: string;
  configPath: string;
  serverCount: number;
  serverNames: string[];
  unsupported: string[];
  wouldWrite: boolean;
}

export const applyAction = async (opts: ApplyOptions): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck mcp apply');
  const tuckDir = await ensureInitialized();
  const fleet = await loadFleet(tuckDir);

  if (Object.keys(fleet.servers).length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ applied: [], dryRun: Boolean(opts.dryRun), skipped: 'no-servers' });
      return;
    }
    logger.info('No MCP servers defined. Add one with `tuck mcp add <name>`.');
    return;
  }

  const clients = resolveTargetClients(opts.client);
  const secrets = await resolveFleetSecrets(tuckDir, fleet, clients, opts.json || opts.yes || !interactive());

  // Build the plan first (pure), so we can confirm before writing anything.
  const plans: ApplyClientPlan[] = [];
  const pendingWrites: { path: string; content: string; client: McpClientId }[] = [];
  const allUnresolved = new Set<string>();

  for (const client of clients) {
    const result = renderClient(fleet, client, secrets);
    for (const u of result.unresolved) allUnresolved.add(u);
    const configPath = resolveClientConfigPath(client);

    if (result.rendered.length > 0) {
      const existing = await readExistingClientConfig(configPath);
      const merged = mergeClientConfig(existing, result.containerKey, result.rendered);
      pendingWrites.push({
        path: configPath,
        content: JSON.stringify(merged, null, 2) + '\n',
        client,
      });
    }

    plans.push({
      client,
      displayName: clientDisplayName(client),
      configPath: collapsePath(configPath),
      serverCount: result.rendered.length,
      serverNames: result.rendered.map((r) => r.name),
      unsupported: result.unsupported,
      wouldWrite: result.rendered.length > 0,
    });
  }

  // Never write a config that still contains an unresolved credential.
  if (allUnresolved.size > 0) {
    throw new TuckError(
      `Cannot apply: unresolved secret${allUnresolved.size === 1 ? '' : 's'}: ${[...allUnresolved].join(', ')}`,
      'MCP_SECRETS_UNRESOLVED',
      [
        'Map the placeholder(s) with `tuck secrets` / your secret backend, then retry.',
        'Or edit the server definition to remove the reference.',
      ]
    );
  }

  const writeCount = pendingWrites.length;

  if (opts.dryRun) {
    if (isJsonMode()) {
      emitJsonOk({ dryRun: true, plans });
      return;
    }
    console.log();
    console.log(c.bold('tuck mcp apply — dry run'));
    for (const plan of plans) {
      const detail =
        plan.serverCount > 0
          ? c.green(`${plan.serverCount} server${plan.serverCount === 1 ? '' : 's'}`)
          : c.dim('nothing to write');
      console.log(`  ${c.cyan(plan.displayName.padEnd(16))} ${detail} ${c.dim(plan.configPath)}`);
      if (plan.unsupported.length > 0) {
        console.log(`    ${c.dim(`skipped: ${plan.unsupported.join(', ')}`)}`);
      }
    }
    console.log();
    return;
  }

  if (writeCount === 0) {
    if (isJsonMode()) {
      emitJsonOk({ applied: [], dryRun: false });
      return;
    }
    logger.info('Nothing to apply — no servers target the selected clients.');
    return;
  }

  // Confirm before mutating real client files (skipped for --yes / --json / non-TTY).
  if (!opts.yes && interactive()) {
    console.log();
    console.log(c.bold('About to update these client configs:'));
    for (const plan of plans.filter((p) => p.wouldWrite)) {
      console.log(
        `  ${c.cyan(plan.displayName.padEnd(16))} ${c.dim(plan.configPath)} (${plan.serverNames.join(', ')})`
      );
    }
    const confirmed = await prompts.confirm(
      `Update ${writeCount} client config${writeCount === 1 ? '' : 's'}? Existing files are backed up first.`,
      false
    );
    if (!confirmed) {
      logger.info('Cancelled. No files were changed.');
      return;
    }
  }

  // Write each config: back up any existing file, ensure the dir, then write.
  const applied: { client: McpClientId; configPath: string; backup?: string }[] = [];
  for (const write of pendingWrites) {
    let backupPath: string | undefined;
    if (await pathExists(write.path)) {
      const backup = await createBackup(write.path, undefined, tuckDir);
      backupPath = backup.backupPath;
    }
    await mkdir(dirname(write.path), { recursive: true });
    await writeFile(write.path, write.content, 'utf-8');
    applied.push({
      client: write.client,
      configPath: collapsePath(write.path),
      ...(backupPath ? { backup: collapsePath(backupPath) } : {}),
    });
  }

  if (isJsonMode()) {
    emitJsonOk({ dryRun: false, applied });
    return;
  }

  logger.success(
    `Applied MCP fleet to ${applied.length} client${applied.length === 1 ? '' : 's'}.`
  );
  for (const entry of applied) {
    console.log(`  ${c.green('✓')} ${c.cyan(clientDisplayName(entry.client))} ${c.dim(entry.configPath)}`);
  }
  const skipped = plans.filter((p) => p.unsupported.length > 0);
  for (const plan of skipped) {
    logger.info(`${plan.displayName}: skipped ${plan.unsupported.join(', ')} (unsupported transport)`);
  }
};

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

/**
 * Fleet subcommands, added to the top-level `tuck mcp` command in mcp.ts so the
 * whole MCP surface (serve/tools + fleet) lives under one namespace.
 */
export const mcpFleetCommands: Command[] = [
  new Command('add')
    .description('Add or update an MCP server definition in the fleet')
    .argument('<name>', 'Server name (unique within the fleet)')
    .option('-t, --transport <kind>', 'Transport: stdio | http | sse', 'stdio')
    .option('-c, --command <cmd>', 'Executable for a stdio server (e.g. npx)')
    .option('-a, --arg <value>', 'Argument for the command (repeatable)', collect, [])
    .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable); value may hold {{SECRET}}', collect, [])
    .option('-u, --url <url>', 'Endpoint URL for an http/sse server')
    .option('-H, --header <KEY=VALUE>', 'HTTP header (repeatable); value may hold {{SECRET}}', collect, [])
    .option('--client <id>', 'Restrict to a client (repeatable); default: all', collect, [])
    .option('-d, --description <text>', 'Human-readable description')
    .option('--disabled', 'Add the server but skip it on apply')
    .option('--json', 'Emit JSON envelope')
    .action(addAction),

  new Command('list')
    .alias('ls')
    .description('List MCP server definitions in the fleet')
    .option('--json', 'Emit JSON envelope')
    .action(listAction),

  new Command('remove')
    .alias('rm')
    .description('Remove an MCP server definition from the fleet')
    .argument('<name>', 'Server name')
    .option('-f, --force', 'Skip the confirmation prompt')
    .option('--json', 'Emit JSON envelope')
    .action(removeAction),

  new Command('show')
    .description('Show one MCP server and the clients it renders to')
    .argument('<name>', 'Server name')
    .option('--json', 'Emit JSON envelope')
    .action(showAction),

  new Command('clients')
    .description('List supported MCP clients and their config paths')
    .option('--json', 'Emit JSON envelope')
    .action(clientsAction),

  new Command('render')
    .description('Preview rendered client configs (read-only; secrets NOT injected by default)')
    .option('--client <id>', 'Only this client (repeatable)', collect, [])
    .option('--with-secrets', 'Inject real secret values into the preview (may print credentials)')
    .option('--json', 'Emit JSON envelope')
    .action(renderAction),

  new Command('apply')
    .description('Render the fleet into each client config, injecting secrets at apply time')
    .option('--client <id>', 'Only this client (repeatable)', collect, [])
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--json', 'Emit JSON envelope')
    .action(applyAction),
];

/** commander accumulator for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
