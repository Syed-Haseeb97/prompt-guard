/**
 * Text diffing primitives.
 *
 * A classic longest-common-subsequence implementation is used at word and
 * line granularity. Inputs beyond `maxCells` are compared with a cheaper
 * block strategy so pathological inputs cannot stall a run.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

const DEFAULT_MAX_CELLS = 4_000_000;

function splitWords(text: string): string[] {
  const parts = text.split(/(\s+)/).filter((part) => part.length > 0);
  return parts;
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Compute the longest common subsequence table for two token arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  return table;
}

/** Diff two token arrays into a list of segments. */
export function diffTokens(a: string[], b: string[]): DiffSegment[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ op: 'insert', text: b.join('') }];
  if (b.length === 0) return [{ op: 'delete', text: a.join('') }];

  const table = lcsTable(a, b);
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;

  const push = (op: DiffOp, text: string): void => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += text;
    else segments.push({ op, text });
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i] as string);
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      push('delete', a[i] as string);
      i += 1;
    } else {
      push('insert', b[j] as string);
      j += 1;
    }
  }
  while (i < a.length) {
    push('delete', a[i] as string);
    i += 1;
  }
  while (j < b.length) {
    push('insert', b[j] as string);
    j += 1;
  }

  return segments;
}

/** Word-level diff (whitespace is preserved as tokens). */
export function diffWords(a: string, b: string): DiffSegment[] {
  return diffTokens(splitWords(a), splitWords(b));
}

/** Line-level diff. */
export function diffLines(a: string, b: string): DiffSegment[] {
  return diffTokens(splitLines(a), splitLines(b));
}

/** Block diff used when the inputs are too large for a full LCS. */
function blockDiff(a: string[], b: string[]): DiffSegment[] {
  const maxLength = Math.max(a.length, b.length);
  const segments: DiffSegment[] = [];
  for (let i = 0; i < maxLength; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      segments.push({ op: 'equal', text: left as string });
    } else {
      if (left !== undefined) segments.push({ op: 'delete', text: left });
      if (right !== undefined) segments.push({ op: 'insert', text: right });
    }
  }
  return segments;
}

/** Diff with a guard against quadratic blow-up. */
export function safeDiff(
  a: string,
  b: string,
  granularity: 'word' | 'line' = 'word',
  maxCells = DEFAULT_MAX_CELLS,
): DiffSegment[] {
  const aTokens = granularity === 'word' ? splitWords(a) : splitLines(a);
  const bTokens = granularity === 'word' ? splitWords(b) : splitLines(b);
  if (aTokens.length * bTokens.length > maxCells) {
    return blockDiff(aTokens, bTokens);
  }
  return diffTokens(aTokens, bTokens);
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
  /** True when the two texts are identical. */
  identical: boolean;
}

/** Count insertions and deletions in a diff. */
export function diffStats(segments: DiffSegment[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const segment of segments) {
    const length = segment.text.length;
    if (segment.op === 'insert') added += length;
    else if (segment.op === 'delete') removed += length;
    else unchanged += length;
  }
  return {
    added,
    removed,
    unchanged,
    identical: added === 0 && removed === 0,
  };
}
