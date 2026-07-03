/**
 * generateFileId collision regression tests.
 *
 * Historically `generateFileId` stripped the leading dot off a home-root entry,
 * so `~/.foo` and `~/foo` BOTH collapsed to the id `foo`. Tracking the second
 * file then produced a misleading "already tracked" error. The id must be
 * injective: structurally distinct source paths must map to distinct ids.
 *
 * Separately, on case-insensitive filesystems (macOS/Windows) two destinations
 * that differ only in case (`config` vs `Config`) resolve to ONE physical repo
 * file, so we must be able to detect that collision before writing.
 */
import { describe, it, expect } from 'vitest';
import {
  generateFileId,
  destinationsCollideCaseInsensitively,
} from '../../src/lib/paths.js';

describe('generateFileId injectivity', () => {
  it('maps ~/.foo and ~/foo to DIFFERENT ids (no leading-dot collision)', () => {
    expect(generateFileId('~/.foo')).not.toBe(generateFileId('~/foo'));
  });

  it('keeps existing exact ids for common dotfiles (backward compatible)', () => {
    expect(generateFileId('~/.zshrc')).toBe('zshrc');
    expect(generateFileId('~/.config/nvim')).toBe('config_nvim');
  });

  it('is deterministic for a given path', () => {
    expect(generateFileId('~/foo')).toBe(generateFileId('~/foo'));
  });

  it('always produces a safe id', () => {
    expect(generateFileId('~/foo')).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(generateFileId('~/.foo')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('case-insensitive destination collisions', () => {
  it('flags two destinations that differ only by case', () => {
    expect(
      destinationsCollideCaseInsensitively('files/misc/config', 'files/misc/Config')
    ).toBe(true);
  });

  it('does not flag genuinely distinct destinations', () => {
    expect(
      destinationsCollideCaseInsensitively('files/misc/config', 'files/misc/nvim')
    ).toBe(false);
  });

  it('treats an identical destination as a collision', () => {
    expect(
      destinationsCollideCaseInsensitively('files/misc/config', 'files/misc/config')
    ).toBe(true);
  });
});
