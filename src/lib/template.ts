/**
 * Sandboxed template engine for tuck — §5 / v1.5 #1 of WHATS_NEXT.md.
 *
 * Design: a small handlebars-flavored subset, intentionally narrow so it can't
 * execute arbitrary code. Variables are read from a flat map; conditionals are
 * the only control flow.
 *
 *   {{var}}                 — substitution
 *   {{var | default "x"}}   — fallback when missing/empty
 *   {{#if os == "darwin"}}…{{/if}}
 *   {{#if env.CI}}…{{else}}…{{/if}}
 *
 * Comment-marker style for files without `{{ }}`:
 *
 *   # tuck:if os == "darwin"
 *   alias ls="ls -G"
 *   # tuck:endif
 *
 * The comparison literal may be quoted (`os == "darwin"`) or a bare
 * single-word literal (`os == darwin` or `os = darwin`).
 *
 * Both styles share the same context map.
 *
 * Templates are rendered at *restore time*, never at storage time — the file
 * tracked in the repo is always the templated source. This matches the spec's
 * explicit critique of chezmoi's storage-time rendering.
 */

import { isJsonMode, addJsonWarning } from './jsonOutput.js';

export interface TemplateContext {
  /** Free-form variables: os, arch, hostname, profile, user, home, etc. */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Surface a malformed `{{#if}}` / `# tuck:if` condition. In `--json` mode the
 * warning rides along in the response envelope (via {@link addJsonWarning}) so
 * stdout still carries exactly one JSON object; otherwise it goes to stderr —
 * never stdout — so it can't corrupt the rendered file or a JSON stream. This
 * module stays free of the UI/logger layer so it can be imported by low-level
 * code without pulling in terminal styling.
 */
const warnUnrecognizedCondition = (expr: string): void => {
  const msg = `Unrecognized template condition "${expr}" — guarded block was dropped`;
  if (isJsonMode()) {
    addJsonWarning(msg);
  } else {
    process.stderr.write(`tuck: ${msg}\n`);
  }
};

const lookup = (ctx: TemplateContext, key: string): string => {
  // Support env.X by special-casing the env namespace at lookup time.
  if (key.startsWith('env.')) {
    const v = process.env[key.slice(4)];
    return v == null ? '' : v;
  }
  const v = ctx[key];
  return v == null ? '' : String(v);
};

/** Bare variable / env reference, e.g. `os`, `profile.work`, `env.CI`. */
const VAR_NAME_RE = /^[A-Za-z_][\w.]*$/;

const evalCondition = (ctx: TemplateContext, expr: string): boolean => {
  // Supports: VAR, !VAR, env.X, and comparisons VAR ==|!= <literal> where the
  // literal is either double-quoted (`VAR == "x"`) or a bare single word
  // (`VAR == x`, `VAR = x`). The bare/single-`=` forms exist because tuck's own
  // docs use `os=darwin`; without them the guarded block was silently dropped.
  const trimmed = expr.trim();
  if (trimmed.startsWith('!')) {
    return !evalCondition(ctx, trimmed.slice(1));
  }

  const eqQuoted = trimmed.match(/^(.+?)\s*(==|!=)\s*"([^"]*)"$/);
  if (eqQuoted) {
    const [, k, op, lit] = eqQuoted;
    const v = lookup(ctx, k.trim());
    return op === '==' ? v === lit : v !== lit;
  }

