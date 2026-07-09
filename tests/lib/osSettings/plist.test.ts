import { describe, it, expect } from 'vitest';
import {
  parsePlist,
  topLevelEntries,
  stableStringify,
  type PlistValue,
} from '../../../src/lib/osSettings/plist.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AppleInterfaceStyle</key>
\t<string>Dark</string>
\t<key>autohide</key>
\t<true/>
\t<key>showhidden</key>
\t<false/>
\t<key>tilesize</key>
\t<integer>48</integer>
\t<key>ratio</key>
\t<real>1.5</real>
\t<key>nested</key>
\t<dict>
\t\t<key>inner</key>
\t\t<integer>1</integer>
\t</dict>
\t<key>list</key>
\t<array>
\t\t<string>a</string>
\t\t<integer>2</integer>
\t</array>
\t<key>amp</key>
\t<string>a &amp; b &lt;c&gt;</string>
</dict>
</plist>`;

describe('parsePlist / topLevelEntries', () => {
  it('parses all standard scalar and container types', () => {
    const entries = topLevelEntries(SAMPLE);
    expect(entries.get('AppleInterfaceStyle')).toEqual({ kind: 'string', value: 'Dark' });
    expect(entries.get('autohide')).toEqual({ kind: 'boolean', value: true });
    expect(entries.get('showhidden')).toEqual({ kind: 'boolean', value: false });
    expect(entries.get('tilesize')).toEqual({ kind: 'integer', value: 48 });
    expect(entries.get('ratio')).toEqual({ kind: 'real', value: 1.5 });

    const nested = entries.get('nested');
    expect(nested?.kind).toBe('dict');

    const list = entries.get('list');
    expect(list?.kind).toBe('array');
  });

  it('decodes XML entities in string values', () => {
    const entries = topLevelEntries(SAMPLE);
    expect(entries.get('amp')).toEqual({ kind: 'string', value: 'a & b <c>' });
  });

  it('returns an empty map for an empty (self-closing) root dict', () => {
    const empty = `<?xml version="1.0"?><plist version="1.0"><dict/></plist>`;
    expect(topLevelEntries(empty).size).toBe(0);
  });

  it('returns an empty map when the root is not a dict', () => {
    const arr = `<plist version="1.0"><array><string>x</string></array></plist>`;
    expect(topLevelEntries(arr).size).toBe(0);
  });
});

describe('stableStringify', () => {
  it('is order-independent for dicts', () => {
    const a: PlistValue = {
      kind: 'dict',
      value: new Map<string, PlistValue>([
        ['b', { kind: 'integer', value: 2 }],
        ['a', { kind: 'integer', value: 1 }],
      ]),
    };
    const b: PlistValue = {
      kind: 'dict',
      value: new Map<string, PlistValue>([
        ['a', { kind: 'integer', value: 1 }],
        ['b', { kind: 'integer', value: 2 }],
      ]),
    };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('distinguishes changed scalar values', () => {
    const before = topLevelEntries(SAMPLE).get('tilesize')!;
    const after: PlistValue = { kind: 'integer', value: 64 };
    expect(stableStringify(before)).not.toBe(stableStringify(after));
  });

  it('round-trips a document through parsePlist without throwing', () => {
    expect(() => parsePlist(SAMPLE)).not.toThrow();
  });
});
