/**
 * Template engine nesting-correctness regression tests — BATCH W4-D.
 *
 * Two latent bugs in src/lib/template.ts are pinned here:
 *
 *   (a) A nested comment-marker {{tuck:else}} under a FALSE parent block wrongly
 *       emitted its body. The fix ANDs a child's keep with the parent's keep so a
 *       child branch can never resurrect output that the parent suppressed.
 *
 *   (b) An inline nested {{#if a}}A{{#if b}}B{{/if}}C{{/if}} with a=false wrongly
 *       rendered C and consumed only the FIRST {{/if}} (greedy-first match). The
 *       fix stack-parses nested inline conditionals so the correct {{/if}} closes
 *       each block.
 *
 * These are correctness fixes only — all previously-passing single-level behavior
 * must be preserved unchanged.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/lib/template.js';

describe('template engine nesting (comment markers)', () => {
  it('(a) a nested tuck:else under a FALSE parent emits nothing', () => {
    const text = [
      '# tuck:if keepit == "yes"', // FALSE: keepit is "no"
      'PARENT_BODY',
      '# tuck:if inner == "yes"', // child, also FALSE
      'CHILD_IF',
      '# tuck:else',
      'CHILD_ELSE', // must NOT appear: parent is false
      '# tuck:endif',
      '# tuck:endif',
      'AFTER',
    ].join('\n');

    const out = renderTemplate(text, { keepit: 'no', inner: 'no' });

    expect(out).not.toContain('PARENT_BODY');
    expect(out).not.toContain('CHILD_IF');
    expect(out).not.toContain('CHILD_ELSE');
    expect(out).toContain('AFTER');
  });

  it('(a) a nested tuck:else under a TRUE parent still toggles normally', () => {
    const text = [
      '# tuck:if keepit == "yes"', // TRUE
      'PARENT_BODY',
      '# tuck:if inner == "yes"', // child FALSE
      'CHILD_IF',
      '# tuck:else',
      'CHILD_ELSE', // SHOULD appear: parent true, child if false
      '# tuck:endif',
      '# tuck:endif',
    ].join('\n');

    const out = renderTemplate(text, { keepit: 'yes', inner: 'no' });

    expect(out).toContain('PARENT_BODY');
    expect(out).not.toContain('CHILD_IF');
    expect(out).toContain('CHILD_ELSE');
  });

  it('preserves single-level else behavior (false branch -> else body)', () => {
    const text = ['# tuck:if x == "yes"', 'IF_BODY', '# tuck:else', 'ELSE_BODY', '# tuck:endif'].join(
      '\n'
    );
    const out = renderTemplate(text, { x: 'no' });
    expect(out).not.toContain('IF_BODY');
    expect(out).toContain('ELSE_BODY');
  });
});

describe('template engine nesting (inline {{#if}})', () => {
  it('(b) inline nested-if under a FALSE parent renders nothing and consumes the correct {{/if}}', () => {
    const text = '{{#if a}}A{{#if b}}B{{/if}}C{{/if}}';
    const out = renderTemplate(text, { a: 'false', b: 'true' });
    // Whole outer block is false -> empty. No stray "C" and no leftover "{{/if}}".
    expect(out).toBe('');
  });

  it('(b) inline nested-if under a TRUE parent renders the inner result and consumes both {{/if}}', () => {
    const text = 'X{{#if a}}A{{#if b}}B{{/if}}C{{/if}}Y';
    expect(renderTemplate(text, { a: 'true', b: 'true' })).toBe('XABCY');
    expect(renderTemplate(text, { a: 'true', b: 'false' })).toBe('XACY');
  });

  it('preserves single-level inline if/else behavior', () => {
    expect(renderTemplate('{{#if a}}YES{{else}}NO{{/if}}', { a: 'true' })).toBe('YES');
    expect(renderTemplate('{{#if a}}YES{{else}}NO{{/if}}', { a: 'false' })).toBe('NO');
  });

  it('preserves plain substitution alongside conditionals', () => {
    const out = renderTemplate('{{#if a}}hi {{name}}{{/if}}', { a: 'true', name: 'sam' });
    expect(out).toBe('hi sam');
  });
});
