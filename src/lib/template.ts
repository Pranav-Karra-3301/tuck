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
 *   # tuck:if os=darwin
 *   alias ls="ls -G"
 *   # tuck:endif
 *
 * Both styles share the same context map.
 *
 * Templates are rendered at *restore time*, never at storage time — the file
 * tracked in the repo is always the templated source. This matches the spec's
 * explicit critique of chezmoi's storage-time rendering.
 */

export interface TemplateContext {
  /** Free-form variables: os, arch, hostname, profile, user, home, etc. */
  [key: string]: string | number | boolean | undefined;
}

const lookup = (ctx: TemplateContext, key: string): string => {
  // Support env.X by special-casing the env namespace at lookup time.
  if (key.startsWith('env.')) {
    const v = process.env[key.slice(4)];
    return v == null ? '' : v;
  }
  const v = ctx[key];
  return v == null ? '' : String(v);
};

const evalCondition = (ctx: TemplateContext, expr: string): boolean => {
  // Supports: VAR, VAR == "literal", VAR != "literal", env.X, !VAR
  const trimmed = expr.trim();
  if (trimmed.startsWith('!')) {
    return !evalCondition(ctx, trimmed.slice(1));
  }
  const eq = trimmed.match(/^(.+?)\s*(==|!=)\s*"([^"]*)"$/);
  if (eq) {
    const [, k, op, lit] = eq;
    const v = lookup(ctx, k.trim());
    return op === '==' ? v === lit : v !== lit;
  }
  const v = lookup(ctx, trimmed);
  return Boolean(v) && v !== 'false' && v !== '0';
};

const renderInline = (text: string, ctx: TemplateContext): string => {
  // Handle {{#if …}}…{{else}}…{{/if}} blocks first (non-nested for safety).
  text = text.replace(
    /\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, expr: string, ifBranch: string, elseBranch?: string) => {
      return evalCondition(ctx, expr) ? ifBranch : elseBranch ?? '';
    }
  );

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
  type Frame = { keep: boolean; sawElse: boolean };
  const stack: Frame[] = [];

  const ifRe = /^\s*([#;/*]+)\s*tuck:if\s+(.+?)\s*$/;
  const elseRe = /^\s*([#;/*]+)\s*tuck:else\s*$/;
  const endIfRe = /^\s*([#;/*]+)\s*tuck:endif\s*$/;

  for (const line of lines) {
    const ifM = line.match(ifRe);
    if (ifM) {
      const cond = evalCondition(ctx, ifM[2]);
      const parentKeep = stack.length === 0 || stack[stack.length - 1].keep;
      stack.push({ keep: parentKeep && cond, sawElse: false });
      continue;
    }
    if (elseRe.test(line)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        top.sawElse = true;
        top.keep = !top.keep;
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
