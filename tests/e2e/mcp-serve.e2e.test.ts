import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { ensureBuilt } from './helpers/build.js';
import { runCli, makeHome, cleanupHome } from './helpers/runCli.js';

/**
 * `tuck mcp serve` protocol robustness, end-to-end through the real binary.
 *
 * The stdio JSON-RPC server must survive hostile/edge input WITHOUT crashing the
 * whole process (a single bad line used to reject the serialized chain and hit
 * the global unhandledRejection handler → exit 1), and must not drop in-flight
 * responses when stdin half-closes after the final request.
 */
describe('e2e: mcp serve protocol robustness', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  const parseLines = (stdout: string): Array<Record<string, unknown>> =>
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const initLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });

  it('does not crash on a bare `null` line and still answers a following request', async () => {
    const home = await makeHome();
    homes.push(home);

    // `JSON.parse('null')` succeeds and yields null — the old code then read
    // `null.id` and took the whole server down. It must reply with an Invalid
    // Request error (id null) and keep serving.
    const input = `null\n${initLine}\n`;
    const res = await runCli(['mcp', 'serve'], { home, input });

    expect(res.code).toBe(0);
    const msgs = parseLines(res.stdout);
    // The null line gets a JSON-RPC error response (id null, -32600).
    const invalid = msgs.find((m) => (m.error as { code?: number } | undefined)?.code === -32600);
    expect(invalid).toBeDefined();
    expect((invalid as { id: unknown }).id).toBeNull();
    // The initialize that followed it is still answered.
    const init = msgs.find((m) => m.id === 1);
    expect((init as { result?: { protocolVersion?: string } })?.result?.protocolVersion).toBeTruthy();
  });

  it('returns a tool error (not a crash) when tools/call `arguments` is a string, then answers the next request', async () => {
    const home = await makeHome();
    homes.push(home);

    const badCall = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'status', arguments: 'foo' },
    });
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' });
    const res = await runCli(['mcp', 'serve'], { home, input: `${initLine}\n${badCall}\n${ping}\n` });

    expect(res.code).toBe(0);
    const msgs = parseLines(res.stdout);
    const call = msgs.find((m) => m.id === 2) as
      | { result?: { isError?: boolean; content?: Array<{ text: string }> } }
      | undefined;
    expect(call?.result?.isError).toBe(true);
    expect(call?.result?.content?.[0].text).toMatch(/arguments.*must be an object/i);
    // The ping AFTER the bad call proves the server survived.
    const pong = msgs.find((m) => m.id === 3);
    expect((pong as { result?: unknown })?.result).toEqual({});
  });

  it('drains the in-flight request before exiting when stdin half-closes', async () => {
    const home = await makeHome();
    homes.push(home);

    // A tools/call handler does async I/O; process.exit on stdin close used to
    // race it and drop the id 2 response. Both responses must be emitted.
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'scan' },
    });
    const res = await runCli(['mcp', 'serve'], { home, input: `${initLine}\n${call}\n` });

    expect(res.code).toBe(0);
    const ids = parseLines(res.stdout).map((m) => m.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });
});
