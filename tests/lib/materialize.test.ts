import { describe, it, expect } from 'vitest';
import { materializeForLive } from '../../src/lib/materialize.js';
import { encryptFileContent } from '../../src/lib/crypto/fileEncryption.js';
import { MaterializeError } from '../../src/errors.js';

const ctx = { os: 'darwin', hostname: 'mac1' };
const deps = (pass: string | null = 'pw') => ({ getPassphrase: async () => pass });

describe('materializeForLive', () => {
  it('renders a template file using the context', async () => {
    const repo = Buffer.from('host={{hostname}} os={{os}}');
    const out = await materializeForLive(
      repo,
      { template: true, encrypted: false, source: '~/.x' },
      ctx,
      deps()
    );
    expect(out).toBe('host=mac1 os=darwin');
  });

  it('passes plain non-template files through unchanged', async () => {
    const repo = Buffer.from('literal {{kept-because-not-a-template}}');
    const out = await materializeForLive(
      repo,
      { template: false, encrypted: false, source: '~/.x' },
      ctx,
      deps()
    );
    expect(out).toBe('literal {{kept-because-not-a-template}}');
  });

  it('decrypts an encrypted file', async () => {
    const repo = await encryptFileContent(Buffer.from('secret-body'), 'pw');
    const out = await materializeForLive(
      repo,
      { template: false, encrypted: true, source: '~/.s' },
      ctx,
      deps('pw')
    );
    expect(out).toBe('secret-body');
  });

  it('decrypts THEN renders for encrypted+template files', async () => {
    const repo = await encryptFileContent(Buffer.from('os={{os}}'), 'pw');
    const out = await materializeForLive(
      repo,
      { template: true, encrypted: true, source: '~/.s' },
      ctx,
      deps('pw')
    );
    expect(out).toBe('os=darwin');
  });

  it('decrypts a file detected by magic header even if the flag is unset', async () => {
    const repo = await encryptFileContent(Buffer.from('detected'), 'pw');
    const out = await materializeForLive(
      repo,
      { template: false, encrypted: false, source: '~/.s' },
      ctx,
      deps('pw')
    );
    expect(out).toBe('detected');
  });

  it('throws MaterializeError when an encrypted file has no passphrase', async () => {
    const repo = await encryptFileContent(Buffer.from('x'), 'pw');
    await expect(
      materializeForLive(
        repo,
        { template: false, encrypted: true, source: '~/.s' },
        ctx,
        deps(null)
      )
    ).rejects.toBeInstanceOf(MaterializeError);
  });

  it('throws MaterializeError on a wrong passphrase (never returns ciphertext)', async () => {
    const repo = await encryptFileContent(Buffer.from('x'), 'right');
    await expect(
      materializeForLive(
        repo,
        { template: false, encrypted: true, source: '~/.s' },
        ctx,
        deps('wrong')
      )
    ).rejects.toBeInstanceOf(MaterializeError);
  });
});
