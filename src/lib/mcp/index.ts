/**
 * MCP fleet library — declare MCP servers once, render per client.
 */

export {
  MCP_FLEET_FILENAME,
  getMcpFleetPath,
  loadFleet,
  saveFleet,
  setServer,
  removeServer,
  getServer,
} from './fleet.js';

export {
  collectServerPlaceholders,
  injectServerSecrets,
  clientContainerKey,
  renderServerEntry,
  type ClientServerEntry,
  type InjectResult,
} from './render.js';

export {
  listClients,
  clientDisplayName,
  clientConfigPathFor,
  resolveClientConfigPath,
  type ClientPlatform,
  type McpClientInfo,
} from './clients.js';

export {
  serverTargetsClient,
  renderClient,
  mergeClientConfig,
  type RenderedServer,
  type RenderClientResult,
} from './apply.js';
