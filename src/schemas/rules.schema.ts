import { z } from 'zod';

/**
 * Rules fan-out schema — one canonical rules/instructions file materialized into
 * many tool-specific variants (CLAUDE.md, .cursorrules, .windsurfrules,
 * copilot-instructions.md, GEMINI.md, …). See IDEAS.md §1.4.
 *
 * The manifest (rules.json) is machine-local-ish but committed to the tuck repo,
 * so all stored paths use POSIX separators and repo-scoped sets identify their
 * repo by its absolute root (never a per-machine relative guess).
 */

/** Known fan-out targets. Each maps to a canonical relative destination path. */
export const ruleToolNameSchema = z.enum([
  'claude',
  'cursor',
  'cursor-dir',
  'windsurf',
  'copilot',
  'gemini',
  'agents',
]);

/**
 * How a tool variant is produced on apply:
 *   - `materialize`: render the canonical file (honoring per-tool templating)
 *     and write a real file. Supports per-tool overrides.
 *   - `symlink`: symlink the variant at the canonical source. Always byte-
 *     identical to the source, so per-tool templating is NOT applied.
 */
export const ruleStrategySchema = z.enum(['materialize', 'symlink']);

export const ruleToolSchema = z.object({
  tool: ruleToolNameSchema,
  strategy: ruleStrategySchema.default('materialize'),
  /**
   * Optional override for the variant's destination, relative to the set's scope
   * root ($HOME or the repo root). When absent the tool's canonical default path
   * is used. Must be a safe, non-escaping relative path.
   */
  path: z.string().optional(),
});

export const ruleSetSchema = z
  .object({
    /** Canonical rules file: `~/`-prefixed for home scope, absolute for repo. */
    source: z.string(),
    scope: z.enum(['home', 'repo']),
    /** Absolute repo root; present iff `scope === 'repo'`. */
    repoRoot: z.string().optional(),
    /**
     * Whether to render the canonical file through tuck's template engine when
     * materializing. Defaults true so `{{#if tool == "cursor"}}…{{/if}}`
     * per-tool overrides work out of the box.
     */
    template: z.boolean().default(true),
    /** Fan-out targets. */
    tools: z.array(ruleToolSchema),
    /** Extra template variables merged into the render context. */
    variables: z.record(z.string()).default({}),
    added: z.string(),
    modified: z.string(),
  })
  .superRefine((set, ctx) => {
    if (set.scope === 'repo') {
      if (!set.repoRoot) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repoRoot'],
          message: 'repoRoot is required for repo-scoped rule sets',
        });
      }
    } else if (set.repoRoot !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repoRoot'],
        message: 'repoRoot is only valid on repo-scoped rule sets',
      });
    }
    // Reject unsafe override paths (absolute or `..`-escaping) up front so a
    // malformed manifest never lets a variant land outside its scope root.
    for (const t of set.tools) {
      if (t.path === undefined) continue;
      const norm = t.path.replace(/\\/g, '/');
      const unsafe =
        norm.startsWith('/') ||
        /^[A-Za-z]:[\\/]/.test(t.path) ||
        norm.split('/').includes('..');
      if (unsafe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tools'],
          message: `Unsafe tool path override: ${t.path}`,
        });
      }
    }
  });

export const rulesManifestSchema = z.object({
  version: z.literal('1'),
  sets: z.record(ruleSetSchema),
});

export type RuleToolName = z.infer<typeof ruleToolNameSchema>;
export type RuleToolInput = z.input<typeof ruleToolSchema>;
export type RuleTool = z.output<typeof ruleToolSchema>;
export type RuleSetInput = z.input<typeof ruleSetSchema>;
export type RuleSet = z.output<typeof ruleSetSchema>;
export type RulesManifest = z.output<typeof rulesManifestSchema>;
