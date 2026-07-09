/**
 * A focused parser for the XML property lists that `defaults export <domain> -`
 * emits. We only need enough of the format to answer two questions during
 * capture: which top-level preference keys exist, and did a given key's value
 * change between two snapshots. We therefore parse the standard Apple plist XML
 * into a plain JS value tree and expose a canonical, stable string per top-level
 * key for diffing.
 *
 * This is deliberately NOT a general-purpose plist library — it handles the tag
 * vocabulary Apple's exporter uses (dict/array/key/string/integer/real/true/
 * false/date/data) and decodes the five predefined XML entities. Anything it
 * cannot classify becomes a string, which is safe for diffing (a change is still
 * detected) even if the type inference then declines to auto-apply it.
 */

export type PlistScalar =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: number }
  | { kind: 'real'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'data'; value: string };

export type PlistValue =
  | PlistScalar
  | { kind: 'dict'; value: Map<string, PlistValue> }
  | { kind: 'array'; value: PlistValue[] };

type Token =
  | { t: 'open'; name: string; selfClose: boolean }
  | { t: 'close'; name: string }
  | { t: 'text'; value: string };

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last so we don't double-decode e.g. "&amp;lt;".
    .replace(/&amp;/g, '&');

/** Tokenize plist XML into a flat tag/text stream, skipping the XML prolog. */
const tokenize = (xml: string): Token[] => {
  const tokens: Token[] = [];
  const re = /<([^>]*)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // Capture any text between the previous tag and this one.
    const text = xml.slice(lastIndex, m.index);
    if (text.trim().length > 0) {
      tokens.push({ t: 'text', value: decodeEntities(text) });
    }
    lastIndex = re.lastIndex;

    const inner = m[1].trim();
    // Skip declarations, doctypes, comments, and processing instructions.
    if (inner.startsWith('?') || inner.startsWith('!')) continue;

    if (inner.startsWith('/')) {
      tokens.push({ t: 'close', name: inner.slice(1).trim() });
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1).trim() : inner;
    const name = body.split(/\s/)[0];
    tokens.push({ t: 'open', name, selfClose });
  }
  return tokens;
};

class Cursor {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  next(): Token | undefined {
    return this.tokens[this.i++];
  }
}

const parseValue = (cur: Cursor): PlistValue => {
  const open = cur.next();
  if (!open || open.t !== 'open') {
    throw new Error('Malformed plist: expected a value element');
  }

  const readText = (closeName: string): string => {
    let text = '';
    for (;;) {
      const tok = cur.next();
      if (!tok) throw new Error(`Malformed plist: unterminated <${closeName}>`);
      if (tok.t === 'text') text += tok.value;
      else if (tok.t === 'close' && tok.name === closeName) break;
      else throw new Error(`Malformed plist: unexpected token in <${closeName}>`);
    }
    return text;
  };

  switch (open.name) {
    case 'true':
      return { kind: 'boolean', value: true };
    case 'false':
      return { kind: 'boolean', value: false };
    case 'string':
      return { kind: 'string', value: open.selfClose ? '' : readText('string') };
    case 'integer': {
      const raw = open.selfClose ? '0' : readText('integer');
      return { kind: 'integer', value: Number.parseInt(raw.trim(), 10) };
    }
    case 'real': {
      const raw = open.selfClose ? '0' : readText('real');
      return { kind: 'real', value: Number.parseFloat(raw.trim()) };
    }
    case 'date':
      return { kind: 'date', value: open.selfClose ? '' : readText('date').trim() };
    case 'data':
      return { kind: 'data', value: open.selfClose ? '' : readText('data').replace(/\s+/g, '') };
    case 'dict': {
      const map = new Map<string, PlistValue>();
      if (open.selfClose) return { kind: 'dict', value: map };
      for (;;) {
        const tok = cur.peek();
        if (!tok) throw new Error('Malformed plist: unterminated <dict>');
        if (tok.t === 'close' && tok.name === 'dict') {
          cur.next();
          break;
        }
        // Expect <key>...</key>
        const keyOpen = cur.next();
        if (!keyOpen || keyOpen.t !== 'open' || keyOpen.name !== 'key') {
          throw new Error('Malformed plist: expected <key> in <dict>');
        }
        const keyName = keyOpen.selfClose ? '' : readText('key');
        const value = parseValue(cur);
        map.set(keyName, value);
      }
      return { kind: 'dict', value: map };
    }
    case 'array': {
      const items: PlistValue[] = [];
      if (open.selfClose) return { kind: 'array', value: items };
      for (;;) {
        const tok = cur.peek();
        if (!tok) throw new Error('Malformed plist: unterminated <array>');
        if (tok.t === 'close' && tok.name === 'array') {
          cur.next();
          break;
        }
        items.push(parseValue(cur));
      }
      return { kind: 'array', value: items };
    }
    default:
      // Unknown scalar-ish element: consume any text up to its close and treat
      // as a string so diffing still works.
      if (open.selfClose) return { kind: 'string', value: '' };
      return { kind: 'string', value: readText(open.name) };
  }
};

/** Parse a full plist document and return its root value. */
export const parsePlist = (xml: string): PlistValue => {
  const tokens = tokenize(xml);
  const cur = new Cursor(tokens);
  // Advance to the <plist> wrapper, then parse its single child value.
  for (;;) {
    const tok = cur.peek();
    if (!tok) throw new Error('Malformed plist: no <plist> root');
    if (tok.t === 'open' && tok.name === 'plist') {
      cur.next();
      break;
    }
    cur.next();
  }
  return parseValue(cur);
};

/** A canonical, order-stable serialization used purely to diff two snapshots. */
export const stableStringify = (value: PlistValue): string => {
  switch (value.kind) {
    case 'dict': {
      const parts = [...value.value.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
      return `{${parts.join(',')}}`;
    }
    case 'array':
      return `[${value.value.map(stableStringify).join(',')}]`;
    default:
      return `${value.kind}(${JSON.stringify(value.value)})`;
  }
};

/**
 * Extract the top-level preference entries from an exported domain plist.
 * Returns a map of key -> parsed value for the root `<dict>`. A domain whose
 * root is not a dict (empty domain, or an array root) yields an empty map.
 */
export const topLevelEntries = (xml: string): Map<string, PlistValue> => {
  const root = parsePlist(xml);
  if (root.kind !== 'dict') return new Map();
  return root.value;
};
