/**
 * Unit tests for the declarative bootstrap plan (IDEAS 2.3): topological package
 * ordering, phase structure, bundle-scoped file counts, and formatting.
 */
import { describe, it, expect } from 'vitest';
import { buildBootstrapPlan, formatPlan, planToJson } from '../../src/lib/bootstrapPlan.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('buildBootstrapPlan', () => {
  it('collects packages in topological order (dependencies of files first)', () => {
    const manifest = createMockManifest({
      files: {
        zsh: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship', 'apt:zsh'] }),
        git: createMockTrackedFile({ source: '~/.gitconfig', requires: ['brew:git'] }),
      },
    });
    const plan = buildBootstrapPlan(manifest);
    expect(plan.packages.map((p) => p.raw)).toEqual(['brew:starship', 'apt:zsh', 'brew:git']);
    expect(plan.fileCount).toBe(2);
  });

  it('builds packages → files phases, omitting empty phases', () => {
    const manifest = createMockManifest({
      files: {
        zsh: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }),
      },
    });
    const plan = buildBootstrapPlan(manifest);
    expect(plan.phases.map((p) => p.id)).toEqual(['packages', 'files']);
    expect(plan.phases[0].steps[0].label).toBe('brew:starship');
    expect(plan.phases[1].steps[0].label).toBe('1 file');
  });

  it('reports a files-only plan when no requirements are declared', () => {
    const manifest = createMockManifest({
      files: { zsh: createMockTrackedFile({ source: '~/.zshrc' }) },
    });
    const plan = buildBootstrapPlan(manifest);
    expect(plan.packages).toEqual([]);
    expect(plan.phases.map((p) => p.id)).toEqual(['files']);
  });

  it('includes a hooks phase when hooks are supplied', () => {
    const manifest = createMockManifest({
      files: { zsh: createMockTrackedFile({ source: '~/.zshrc' }) },
    });
    const plan = buildBootstrapPlan(manifest, { hooks: ['echo done'] });
    expect(plan.phases.map((p) => p.id)).toEqual(['files', 'hooks']);
    expect(plan.hooks).toEqual(['echo done']);
  });

  it('scopes the file count to a bundle', () => {
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({ source: '~/.zshrc', bundle: 'work' }),
        b: createMockTrackedFile({ source: '~/.gitconfig', bundle: 'default' }),
      },
    });
    expect(buildBootstrapPlan(manifest, { bundle: 'work' }).fileCount).toBe(1);
    expect(buildBootstrapPlan(manifest).fileCount).toBe(2);
  });

  it('surfaces invalid requirement specs without failing', () => {
    const manifest = createMockManifest({
      files: {
        a: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship', 'oops'] }),
      },
    });
    const plan = buildBootstrapPlan(manifest);
    expect(plan.packages.map((p) => p.raw)).toEqual(['brew:starship']);
    expect(plan.invalidRequirements).toEqual(['oops']);
  });
});

describe('formatPlan', () => {
  it('renders numbered phases with indented steps', () => {
    const manifest = createMockManifest({
      files: { zsh: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
    });
    const text = formatPlan(buildBootstrapPlan(manifest));
    expect(text).toContain('1. Install packages');
    expect(text).toContain('brew:starship');
    expect(text).toContain('2. Apply dotfiles');
  });

  it('reports an empty plan', () => {
    const plan = buildBootstrapPlan(createMockManifest({ files: {} }));
    expect(formatPlan(plan)).toContain('Nothing to do');
  });
});

describe('planToJson', () => {
  it('projects a stable JSON shape', () => {
    const manifest = createMockManifest({
      files: { zsh: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
    });
    const json = planToJson(buildBootstrapPlan(manifest));
    expect(json.packages).toEqual([{ raw: 'brew:starship', manager: 'brew', name: 'starship' }]);
    expect(json.fileCount).toBe(1);
    expect(json.phases.map((p) => p.id)).toEqual(['packages', 'files']);
  });
});
