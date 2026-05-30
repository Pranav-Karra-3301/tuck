/**
 * Shared loader for a cloned/remote manifest file.
 *
 * A manifest that came from a clone (or any remote) is UNTRUSTED input: it can
 * be hand-crafted by a hostile repo to smuggle malformed or unsafe entries.
 * This module is the single choke point that JSON.parses AND zod-validates such
 * a manifest, so callers (init's analyzeRepository, apply's clone read) always
 * act on a schema-valid object rather than a half-typed blob.
 */
import { readFile } from 'fs/promises';
import { tuckManifestSchema, type TuckManifestOutput } from '../schemas/manifest.schema.js';

/**
 * Read, JSON-parse, and zod-validate a manifest file.
 *
 * @param manifestPath Absolute path to a `.tuckmanifest.json` file.
 * @returns The parsed, schema-validated manifest.
 * @throws SyntaxError if the file is not valid JSON.
 * @throws ZodError if the parsed value does not satisfy the manifest schema.
 */
export const loadManifestFile = async (manifestPath: string): Promise<TuckManifestOutput> => {
  const content = await readFile(manifestPath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return tuckManifestSchema.parse(parsed);
};
