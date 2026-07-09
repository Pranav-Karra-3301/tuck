/**
 * Self-contained line-level Myers diff + unified-patch hunk builder.
 *
 * This is a minimal, dependency-free port of the pieces of the MIT-licensed
 * `jsdiff` package (`diffLines` + `structuredPatch`) that `tuck diff` relies on.
 * It is vendored deliberately: pulling in the whole `diff` package as a runtime
 * dependency for one function is not worth the supply-chain surface, and the
 * behaviour we need — a real Myers edit script so inserted/deleted lines are
 * aligned rather than positionally index-matched — is small and stable.
 *
 * Only the subset used by src/commands/diff.ts is implemented: `structuredPatch`
 * with a `context` window. The output shape (hunk ranges + `lines` prefixed with
 * ' ', '-', '+', or a "\ No newline at end of file" marker) matches jsdiff so the
 * existing renderer and tests are unaffected.
 */

/** A single change component in a line diff. */
interface Change {
  /** Number of line-tokens this component spans. */
  count: number;
  /** The concatenated line-token text (newlines preserved). */
  value: string;
  /** True when these lines were added on the "new" side. */
  added: boolean;
  /** True when these lines were removed from the "old" side. */
  removed: boolean;
}

/** Internal linked-list node used while walking the edit graph. */
interface Component {
  count: number;
  added: boolean;
  removed: boolean;
  previousComponent: Component | undefined;
  value?: string;
}

/** A frontier path through Myers's edit graph. */
interface Path {
  oldPos: number;
  lastComponent: Component | undefined;
}

/** A single unified-diff hunk. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Result of {@link structuredPatch}: file headers plus hunks. */
export interface StructuredPatch {
  oldFileName: string;
  newFileName: string;
  oldHeader: string | undefined;
  newHeader: string | undefined;
  hunks: Hunk[];
}

/** Options accepted by {@link structuredPatch}. */
export interface StructuredPatchOptions {
  /** Number of unchanged context lines to keep around each change (default 4). */
  context?: number;
}

/**
 * Split a string into line-tokens, keeping the trailing newline attached to each
 * line (matching jsdiff's line tokenizer). A string ending in a newline does not
 * produce a trailing empty token.
 */
function tokenize(value: string): string[] {
  const retLines: string[] = [];
  const linesAndNewlines = value.split(/(\n|\r\n)/);

  // Ignore the final empty token that occurs if the string ends with a newline.
  if (linesAndNewlines.length > 0 && !linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }

  // Merge each line's content with its following separator into one token.
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 === 1) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }

  return retLines;
}

function removeEmpty(array: string[]): string[] {
  const ret: string[] = [];
  for (const item of array) {
    if (item) {
      ret.push(item);
    }
  }
  return ret;
}

function addToPath(path: Path, added: boolean, removed: boolean, oldPosInc: number): Path {
  const last = path.lastComponent;
  if (last && last.added === added && last.removed === removed) {
    return {
      oldPos: path.oldPos + oldPosInc,
      lastComponent: {
        count: last.count + 1,
        added,
        removed,
        previousComponent: last.previousComponent,
      },
    };
  }
  return {
    oldPos: path.oldPos + oldPosInc,
    lastComponent: { count: 1, added, removed, previousComponent: last },
  };
}

/**
 * Extend `basePath` along the diagonal as far as the tokens are equal, recording
 * the common run. Returns the new position in the "new" token array.
 */
function extractCommon(
  basePath: Path,
  newTokens: string[],
  oldTokens: string[],
  diagonalPath: number
): number {
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let oldPos = basePath.oldPos;
  let newPos = oldPos - diagonalPath;
  let commonCount = 0;

  while (
    newPos + 1 < newLen &&
    oldPos + 1 < oldLen &&
    oldTokens[oldPos + 1] === newTokens[newPos + 1]
  ) {
    newPos++;
    oldPos++;
    commonCount++;
  }

  if (commonCount) {
    basePath.lastComponent = {
      count: commonCount,
      previousComponent: basePath.lastComponent,
      added: false,
      removed: false,
    };
  }

  basePath.oldPos = oldPos;
  return newPos;
}

/**
 * Convert the reversed linked list of components into an ordered array of
 * {@link Change} objects, filling in each component's `value` from the tokens.
 */
function buildValues(
  lastComponent: Component | undefined,
  newTokens: string[],
  oldTokens: string[]
): Change[] {
  const components: Component[] = [];
  let cursor = lastComponent;
  while (cursor) {
    components.push(cursor);
    cursor = cursor.previousComponent;
  }
  components.reverse();

  let newPos = 0;
  let oldPos = 0;
  const changes: Change[] = [];

  for (const component of components) {
    let value: string;
    if (!component.removed) {
      value = newTokens.slice(newPos, newPos + component.count).join('');
      newPos += component.count;
      if (!component.added) {
        oldPos += component.count;
      }
    } else {
      value = oldTokens.slice(oldPos, oldPos + component.count).join('');
      oldPos += component.count;
    }
    changes.push({
      count: component.count,
      value,
      added: component.added,
      removed: component.removed,
    });
  }

  return changes;
}

/**
 * Compute a line-level diff of two strings using Myers's O(ND) algorithm,
 * returning an ordered list of unchanged/added/removed components.
 */
