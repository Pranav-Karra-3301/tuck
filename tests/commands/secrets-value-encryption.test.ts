/**
 * Integration test for `tuck secrets encrypt` / `tuck secrets decrypt`.
 *
 * Drives the real command run-functions end to end against memfs temp files
 * (never the real HOME/keystore). External seams — manifest, config, keystore,
 * and time-machine snapshots — are mocked; the scanner and value-encryption
 * crypto are the real implementations, so this exercises the full
 * scan → encrypt → decrypt round trip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

// --- Mocks for external seams ------------------------------------------------

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const getStoredPasswordMock = vi.fn();
const createSnapshotMock = vi.fn();

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: (...args: unknown[]) => loadManifestMock(...args),
  getAllTrackedFiles: (...args: unknown[]) => getAllTrackedFilesMock(...args),
}));

vi.mock('../../src/lib/crypto/index.js', () => ({
  getStoredPassword: (...args: unknown[]) => getStoredPasswordMock(...args),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createSnapshot: (...args: unknown[]) => createSnapshotMock(...args),
}));

// scanForSecrets loads config; return a minimal built-in-scanner config.
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(async () => ({ security: {} })),
  saveConfig: vi.fn(async () => {}),
}));

// Silence UI; the run-functions never prompt in non-interactive mode.
vi.mock('../../src/ui/index.js', () => {
  const passthrough = (v: string) => v;
  const c = Object.assign(passthrough, {
    bold: Object.assign(passthrough, { cyan: passthrough }),
    dim: passthrough,
    cyan: passthrough,
    green: passthrough,
    red: passthrough,
    yellow: passthrough,
  });
  return {
    prompts: {
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => ''),
      spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
      log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
      intro: vi.fn(),
      outro: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      dim: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      heading: vi.fn(),
    },
    colors: c,
  };
});

import {
  runSecretsEncryptValues,
  runSecretsDecryptValues,
} from '../../src/commands/secrets.js';

describe('tuck secrets encrypt/decrypt (integration)', () => {
  const envPath = join(TEST_HOME, '.env');
  const originalIsTty = process.stdout.isTTY;
  const originalEnvPass = process.env.TUCK_ENCRYPTION_PASSWORD;

  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    // Non-interactive: no prompts, passphrase from env.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    process.env.TUCK_ENCRYPTION_PASSWORD = 'test-passphrase-123';

    loadManifestMock.mockResolvedValue({});
    getAllTrackedFilesMock.mockResolvedValue({
      env: { source: envPath },
    });
    getStoredPasswordMock.mockResolvedValue(null);
    createSnapshotMock.mockResolvedValue({ id: 'snap-1' });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTty,
      configurable: true,
    });
    if (originalEnvPass === undefined) {
      delete process.env.TUCK_ENCRYPTION_PASSWORD;
    } else {
      process.env.TUCK_ENCRYPTION_PASSWORD = originalEnvPass;
    }
    vol.reset();
  });

  it('encrypts detected values in place and decrypts them back', async () => {
    const original = [
      '# app config',
      'HOST=localhost',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'GITHUB_TOKEN=ghp_0123456789abcdefABCDEF0123456789abcd',
    ].join('\n');
    vol.writeFileSync(envPath, original);

    await runSecretsEncryptValues([], { yes: true });

    const encrypted = vol.readFileSync(envPath, 'utf-8') as string;
    // Structure/keys/comments preserved; secrets replaced with tokens.
    expect(encrypted).toContain('# app config');
    expect(encrypted).toContain('HOST=localhost');
    expect(encrypted).toContain('ENC[tuck:v1:');
    expect(encrypted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(encrypted).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
    // A pre-mutation snapshot was taken.
    expect(createSnapshotMock).toHaveBeenCalled();

    await runSecretsDecryptValues([], { yes: true });

    expect(vol.readFileSync(envPath, 'utf-8')).toBe(original);
  });

  it('is a no-op when there are no secret values to encrypt', async () => {
    vol.writeFileSync(envPath, 'HOST=localhost\nPORT=8080\n');
    await runSecretsEncryptValues([], { yes: true });
    expect(vol.readFileSync(envPath, 'utf-8')).toBe('HOST=localhost\nPORT=8080\n');
  });

  it('emits a JSON envelope without leaking secret values', async () => {
    vol.writeFileSync(envPath, 'GITHUB_TOKEN=ghp_0123456789abcdefABCDEF0123456789abcd\n');
    let output = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      await runSecretsEncryptValues([envPath], { json: true, yes: true });
    } finally {
      writeSpy.mockRestore();
    }
    expect(output).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
    expect(output).toContain('valuesEncrypted');
  });
});
