import { describe, it, expect } from 'vitest';
import {
  inferWriteFromValue,
  diffSnapshots,
  diffDomains,
  settingId,
} from '../../../src/lib/osSettings/capture.js';
import type { PlistValue } from '../../../src/lib/osSettings/plist.js';
import type { DomainSnapshot } from '../../../src/lib/osSettings/types.js';

const snap = (domain: string, entries: Record<string, PlistValue>): DomainSnapshot => ({
  domain,
  entries: new Map(Object.entries(entries)),
});

describe('inferWriteFromValue', () => {
  it('maps scalars to defaults types and string forms', () => {
    expect(inferWriteFromValue({ kind: 'boolean', value: true })).toEqual({
      type: 'boolean',
      value: 'true',
    });
    expect(inferWriteFromValue({ kind: 'integer', value: 48 })).toEqual({
      type: 'integer',
      value: '48',
    });
    expect(inferWriteFromValue({ kind: 'real', value: 1.5 })).toEqual({
      type: 'float',
      value: '1.5',
    });
    expect(inferWriteFromValue({ kind: 'string', value: 'Dark' })).toEqual({
      type: 'string',
      value: 'Dark',
    });
  });

  it('returns null for containers and opaque data', () => {
    expect(inferWriteFromValue({ kind: 'array', value: [] })).toBeNull();
    expect(inferWriteFromValue({ kind: 'dict', value: new Map() })).toBeNull();
    expect(inferWriteFromValue({ kind: 'data', value: 'AAAA' })).toBeNull();
  });
});

describe('diffSnapshots', () => {
  it('detects an added key as a write change', () => {
    const before = snap('com.apple.dock', {});
    const after = snap('com.apple.dock', { autohide: { kind: 'boolean', value: true } });
    expect(diffSnapshots(before, after)).toEqual([
      {
        domain: 'com.apple.dock',
        key: 'autohide',
        action: 'write',
        type: 'boolean',
        value: 'true',
      },
    ]);
  });

  it('detects a changed value', () => {
    const before = snap('d', { tilesize: { kind: 'integer', value: 48 } });
    const after = snap('d', { tilesize: { kind: 'integer', value: 64 } });
    expect(diffSnapshots(before, after)).toEqual([
      { domain: 'd', key: 'tilesize', action: 'write', type: 'integer', value: '64' },
    ]);
  });

  it('ignores unchanged keys', () => {
    const same = { autohide: { kind: 'boolean', value: true } as PlistValue };
    expect(diffSnapshots(snap('d', same), snap('d', same))).toEqual([]);
  });

  it('detects a removed key as a delete change', () => {
    const before = snap('d', { orient: { kind: 'string', value: 'left' } });
    const after = snap('d', {});
    expect(diffSnapshots(before, after)).toEqual([
      { domain: 'd', key: 'orient', action: 'delete' },
    ]);
  });

  it('flags an unsupported (container) new value', () => {
    const before = snap('d', {});
    const after = snap('d', { persistent: { kind: 'array', value: [] } });
    expect(diffSnapshots(before, after)).toEqual([
      { domain: 'd', key: 'persistent', action: 'write', unsupported: true },
    ]);
  });

  it('throws on a domain mismatch', () => {
    expect(() => diffSnapshots(snap('a', {}), snap('b', {}))).toThrow(/domain mismatch/);
  });
});

describe('diffDomains', () => {
  it('treats a domain absent in the before set as empty', () => {
    const after = [snap('new.domain', { k: { kind: 'boolean', value: false } })];
    expect(diffDomains([], after)).toEqual([
      { domain: 'new.domain', key: 'k', action: 'write', type: 'boolean', value: 'false' },
    ]);
  });
});

describe('settingId', () => {
  it('is stable and slugified per (os, domain, key)', () => {
    expect(settingId('macos', 'com.apple.dock', 'autohide')).toBe(
      'macos__com.apple.dock__autohide'
    );
  });
});
