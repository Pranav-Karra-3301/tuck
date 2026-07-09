/**
 * Barrel + backend selection for `tuck settings`.
 *
 * `selectBackend()` returns the settings backend for the current platform. Only
 * macOS is implemented in v1; other platforms return null so the command can
 * emit a clear "not supported yet" message. Adding Linux/dconf later means
 * adding a branch here and a new backend module — the command layer is
 * unchanged.
 */
import { MacOsDefaultsBackend } from './defaults.js';
import type { OsSettingsBackend } from './types.js';

export * from './types.js';
export * from './version.js';
export * from './plist.js';
export * from './capture.js';
export * from './manifest.js';
export * from './operations.js';
export { MacOsDefaultsBackend, GLOBAL_DOMAIN, buildDefaultsArgv } from './defaults.js';

/** Pick the settings backend for the current OS, or null if unsupported. */
export const selectBackend = (
  platform: NodeJS.Platform = process.platform
): OsSettingsBackend | null => {
  if (platform === 'darwin') return new MacOsDefaultsBackend();
  return null;
};
