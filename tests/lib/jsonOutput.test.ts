/**
 * JSON envelope unit tests.
 *
 * The envelope is the agent/CI contract: exactly one JSON object on stdout.
 *  - warnings queued before an error must still surface (not be silently lost).
 *  - a stray second emit must never print a second object.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setJsonMode,
  addJsonWarning,
  emitJsonOk,
  emitJsonErr,
  __resetJsonEmitState,
} from '../../src/lib/jsonOutput.js';

let out: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  out = [];
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  setJsonMode(true, 'tuck test');
  __resetJsonEmitState();
});

afterEach(() => {
  spy.mockRestore();
  setJsonMode(false);
});

describe('emitJsonErr', () => {
  it('includes warnings that were queued before the error', () => {
    addJsonWarning('hook skipped');
    emitJsonErr({ code: 'X', message: 'boom', exit_code: 1 });
    const env = JSON.parse(out.join(''));
    expect(env.ok).toBe(false);
    expect(env.warnings).toContain('hook skipped');
  });
});

describe('single-emit guard', () => {
  it('emits at most one JSON object even if emit is called twice', () => {
    emitJsonOk({ a: 1 });
    emitJsonOk({ a: 2 });
    emitJsonErr({ code: 'X', message: 'boom', exit_code: 1 });
    const lines = out.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });
});
