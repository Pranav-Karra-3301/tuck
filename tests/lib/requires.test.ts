/**
 * Unit tests for the declarative dependency model (IDEAS 2.3): spec parsing,
 * collection across a manifest, and topological ordering / cycle detection.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRequirement,
  isValidRequirement,
  parseRequirementList,
  collectRequirements,
  topologicalSort,
  PACKAGE_MANAGERS,
  type DepNode,
} from '../../src/lib/requires.js';
import { InvalidRequirementError, CyclicDependencyError } from '../../src/errors.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('parseRequirement', () => {
  it('parses a valid <manager>:<package> spec', () => {
    expect(parseRequirement('brew:starship')).toEqual({
      raw: 'brew:starship',
      manager: 'brew',
      name: 'starship',
    });
  });

  it('lowercases the manager and trims whitespace', () => {
    expect(parseRequirement('  BREW : starship ')).toEqual({
      raw: 'brew:starship',
      manager: 'brew',
      name: 'starship',
    });
  });

  it('accepts package names that themselves contain a colon (e.g. go modules)', () => {
    const req = parseRequirement('go:golang.org/x/tools/cmd/goimports@latest');
    expect(req.manager).toBe('go');
    expect(req.name).toBe('golang.org/x/tools/cmd/goimports@latest');
  });

  it('supports every declared package manager', () => {
    for (const manager of PACKAGE_MANAGERS) {
      expect(parseRequirement(`${manager}:pkg`).manager).toBe(manager);
    }
  });

  it('throws on a missing manager prefix', () => {
    expect(() => parseRequirement('starship')).toThrow(InvalidRequirementError);
  });

  it('throws on an unknown manager', () => {
    expect(() => parseRequirement('brew2:starship')).toThrow(InvalidRequirementError);
  });

  it('throws on an empty package name', () => {
    expect(() => parseRequirement('brew:')).toThrow(InvalidRequirementError);
  });

  it('throws on an empty spec', () => {
    expect(() => parseRequirement('   ')).toThrow(InvalidRequirementError);
  });
});

describe('isValidRequirement', () => {
  it('mirrors parseRequirement without throwing', () => {
    expect(isValidRequirement('apt:zsh')).toBe(true);
    expect(isValidRequirement('nope:zsh')).toBe(false);
  });
});

describe('parseRequirementList', () => {
  it('splits on commas and whitespace and dedupes, preserving order', () => {
    expect(parseRequirementList('brew:starship, apt:zsh  npm:typescript brew:starship')).toEqual([
      'brew:starship',
      'apt:zsh',
      'npm:typescript',
    ]);
  });

  it('ignores empty segments', () => {
    expect(parseRequirementList(' , , brew:starship , ')).toEqual(['brew:starship']);
  });

  it('throws on any invalid spec in the list (fail fast)', () => {
    expect(() => parseRequirementList('brew:starship, bogus')).toThrow(InvalidRequirementError);
  });
});

describe('collectRequirements', () => {
  it('collects and dedupes valid requirements across files, order-stable', () => {
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship', 'apt:zsh'] }),
        b: createMockTrackedFile({ source: '~/.p10k', requires: ['brew:starship'] }),
      },
    });
    const { requirements, invalid } = collectRequirements(manifest);
    expect(requirements.map((r) => r.raw)).toEqual(['brew:starship', 'apt:zsh']);
    expect(invalid).toEqual([]);
  });

  it('surfaces malformed specs as invalid rather than throwing', () => {
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship', 'bogus:'] }),
      },
    });
    const { requirements, invalid } = collectRequirements(manifest);
    expect(requirements.map((r) => r.raw)).toEqual(['brew:starship']);
    expect(invalid).toEqual(['bogus:']);
  });

  it('treats a missing requires field as no requirements', () => {
    const manifest = createMockManifest({
      files: { a: createMockTrackedFile({ source: '~/.zshrc' }) },
    });
    expect(collectRequirements(manifest).requirements).toEqual([]);
  });
});

describe('topologicalSort', () => {
  it('orders dependencies before dependents', () => {
    const nodes: DepNode[] = [
      { id: 'file', deps: ['pkg'] },
      { id: 'pkg', deps: [] },
    ];
    expect(topologicalSort(nodes)).toEqual(['pkg', 'file']);
  });

  it('is deterministic (stable by original order) for independent nodes', () => {
    const nodes: DepNode[] = [
      { id: 'a', deps: [] },
      { id: 'b', deps: [] },
      { id: 'c', deps: [] },
    ];
    expect(topologicalSort(nodes)).toEqual(['a', 'b', 'c']);
  });

  it('ignores dependencies on unknown (external) ids', () => {
    const nodes: DepNode[] = [{ id: 'file', deps: ['not-a-node'] }];
    expect(topologicalSort(nodes)).toEqual(['file']);
  });

  it('handles a diamond dependency', () => {
    const nodes: DepNode[] = [
      { id: 'top', deps: ['left', 'right'] },
      { id: 'left', deps: ['base'] },
      { id: 'right', deps: ['base'] },
      { id: 'base', deps: [] },
    ];
    const order = topologicalSort(nodes);
    expect(order.indexOf('base')).toBeLessThan(order.indexOf('left'));
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('top'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('top'));
  });

  it('throws CyclicDependencyError on a self-edge', () => {
    expect(() => topologicalSort([{ id: 'a', deps: ['a'] }])).toThrow(CyclicDependencyError);
  });

  it('throws CyclicDependencyError on a multi-node cycle and names the loop', () => {
    const nodes: DepNode[] = [
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['c'] },
      { id: 'c', deps: ['a'] },
    ];
    let error: unknown;
    try {
      topologicalSort(nodes);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CyclicDependencyError);
    expect((error as CyclicDependencyError).cycle.sort()).toEqual(['a', 'b', 'c']);
  });
});