  const eqBare = trimmed.match(/^(.+?)\s*(==|!=|=)\s*([^"'\s]+)$/);
  if (eqBare) {
    const [, k, op, lit] = eqBare;
    const v = lookup(ctx, k.trim());
    return op === '!=' ? v !== lit : v === lit;
  }

  // Neither a comparison nor a plausible variable reference: this is almost
  // certainly a malformed condition. Evaluating it as false-truthiness would
  // silently drop the guarded block, so surface it instead of failing quietly.
  if (!VAR_NAME_RE.test(trimmed)) {
    warnUnrecognizedCondition(trimmed);
    return false;
  }

  const v = lookup(ctx, trimmed);
  return Boolean(v) && v !== 'false' && v !== '0';
};

/**
 * Resolve {{#if …}}…{{else}}…{{/if}} blocks with correct nesting.
 *
 * The old single-pass regex was non-greedy and matched the FIRST {{/if}}, so a
 * nested block (`{{#if a}}A{{#if b}}B{{/if}}C{{/if}}`) closed the OUTER block on
 * the INNER {{/if}} — leaking `C{{/if}}` and dropping the inner condition. We
 * stack-parse instead: each {{#if}} pushes a frame, the matching {{/if}} pops it
 * and substitutes the chosen branch (with nested children already resolved). The
 * matching is depth-balanced, so the correct {{/if}} closes each block.
 */
const renderInlineConditionals = (text: string, ctx: TemplateContext): string => {
  const tokenRe = /\{\{#if\s+([^}]+)\}\}|\{\{else\}\}|\{\{\/if\}\}/g;

  type Frame = {
    expr: string;
    /** Literal output accumulated so far for the active branch. */
    out: string;
    /** True once {{else}} has been seen for this frame. */
    sawElse: boolean;
    /** Captured if-branch text, set when {{else}} is reached. */
    ifBranch: string;
  };

  const stack: Frame[] = [];
  const newFrame = (expr: string): Frame => ({ expr, out: '', sawElse: false, ifBranch: '' });

  // Root accumulator (text outside any conditional).
  let root = '';
  const append = (s: string): void => {
    if (stack.length === 0) root += s;
    else stack[stack.length - 1].out += s;
  };

  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    // Emit the literal text between the previous token and this one.
    append(text.slice(lastIndex, m.index));
    lastIndex = tokenRe.lastIndex;

    const [matched, ifExpr] = m;
    if (ifExpr !== undefined) {
      stack.push(newFrame(ifExpr));
    } else if (matched === '{{else}}') {
      if (stack.length === 0) {
        // Stray {{else}} with no open if — preserve verbatim.
        append(matched);
      } else {
        const top = stack[stack.length - 1];
        top.sawElse = true;
        top.ifBranch = top.out;
        top.out = '';
      }
    } else {
      // {{/if}}
      if (stack.length === 0) {
        // Stray {{/if}} — preserve verbatim.
        append(matched);
      } else {
        const frame = stack.pop()!;
        const ifBranch = frame.sawElse ? frame.ifBranch : frame.out;
        const elseBranch = frame.sawElse ? frame.out : '';
        append(evalCondition(ctx, frame.expr) ? ifBranch : elseBranch);
      }
    }
  }

  // Trailing literal text after the final token.
  append(text.slice(lastIndex));

  // Unbalanced {{#if}} with no closing {{/if}}: flush remaining frames as-is so
  // we never silently drop content (preserve prior best-effort behavior).
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const flushed = frame.sawElse
      ? `{{#if ${frame.expr}}}${frame.ifBranch}{{else}}${frame.out}`
      : `{{#if ${frame.expr}}}${frame.out}`;
    append(flushed);
  }

  return root;
};

const renderInline = (text: string, ctx: TemplateContext): string => {
  // Handle {{#if …}}…{{else}}…{{/if}} blocks first, with correct nesting.
  text = renderInlineConditionals(text, ctx);

  // Then substitutions: {{var}} and {{var | default "x"}}
  text = text.replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*default\s+"([^"]*)")?\s*\}\}/g, (_, key: string, def?: string) => {
    const v = lookup(ctx, key.trim());
    return v || def || '';
  });

  return text;
};

const renderCommentMarkers = (text: string, ctx: TemplateContext): string => {
  // Match each `# tuck:if EXPR` ... `# tuck:endif` (optional `# tuck:else`).
  // Comment char is anything before "tuck:" on the line.
  const lines = text.split('\n');
  const out: string[] = [];
  // `ifTaken` records whether THIS block's own condition (the `if` branch) was
  // true, independent of the parent. On `else` we recompute keep from the
  // parent's keep AND the negation of `ifTaken` — so a child branch can never
  // resurrect output the parent suppressed.
  type Frame = { keep: boolean; sawElse: boolean; ifTaken: boolean };
  const stack: Frame[] = [];

  const ifRe = /^\s*([#;/*]+)\s*tuck:if\s+(.+?)\s*$/;
  const elseRe = /^\s*([#;/*]+)\s*tuck:else\s*$/;
  const endIfRe = /^\s*([#;/*]+)\s*tuck:endif\s*$/;

  for (const line of lines) {
    const ifM = line.match(ifRe);
    if (ifM) {
      const cond = evalCondition(ctx, ifM[2]);
      const parentKeep = stack.length === 0 || stack[stack.length - 1].keep;
      stack.push({ keep: parentKeep && cond, sawElse: false, ifTaken: cond });
      continue;
    }
    if (elseRe.test(line)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        top.sawElse = true;
        // A child's else-body must stay gated by the parent: keep the else body
        // only when the parent kept this block AND the if branch was not taken.
        const parentKeep = stack.length === 1 || stack[stack.length - 2].keep;
        top.keep = parentKeep && !top.ifTaken;
      }
      continue;
    }
    if (endIfRe.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.length === 0 || stack[stack.length - 1].keep) {
      out.push(line);
    }
  }
  return out.join('\n');
};

/**
 * Render a template string against a context.
 *
 * Order: comment-markers first (whole-line directives), then inline {{ }}
 * substitutions/conditionals.
 */
export const renderTemplate = (text: string, ctx: TemplateContext): string => {
  return renderInline(renderCommentMarkers(text, ctx), ctx);
};

/** Build the default template context from process state. */
export const defaultTemplateContext = (extra: TemplateContext = {}): TemplateContext => {
  return {
    os: process.platform,
    arch: process.arch,
    hostname: process.env.HOSTNAME || process.env.COMPUTERNAME || '',
    user: process.env.USER || process.env.USERNAME || '',
    home: process.env.HOME || process.env.USERPROFILE || '',
    ci: process.env.CI ? 'true' : '',
    ...extra,
  };
};

/**
 * Heuristic: does this text look like it needs template rendering at all?
 * Used to short-circuit non-template files in the apply path.
 */
export const looksLikeTemplate = (text: string): boolean => {
  return /\{\{[^}]+\}\}|tuck:(if|else|endif)/.test(text);
};
