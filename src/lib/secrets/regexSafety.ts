/**
 * Safety checks for user-supplied regex patterns.
 *
 * JavaScript regex execution cannot be interrupted mid-exec(), so custom
 * patterns must be validated before they are allowed in the scanner.
 */

const MAX_CUSTOM_PATTERN_LENGTH = 500;
const MAX_GROUP_DEPTH = 16;
const ALLOWED_CUSTOM_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'y']);

interface GroupState {
  hasVariableQuantifier: boolean;
  hasAlternation: boolean;
}

type LastTokenType = 'none' | 'literal' | 'group' | 'quantifier';

interface LastToken {
  type: LastTokenType;
  group?: GroupState;
}

interface BraceQuantifier {
  endIndex: number;
  variable: boolean;
  unbounded: boolean;
}

const parseBraceQuantifier = (source: string, start: number): BraceQuantifier | null => {
  if (source[start] !== '{') {
    return null;
  }

  let index = start + 1;
  let min = '';
  let max = '';
  let hasComma = false;

  while (index < source.length && /[0-9]/.test(source[index])) {
    min += source[index];
    index++;
  }

  if (source[index] === ',') {
    hasComma = true;
    index++;
    while (index < source.length && /[0-9]/.test(source[index])) {
      max += source[index];
      index++;
    }
  }

  if (source[index] !== '}') {
    return null;
  }

  if (min.length === 0) {
    return null;
  }

  const unbounded = hasComma && max.length === 0;
  const variable = hasComma && (max.length === 0 || max !== min);
  return { endIndex: index, variable, unbounded };
};

const getSafetyIssue = (source: string): string | null => {
  const stack: GroupState[] = [{ hasVariableQuantifier: false, hasAlternation: false }];
  let lastToken: LastToken = { type: 'none' };
  let inCharClass = false;

  for (let i = 0; i < source.length; ) {
    const char = source[i];

    // Handle escapes and detect backreferences (\1, \2, \k<name>)
    if (char === '\\') {
      const next = source[i + 1];
      if (next && /[1-9]/.test(next)) {
        return 'backreferences are not allowed';
      }
      if (next === 'k' && source[i + 2] === '<') {
        return 'named backreferences are not allowed';
      }
      lastToken = { type: 'literal' };
      i += 2;
      continue;
    }

    if (inCharClass) {
      if (char === ']') {
        inCharClass = false;
      }
      i++;
      continue;
    }

    if (char === '[') {
      inCharClass = true;
      lastToken = { type: 'literal' };
      i++;
      continue;
    }

    if (char === '(') {
      if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
        return 'lookbehind assertions are not allowed';
      }
      stack.push({ hasVariableQuantifier: false, hasAlternation: false });
      if (stack.length > MAX_GROUP_DEPTH) {
        return `pattern nesting is too deep (max ${MAX_GROUP_DEPTH} groups)`;
      }
      lastToken = { type: 'none' };
      i++;
      continue;
    }

    if (char === ')') {
      if (stack.length > 1) {
        const closed = stack.pop();
        lastToken = { type: 'group', group: closed };
      } else {
        lastToken = { type: 'literal' };
      }
      i++;
      continue;
    }

    if (char === '|') {
      stack[stack.length - 1].hasAlternation = true;
      lastToken = { type: 'none' };
      i++;
      continue;
    }

    const braceQuantifier = parseBraceQuantifier(source, i);
    if (braceQuantifier && (lastToken.type === 'literal' || lastToken.type === 'group')) {
      if (braceQuantifier.variable) {
        stack[stack.length - 1].hasVariableQuantifier = true;
      }

      if (lastToken.type === 'group' && braceQuantifier.unbounded) {
        if (lastToken.group?.hasVariableQuantifier) {
          return 'nested quantified groups are not allowed';
        }
        if (lastToken.group?.hasAlternation) {
          return 'unbounded quantifiers on alternation groups are not allowed';
        }
      }

      lastToken = { type: 'quantifier' };
      i = braceQuantifier.endIndex + 1;
      if (source[i] === '?') {
        i++;
      }
      continue;
    }

    if ((char === '*' || char === '+' || char === '?') && (lastToken.type === 'literal' || lastToken.type === 'group')) {
      stack[stack.length - 1].hasVariableQuantifier = true;

      const unbounded = char === '*' || char === '+';
      if (lastToken.type === 'group' && unbounded) {
        if (lastToken.group?.hasVariableQuantifier) {
          return 'nested quantified groups are not allowed';
        }
        if (lastToken.group?.hasAlternation) {
          return 'unbounded quantifiers on alternation groups are not allowed';
        }
      }

      lastToken = { type: 'quantifier' };
      i++;
      if (source[i] === '?') {
        i++;
      }
      continue;
    }

    lastToken = { type: 'literal' };
    i++;
  }

  return null;
};

export const normalizeCustomRegexFlags = (flags = 'g'): string => {
  const merged = `${flags}g`;
  let normalized = '';
  const seen = new Set<string>();

  for (const flag of merged) {
    if (!ALLOWED_CUSTOM_REGEX_FLAGS.has(flag)) {
      throw new Error(`Unsupported regex flag "${flag}" in custom pattern`);
    }
    if (!seen.has(flag)) {
      seen.add(flag);
      normalized += flag;
    }
  }

  return normalized;
};

export const assertSafeCustomRegex = (source: string): void => {
  if (!source.trim()) {
    throw new Error('Custom pattern cannot be empty');
  }

  if (source.length > MAX_CUSTOM_PATTERN_LENGTH) {
    throw new Error(`Custom pattern is too long (${source.length} > ${MAX_CUSTOM_PATTERN_LENGTH})`);
  }

  const issue = getSafetyIssue(source);
  if (issue) {
    throw new Error(`Unsafe custom regex pattern rejected: ${issue}`);
  }
};
