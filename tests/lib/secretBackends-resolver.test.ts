/**
 * SecretResolver dispatch/priority tests.
 *
 * The resolver is the security-critical orchestration layer: it decides WHICH
 * backend answers a placeholder, enforces availability/auth gating, applies the
 * mapping-derived backend path, and caches results. We mock the four backend
 * modules (no real op/bw/pass/vault binaries) and the mappings lookup so the
 * pure dispatch logic is exercised deterministically. The real in-memory cache
 * is used (and reset per test) so cache hit/miss paths are covered too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface BackendSpec {
  available: boolean;
  authenticated: boolean;
  secret: string | null;
  authCalls: number;
  lockCalls: number;
  authThrows: boolean;
  getSecretRefs: Array<{ name: string; backendPath?: string }>;
}

// ── Controllable fake-backend state ────────────────────────────────────────
// Defined in a hoisted block so the vi.mock factories (hoisted to top of file)
// can reference them. Plain mutable objects (NOT vi.fn) so vitest's mockReset
// can't wipe them; we reset them by hand in beforeEach.
const h = vi.hoisted(() => {
  const makeSpec = (): BackendSpec => ({
    available: true,
    authenticated: true,
    secret: 'RESOLVED',
    authCalls: 0,
    lockCalls: 0,
    authThrows: false,
    getSecretRefs: [],
  });

  const specs: Record<string, BackendSpec> = {
    local: makeSpec(),
    '1password': makeSpec(),
    bitwarden: makeSpec(),
    pass: makeSpec(),
  };

  // getBackendPath / listMappings are the only mappings functions the resolver
  // touches; back them with controllable state.
  const mapState: {
    backendPath: string | null;
    listMappings: Record<string, Record<string, string | boolean | undefined>>;
  } = { backendPath: null, listMappings: {} };

  const makeFakeBackend = (name: string, displayName: string, cliName: string | null) =>
    class {
      readonly name = name;
      readonly displayName = displayName;
      readonly cliName = cliName;
      async isAvailable() {
        return specs[name].available;
      }
      async isAuthenticated() {
        return specs[name].authenticated;
      }
      async authenticate() {
        specs[name].authCalls++;
        if (specs[name].authThrows) {
          throw new Error(`auth failed for ${name}`);
        }
      }
      async lock() {
        specs[name].lockCalls++;
      }
      async getSecret(ref: { name: string; backendPath?: string }) {
        specs[name].getSecretRefs.push(ref);
        return specs[name].secret;
      }
      getSetupInstructions() {
        return `setup ${name}`;
      }
    };

  return { makeSpec, specs, mapState, makeFakeBackend };
});

const specs = h.specs;

vi.mock('../../src/lib/secretBackends/local.js', () => ({
  LocalBackend: h.makeFakeBackend('local', 'Local secrets file', null),
}));
vi.mock('../../src/lib/secretBackends/onepassword.js', () => ({
  OnePasswordBackend: h.makeFakeBackend('1password', '1Password', 'op'),
}));
vi.mock('../../src/lib/secretBackends/bitwarden.js', () => ({
  BitwardenBackend: h.makeFakeBackend('bitwarden', 'Bitwarden', 'bw'),
}));
vi.mock('../../src/lib/secretBackends/pass.js', () => ({
  PassBackend: h.makeFakeBackend('pass', 'pass (Unix password store)', 'pass'),
}));

vi.mock('../../src/lib/secretBackends/mappings.js', () => ({
  getBackendPath: vi.fn(async () => h.mapState.backendPath),
  listMappings: vi.fn(async () => h.mapState.listMappings),
}));

import { SecretResolver } from '../../src/lib/secretBackends/resolver.js';
import { resetGlobalCache } from '../../src/lib/secretBackends/cache.js';
import type { SecurityConfig } from '../../src/schemas/secrets.schema.js';
import {
  BackendNotAvailableError,
  BackendAuthenticationError,
  UnresolvedSecretsError,
} from '../../src/errors.js';

const TUCK_DIR = '/test-home/.tuck';

const baseConfig = (over?: Partial<SecurityConfig>): SecurityConfig =>
  ({
    secretBackend: 'auto',
    cacheSecrets: true,
    secretMappings: 'secrets.mappings.json',
    ...over,
  }) as SecurityConfig;

describe('SecretResolver', () => {
  beforeEach(() => {
    resetGlobalCache();
    for (const key of Object.keys(specs)) {
      specs[key] = h.makeSpec();
    }
    h.mapState.backendPath = null;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.BW_SESSION;
  });
  afterEach(() => {
    resetGlobalCache();
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.BW_SESSION;
  });

  // ── Primary-backend selection ────────────────────────────────────────────

  it('defaults the primary backend to local when configured "auto"', () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(r.getConfiguredBackendName()).toBe('auto');
    expect(r.getPrimaryBackendName()).toBe('local');
    expect(r.getPrimaryBackend().name).toBe('local');
  });

  it('uses an explicitly configured backend as primary', () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'pass' }));
    expect(r.getConfiguredBackendName()).toBe('pass');
    expect(r.getPrimaryBackendName()).toBe('pass');
    expect(r.getPrimaryBackend().name).toBe('pass');
  });

  it('getBackend returns undefined for an unknown backend name', () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    // @ts-expect-error – intentionally probing an invalid name
    expect(r.getBackend('vault')).toBeUndefined();
  });

  // ── getEffectiveBackendName / auto-detection ──────────────────────────────

  it('getEffectiveBackendName returns the explicit backend without detection', async () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'bitwarden' }));
    expect(await r.getEffectiveBackendName()).toBe('bitwarden');
  });

  it('auto-detects 1password first when OP_SERVICE_ACCOUNT_TOKEN is set and it is ready', async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'tok';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(await r.getEffectiveBackendName()).toBe('1password');
  });

  it('auto-detects bitwarden when BW_SESSION is set and it is ready', async () => {
    process.env.BW_SESSION = 'sess';
    // Make 1password not authenticated so env-priority skips it.
    specs['1password'].authenticated = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(await r.getEffectiveBackendName()).toBe('bitwarden');
  });

  it('auto-detect walks the priority order and returns the first ready backend', async () => {
    // 1password unavailable, bitwarden unauthenticated, pass ready.
    specs['1password'].available = false;
    specs['bitwarden'].authenticated = false;
    specs['pass'].available = true;
    specs['pass'].authenticated = true;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(await r.autoDetectBackend()).toBe('pass');
  });

  it('auto-detect falls back to local when nothing else is ready', async () => {
    for (const key of ['1password', 'bitwarden', 'pass']) {
      specs[key].available = false;
    }
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(await r.autoDetectBackend()).toBe('local');
  });

  it('caches the detected backend so a second call does not re-detect', async () => {
    specs['1password'].available = false;
    specs['bitwarden'].available = false;
    specs['pass'].available = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'auto' }));
    expect(await r.getEffectiveBackendName()).toBe('local');
    // Flip pass to ready; a cached detection must NOT change the answer.
    specs['pass'].available = true;
    specs['pass'].authenticated = true;
    expect(await r.getEffectiveBackendName()).toBe('local');
  });

  // ── Availability / auth helpers ──────────────────────────────────────────

  it('isBackendAvailable / isBackendAuthenticated proxy to the backend', async () => {
    specs['pass'].available = false;
    specs['bitwarden'].authenticated = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    expect(await r.isBackendAvailable('pass')).toBe(false);
    expect(await r.isBackendAvailable('local')).toBe(true);
    expect(await r.isBackendAuthenticated('bitwarden')).toBe(false);
    // Unknown backend → false, not a throw.
    // @ts-expect-error invalid name
    expect(await r.isBackendAvailable('nope')).toBe(false);
    // @ts-expect-error invalid name
    expect(await r.isBackendAuthenticated('nope')).toBe(false);
  });

  it('getAvailableBackends lists only available backends', async () => {
    specs['1password'].available = false;
    specs['pass'].available = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    expect((await r.getAvailableBackends()).sort()).toEqual(['bitwarden', 'local']);
  });

  it('authenticateBackend invokes the backend and throws for unknown names', async () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    await r.authenticateBackend('pass');
    expect(specs['pass'].authCalls).toBe(1);
    // @ts-expect-error invalid name
    await expect(r.authenticateBackend('nope')).rejects.toBeInstanceOf(BackendNotAvailableError);
  });

  // ── resolveSecret ────────────────────────────────────────────────────────

  it('resolves via the effective backend and passes the mapped backend path', async () => {
    h.mapState.backendPath = 'op://Personal/GH/password';
    specs['local'].secret = 'GH_VALUE';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));

    const res = await r.resolveSecret('GITHUB_TOKEN');
    expect(res).toEqual({
      name: 'GITHUB_TOKEN',
      value: 'GH_VALUE',
      backend: 'local',
      cached: false,
    });
    // The mapping-derived path is forwarded to the backend.
    expect(specs['local'].getSecretRefs[0]).toEqual({
      name: 'GITHUB_TOKEN',
      backendPath: 'op://Personal/GH/password',
    });
  });

  it('serves a cached value on the second resolve (cached: true, no backend call)', async () => {
    specs['local'].secret = 'V1';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));

    const first = await r.resolveSecret('TOKEN');
    expect(first!.cached).toBe(false);

    // Change the underlying value; a cache hit must still return the old one.
    specs['local'].secret = 'V2';
    const second = await r.resolveSecret('TOKEN');
    expect(second!.cached).toBe(true);
    expect(second!.value).toBe('V1');
    // Backend getSecret was only called once.
    expect(specs['local'].getSecretRefs).toHaveLength(1);
  });

  it('skipCache bypasses the cache and refetches', async () => {
    specs['local'].secret = 'V1';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    await r.resolveSecret('TOKEN');

    specs['local'].secret = 'V2';
    const res = await r.resolveSecret('TOKEN', { skipCache: true });
    expect(res!.value).toBe('V2');
    expect(res!.cached).toBe(false);
  });

  it('does not cache when cacheSecrets is disabled', async () => {
    specs['local'].secret = 'V1';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local', cacheSecrets: false }));
    await r.resolveSecret('TOKEN');
    specs['local'].secret = 'V2';
    const res = await r.resolveSecret('TOKEN');
    // No caching → always fresh, backend hit twice.
    expect(res!.value).toBe('V2');
    expect(specs['local'].getSecretRefs).toHaveLength(2);
  });

  it('honors an explicit per-call backend override', async () => {
    specs['pass'].secret = 'FROM_PASS';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    const res = await r.resolveSecret('TOKEN', { backend: 'pass' });
    expect(res!.backend).toBe('pass');
    expect(res!.value).toBe('FROM_PASS');
  });

  it('returns null when the backend has no value (unresolved, not cached)', async () => {
    specs['local'].secret = null;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    expect(await r.resolveSecret('TOKEN')).toBeNull();
  });

  it('throws BackendNotAvailableError when the chosen backend is not installed', async () => {
    specs['pass'].available = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'pass' }));
    await expect(r.resolveSecret('TOKEN')).rejects.toBeInstanceOf(BackendNotAvailableError);
  });

  it('authenticates when unauthenticated and interactive auth is allowed', async () => {
    specs['pass'].authenticated = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'pass' }));
    await r.resolveSecret('TOKEN');
    expect(specs['pass'].authCalls).toBe(1);
  });

  it('throws BackendAuthenticationError when failOnAuthRequired and unauthenticated', async () => {
    specs['pass'].authenticated = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'pass' }));
    await expect(
      r.resolveSecret('TOKEN', { failOnAuthRequired: true })
    ).rejects.toBeInstanceOf(BackendAuthenticationError);
    // Must fail BEFORE attempting interactive auth.
    expect(specs['pass'].authCalls).toBe(0);
  });

  // ── Batch resolution ─────────────────────────────────────────────────────

  it('resolveAll partitions resolved / unresolved / errors', async () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    // A resolves, B is null (unresolved), C throws (error + unresolved).
    const original = r.resolveSecret.bind(r);
    vi.spyOn(r, 'resolveSecret').mockImplementation(async (name, opts) => {
      if (name === 'A') return original('A', opts);
      if (name === 'B') return null;
      throw new Error('boom C');
    });

    const result = await r.resolveAll(['A', 'B', 'C']);
    expect([...result.resolved.keys()]).toEqual(['A']);
    expect(result.unresolved.sort()).toEqual(['B', 'C']);
    expect(result.errors.get('C')).toBeInstanceOf(Error);
    expect(result.errors.get('C')!.message).toBe('boom C');
  });

  it('resolveAllOrThrow throws UnresolvedSecretsError listing the misses', async () => {
    specs['local'].secret = null; // everything unresolved
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    await expect(r.resolveAllOrThrow(['A', 'B'])).rejects.toBeInstanceOf(
      UnresolvedSecretsError
    );
  });

  it('resolveAllOrThrow returns the resolved map when all resolve', async () => {
    specs['local'].secret = 'V';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    const map = await r.resolveAllOrThrow(['A', 'B']);
    expect(map.get('A')!.value).toBe('V');
    expect(map.get('B')!.value).toBe('V');
  });

  it('resolveToMap flattens to name→value, omitting unresolved names', async () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    vi.spyOn(r, 'resolveSecret').mockImplementation(async (name) => {
      if (name === 'B') return null;
      return { name, value: `val-${name}`, backend: 'local', cached: false };
    });
    const map = await r.resolveToMap(['A', 'B', 'C']);
    expect(map).toEqual({ A: 'val-A', C: 'val-C' });
  });

  // ── Cache invalidation + lock + status + mappings ────────────────────────

  it('invalidateCache forces a refetch of a specific name', async () => {
    specs['local'].secret = 'V1';
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    await r.resolveSecret('TOKEN');
    r.invalidateCache('TOKEN');
    specs['local'].secret = 'V2';
    const res = await r.resolveSecret('TOKEN');
    expect(res!.value).toBe('V2');
    expect(res!.cached).toBe(false);
  });

  it('lockAll locks every backend and swallows per-backend errors', async () => {
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    // Make one backend's lock throw to prove errors are ignored.
    const bw = r.getBackend('bitwarden')!;
    bw.lock = async () => {
      throw new Error('lock fail');
    };
    await expect(r.lockAll()).resolves.toBeUndefined();
    expect(specs['local'].lockCalls).toBe(1);
    expect(specs['pass'].lockCalls).toBe(1);
  });

  it('getBackendStatuses reports availability, auth, and the primary flag', async () => {
    specs['1password'].available = false;
    const r = new SecretResolver(TUCK_DIR, baseConfig({ secretBackend: 'local' }));
    const statuses = await r.getBackendStatuses();

    const local = statuses.find((s) => s.name === 'local')!;
    expect(local.isPrimary).toBe(true);
    expect(local.available).toBe(true);
    expect(local.authenticated).toBe(true);

    const op = statuses.find((s) => s.name === '1password')!;
    expect(op.available).toBe(false);
    // Unavailable backends are reported not-authenticated without probing.
    expect(op.authenticated).toBe(false);
    expect(op.isPrimary).toBe(false);
  });

  it('getMappings delegates to listMappings', async () => {
    h.mapState.listMappings.GITHUB_TOKEN = { pass: 'work/github' };
    const r = new SecretResolver(TUCK_DIR, baseConfig());
    const mappings = await r.getMappings();
    expect(mappings.GITHUB_TOKEN).toEqual({ pass: 'work/github' });
    delete h.mapState.listMappings.GITHUB_TOKEN;
  });
});