function diffLines(oldStr: string, newStr: string): Change[] {
  const oldTokens = removeEmpty(tokenize(oldStr));
  const newTokens = removeEmpty(tokenize(newStr));
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let editLength = 1;
  const maxEditLength = newLen + oldLen;

  // bestPath is indexed by (possibly negative) diagonal number.
  const bestPath: Record<number, Path | undefined> = {
    0: { oldPos: -1, lastComponent: undefined },
  };

  // Seed editLength = 0, i.e. the content starts with the same values.
  let newPos = extractCommon(bestPath[0]!, newTokens, oldTokens, 0);
  if (bestPath[0]!.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
    return buildValues(bestPath[0]!.lastComponent, newTokens, oldTokens);
  }

  let minDiagonalToConsider = -Infinity;
  let maxDiagonalToConsider = Infinity;

  const execEditLength = (): Change[] | undefined => {
    for (
      let diagonalPath = Math.max(minDiagonalToConsider, -editLength);
      diagonalPath <= Math.min(maxDiagonalToConsider, editLength);
      diagonalPath += 2
    ) {
      const removePath = bestPath[diagonalPath - 1];
      const addPath = bestPath[diagonalPath + 1];
      if (removePath) {
        bestPath[diagonalPath - 1] = undefined;
      }

      let canAdd = false;
      if (addPath) {
        const addPathNewPos = addPath.oldPos - diagonalPath;
        canAdd = 0 <= addPathNewPos && addPathNewPos < newLen;
      }
      const canRemove = !!removePath && removePath.oldPos + 1 < oldLen;

      if (!canAdd && !canRemove) {
        bestPath[diagonalPath] = undefined;
        continue;
      }

      let basePath: Path;
      if (!canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos)) {
        basePath = addToPath(addPath!, true, false, 0);
      } else {
        basePath = addToPath(removePath!, false, true, 1);
      }

      newPos = extractCommon(basePath, newTokens, oldTokens, diagonalPath);

      if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        return buildValues(basePath.lastComponent, newTokens, oldTokens);
      }

      bestPath[diagonalPath] = basePath;
      if (basePath.oldPos + 1 >= oldLen) {
        maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
      }
      if (newPos + 1 >= newLen) {
        minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
      }
    }
    editLength++;
    return undefined;
  };

  while (editLength <= maxEditLength) {
    const ret = execEditLength();
    if (ret) {
      return ret;
    }
  }

  // Unreachable for finite inputs, but keep the type total.
  return buildValues(undefined, newTokens, oldTokens);
}

/**
 * Split a change value back into its individual line-tokens (each keeping its
 * trailing newline, except a final line without one).
 */
function splitLines(text: string): string[] {
  const hasTrailingNl = text.endsWith('\n');
  const result = text.split('\n').map((line) => line + '\n');
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop()!.slice(0, -1));
  }
  return result;
}

function contextLines(lines: string[]): string[] {
  return lines.map((entry) => ' ' + entry);
}

/**
 * Produce a structured unified-diff patch for two strings. Mirrors the subset of
 * jsdiff's `structuredPatch` used by tuck: file headers plus context-bounded
 * hunks whose `lines` are prefixed with ' ' (context), '-' (removed), '+'
 * (added), or a literal "\ No newline at end of file" marker.
 */
export function structuredPatch(
  oldFileName: string,
  newFileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
  options?: StructuredPatchOptions
): StructuredPatch {
  const context = options?.context ?? 4;
  const diff = diffLines(oldStr, newStr);

  // Sentinel empty value simplifies the final-hunk flush below.
  const entries: Array<{ change?: Change; lines: string[] }> = diff.map((change) => ({
    change,
    lines: splitLines(change.value),
  }));
  entries.push({ lines: [] });

  const hunks: Hunk[] = [];
  let oldRangeStart = 0;
  let newRangeStart = 0;
  let curRange: string[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i];
    const lines = current.lines;
    const change = current.change;

    if (change && (change.added || change.removed)) {
      // Begin a hunk with up to `context` lines of leading context.
      if (!oldRangeStart) {
        const prev = entries[i - 1];
        oldRangeStart = oldLine;
        newRangeStart = newLine;

        if (prev) {
          curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
          oldRangeStart -= curRange.length;
          newRangeStart -= curRange.length;
        }
      }

      for (const line of lines) {
        curRange.push((change.added ? '+' : '-') + line);
      }

      if (change.added) {
        newLine += lines.length;
      } else {
        oldLine += lines.length;
      }
    } else {
      // Unchanged region: either absorb it as inter-change context or, if it is
      // large enough (and not the trailing sentinel), close out the hunk.
      if (oldRangeStart) {
        if (lines.length <= context * 2 && i < entries.length - 2) {
          for (const line of contextLines(lines)) {
            curRange.push(line);
          }
        } else {
          const contextSize = Math.min(lines.length, context);
          for (const line of contextLines(lines.slice(0, contextSize))) {
            curRange.push(line);
          }

          hunks.push({
            oldStart: oldRangeStart,
            oldLines: oldLine - oldRangeStart + contextSize,
            newStart: newRangeStart,
            newLines: newLine - newRangeStart + contextSize,
            lines: curRange,
          });

          oldRangeStart = 0;
          newRangeStart = 0;
          curRange = [];
        }
      }
      oldLine += lines.length;
      newLine += lines.length;
    }
  }

  // Strip trailing newlines from each hunk line and insert the standard
  // "\ No newline at end of file" marker where a line lacked one.
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lines.length; i++) {
      if (hunk.lines[i].endsWith('\n')) {
        hunk.lines[i] = hunk.lines[i].slice(0, -1);
      } else {
        hunk.lines.splice(i + 1, 0, '\\ No newline at end of file');
        i++;
      }
    }
  }

  return {
    oldFileName,
    newFileName,
    oldHeader,
    newHeader,
    hunks,
  };
}
