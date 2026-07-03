/**
 * Repo → live materialization.
 *
 * A tracked file's REPO copy may hold a *source* form that differs from what
 * belongs on the live system:
 *   - encrypted files hold TCKE1 ciphertext (decrypt → plaintext)
 *   - template files hold {{ }} / `tuck:` source (render → machine-specific text)
 *
 * `materializeForLive` is the single place that conversion happens. `apply` and
 * `restore` route single-file writes through it; `stateModel` uses it to compute
 * the expected live content so status/verify don't report false drift.
 *
 * Order is decrypt → render. Secret-placeholder resolution (`{{PLACEHOLDER}}`)
 * stays in `apply` and runs on the already-materialized text. Text-oriented:
 * dotfiles are text, and callers handle directories/binary separately.
 */

import { renderTemplate, defaultTemplateContext, type TemplateContext } from './template.js';
import { isEncryptedFile, decryptFileContent } from './crypto/fileEncryption.js';
import { MaterializeError } from '../errors.js';
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';

export interface MaterializeDeps {
  /** Returns the file-encryption passphrase, or null if none is configured/available. */
  getPassphrase: () => Promise<string | null>;
}

/** The minimal slice of a tracked file `materializeForLive` needs. */
export type MaterializableFile = Pick<TrackedFileOutput, 'template' | 'encrypted' | 'source'>;

/**
 * Convert a repo file's raw bytes into the content that belongs on the live
 * system: decrypt (if encrypted) then render (if a template).
 *
 * Throws {@link MaterializeError} when a required decryption cannot be performed
 * (no passphrase configured, wrong passphrase, corrupt ciphertext) so the caller
 * NEVER writes ciphertext or partial output to the live system.
 */
export const materializeForLive = async (
  repoBytes: Buffer,
  file: MaterializableFile,
  ctx: TemplateContext,
  deps: MaterializeDeps
): Promise<string> => {
  let bytes = repoBytes;

  // Decrypt if the file is flagged encrypted OR carries the magic header (defensive:
  // a mislabeled file still decrypts rather than shipping ciphertext to disk).
  if (file.encrypted || isEncryptedFile(repoBytes)) {
    const pass = await deps.getPassphrase();
    if (!pass) {
      throw new MaterializeError(file.source, 'no encryption password configured');
    }
    try {
      bytes = await decryptFileContent(bytes, pass);
    } catch (err) {
      throw new MaterializeError(file.source, err instanceof Error ? err.message : 'decryption failed');
    }
  }

  let text = bytes.toString('utf8');
  if (file.template) {
    text = renderTemplate(text, ctx);
  }
  return text;
};

/**
 * The single per-OS keystore "encryption password" used for TCKE1 file
 * encryption. Returns null when none is set (the caller decides whether that is
 * fatal — it is for an encrypted file, harmless otherwise).
 */
export const keystorePassphrase = async (): Promise<string | null> => {
  const { getKeystore, TUCK_SERVICE, TUCK_ACCOUNT } = await import('./crypto/keystore/index.js');
  return (await getKeystore()).retrieve(TUCK_SERVICE, TUCK_ACCOUNT);
};

/**
 * Build the template context for a command run: the built-in machine variables
 * (os/arch/hostname/user/home/ci) merged with the user's
 * `config.templates.variables`. Built once per command, not per file.
 */
export const buildMaterializeCtx = async (tuckDir: string): Promise<TemplateContext> => {
  // Resilient: a missing/corrupt config must not break apply/restore — fall back
  // to the built-in machine variables (os/arch/hostname/…) only.
  try {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig(tuckDir);
    return defaultTemplateContext(config?.templates?.variables ?? {});
  } catch {
    return defaultTemplateContext({});
  }
};
