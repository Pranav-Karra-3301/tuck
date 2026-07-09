import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  isVersionInRange,
} from '../../../src/lib/osSettings/version.js';

describe('parseVersion', () => {
  it('parses dotted numeric versions into integer tuples', () => {
    expect(parseVersion('15.1')).toEqual([15, 1]);
    expect(parseVersion('13.6.1')).toEqual([13, 6, 1]);
    expect(parseVersion('26')).toEqual([26]);
  });

  it('coerces non-numeric components to 0 rather than throwing', () => {
    expect(parseVersion('15.beta')).toEqual([15, 0]);
    expect(parseVersion('')).toEqual([0]);
  });
});

describe('compareVersions', () => {
  it('orders versions component-wise', () => {
    expect(compareVersions('15.1', '15.0')).toBeGreaterThan(0);
    expect(compareVersions('15.0', '15.1')).toBeLessThan(0);
    expect(compareVersions('15', '15.0.0')).toBe(0);
    expect(compareVersions('13.6.1', '13.6')).toBeGreaterThan(0);
    expect(compareVersions('14', '9')).toBeGreaterThan(0);
  });
});

describe('isVersionInRange', () => {
  it('passes when there are no bounds', () => {
    expect(isVersionInRange('15.1').ok).toBe(true);
    expect(isVersionInRange('15.1', null, null).ok).toBe(true);
  });

  it('fails below the minimum', () => {
    const res = isVersionInRange('12.0', '13.0');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('>= 13.0');
  });

  it('fails above the maximum', () => {
    const res = isVersionInRange('15.0', null, '14.0');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('<= 14.0');
  });

  it('passes at the inclusive boundaries', () => {
    expect(isVersionInRange('13.0', '13.0', '15.0').ok).toBe(true);
    expect(isVersionInRange('15.0', '13.0', '15.0').ok).toBe(true);
  });

  it('passes an empty current version (undetectable OS must not block apply)', () => {
    expect(isVersionInRange('', '13.0', '14.0').ok).toBe(true);
  });
});
