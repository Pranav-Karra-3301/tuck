/**
 * Pure rendering + secret-injection unit tests for the MCP fleet.
 *
 * These functions are the heart of "define once, render per client": they must
 * (a) find every `{{PLACEHOLDER}}` a server references, (b) inject secrets
 * without corrupting `$`-sequences, and (c) emit the exact shape each client
 * expects (container key, `type` discriminator, remote-transport dialect).
 */
import { describe, it, expect } from 'vitest';
import {
  collectServerPlaceholders,
  injectServerSecrets,
  renderServerEntry,
  clientContainerKey,
} from '../../src/lib/mcp/render.js';
import { mcpServerSchema, type McpServerOutput } from '../../src/schemas/mcpServers.schema.js';

const parse = (input: unknown): McpServerOutput => mcpServerSchema.parse(input);

describe('collectServerPlaceholders', () => {
  it('finds placeholders across command, args, env, url, and headers', () => {
    const server = parse({
      transport: 'stdio',
      command: '{{RUNNER}}',
      args: ['--token', '{{ARG_TOKEN}}'],
      env: { API_KEY: '{{OPENAI_KEY}}', PLAIN: 'nope' },
    });
    expect(collectServerPlaceholders(server).sort()).toEqual(
      ['ARG_TOKEN', 'OPENAI_KEY', 'RUNNER'].sort()
    );
  });

  it('finds placeholders in remote url and header values', () => {
    const server = parse({
      transport: 'http',
      url: 'https://api.example.com/{{TENANT}}',
      headers: { Authorization: 'Bearer {{TOKEN}}' },
    });
    expect(collectServerPlaceholders(server).sort()).toEqual(['TENANT', 'TOKEN']);
  });

  it('returns an empty list when there are no placeholders', () => {
    const server = parse({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
    expect(collectServerPlaceholders(server)).toEqual([]);
  });
});

describe('injectServerSecrets', () => {
  it('replaces placeholders with resolved values', () => {
    const server = parse({
      transport: 'stdio',
      command: 'npx',
      env: { API_KEY: '{{OPENAI_KEY}}' },
    });
    const { server: resolved, unresolved } = injectServerSecrets(server, {
      OPENAI_KEY: 'sk-real-value',
    });
    expect(resolved.env.API_KEY).toBe('sk-real-value');
    expect(unresolved).toEqual([]);
  });

  it('reports placeholders that have no matching secret and leaves them verbatim', () => {
    const server = parse({ transport: 'stdio', command: 'npx', env: { A: '{{MISSING}}' } });
    const { server: resolved, unresolved } = injectServerSecrets(server, {});
    expect(resolved.env.A).toBe('{{MISSING}}');
    expect(unresolved).toEqual(['MISSING']);
  });

  it('inserts $-sequences literally (no regex replacement-pattern corruption)', () => {
    const server = parse({ transport: 'stdio', command: 'npx', env: { P: '{{PW}}' } });
    const { server: resolved } = injectServerSecrets(server, { PW: 'a$&b$1c' });
    expect(resolved.env.P).toBe('a$&b$1c');
  });

  it('does not mutate the input server', () => {
    const server = parse({ transport: 'stdio', command: 'npx', env: { A: '{{X}}' } });
    injectServerSecrets(server, { X: 'value' });
    expect(server.env.A).toBe('{{X}}');
  });
});

describe('clientContainerKey', () => {
  it('uses "servers" for VS Code and "mcpServers" for everyone else', () => {
    expect(clientContainerKey('vscode')).toBe('servers');
    expect(clientContainerKey('claude-desktop')).toBe('mcpServers');
    expect(clientContainerKey('cursor')).toBe('mcpServers');
    expect(clientContainerKey('windsurf')).toBe('mcpServers');
    expect(clientContainerKey('claude-code')).toBe('mcpServers');
  });
});

describe('renderServerEntry — stdio', () => {
  const stdio = parse({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    env: { TOKEN: 'abc' },
  });

  it('renders Claude Desktop as a bare command/args/env entry', () => {
    expect(renderServerEntry('claude-desktop', stdio)).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'abc' },
    });
  });

  it('adds an explicit type discriminator for VS Code', () => {
    expect(renderServerEntry('vscode', stdio)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'abc' },
    });
  });

  it('omits empty args/env', () => {
    const bare = parse({ transport: 'stdio', command: 'mcp-bin' });
    expect(renderServerEntry('cursor', bare)).toEqual({ command: 'mcp-bin' });
  });
});

describe('renderServerEntry — remote', () => {
  const http = parse({
    transport: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer t' },
  });

  it('returns null for Claude Desktop (no remote format)', () => {
    expect(renderServerEntry('claude-desktop', http)).toBeNull();
  });

  it('uses type+url+headers for Claude Code, Cursor, and VS Code', () => {
    for (const client of ['claude-code', 'cursor', 'vscode'] as const) {
      expect(renderServerEntry(client, http)).toEqual({
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      });
    }
  });

  it('uses the Windsurf serverUrl dialect', () => {
    expect(renderServerEntry('windsurf', http)).toEqual({
      serverUrl: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('preserves the sse transport in the type field', () => {
    const sse = parse({ transport: 'sse', url: 'https://api.example.com/sse' });
    expect(renderServerEntry('cursor', sse)).toEqual({
      type: 'sse',
      url: 'https://api.example.com/sse',
    });
  });
});
