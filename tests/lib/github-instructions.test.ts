import { describe, it, expect } from 'vitest';
import { getClassicTokenInstructions, getFineGrainedTokenInstructions } from '../../src/lib/github.js';

describe('github token setup instructions', () => {
  it('does not recommend insecure credential.helper store for fine-grained tokens', () => {
    const instructions = getFineGrainedTokenInstructions('dotfiles');
    expect(instructions).not.toContain('credential.helper store');
    expect(instructions).toContain('credential.helper osxkeychain');
    expect(instructions).toContain('credential.helper libsecret');
    expect(instructions).toContain('credential.helper manager-core');
    expect(instructions).toContain('gh auth setup-git');
  });

  it('does not recommend insecure credential.helper store for classic tokens', () => {
    const instructions = getClassicTokenInstructions();
    expect(instructions).not.toContain('credential.helper store');
    expect(instructions).toContain('credential.helper osxkeychain');
    expect(instructions).toContain('credential.helper libsecret');
    expect(instructions).toContain('credential.helper manager-core');
    expect(instructions).toContain('gh auth setup-git');
  });
});
