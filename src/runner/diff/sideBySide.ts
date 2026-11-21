import { createStylerFromOption, padVisible, truncateVisible, visibleWidth } from '../../utils/ansi.js';
import type { Styler } from '../../utils/ansi.js';
import { diffStats, safeDiff } from './textDiff.js';
import type { DiffSegment } from './textDiff.js';

export type DiffRowType = 'equal' | 'changed' | 'removed' | 'added';

export interface DiffRow {
  type: DiffRowType;
  left: string;
  right: string;
}

interface DiffToken {
  op: 'equal' | 'delete' | 'insert';
  text: string;
}

/** Expand diff segments into a flat list of word tokens. */
function toTokens(segments: DiffSegment[]): DiffToken[] {
  const tokens: DiffToken[] = [];
  for (const segment of segments) {
    for (const part of segment.text.split(/(\s+)/)) {
      if (part.trim().length === 0) continue;
      tokens.push({ op: segment.op, text: part });
    }
  }
  return tokens;
}

/**
 * Turn a word-level diff into aligned rows suitable for a side-by-side view.
 *
 * Changes that are separated by only a couple of unchanged words are treated
 * as a single hunk, so a reworded sentence produces one paired row rather
 * than a dozen interleaved ones.
 */
export function buildDiffRows(segments: DiffSegment[], bridge = 2): DiffRow[] {
  const tokens = toTokens(segments);
  const rows: DiffRow[] = [];

  // Locate the change groups.
  const groups: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | undefined;
  let equalRun = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as DiffToken;
    if (token.op === 'equal') {
      equalRun += 1;
      continue;
    }
    if (current && equalRun <= bridge) {
      current.end = i;
    } else {
      if (current) groups.push(current);
      current = { start: i, end: i };
    }
    equalRun = 0;
  }
  if (current) groups.push(current);

  let cursor = 0;
  for (const group of groups) {
    const leading = tokens
      .slice(cursor, group.start)
      .filter((token) => token.op === 'equal')
      .map((token) => token.text);
    if (leading.length > 0) {
      const text = leading.join(' ');
      rows.push({ type: 'equal', left: text, right: text });
    }

    const removed: string[] = [];
    const inserted: string[] = [];
    for (let i = group.start; i <= group.end; i += 1) {
      const token = tokens[i] as DiffToken;
      if (token.op === 'delete') removed.push(token.text);
      else if (token.op === 'insert') inserted.push(token.text);
    }

    const left = removed.join(' ');
    const right = inserted.join(' ');
    if (left && right) rows.push({ type: 'changed', left, right });
    else if (left) rows.push({ type: 'removed', left, right: '' });
    else rows.push({ type: 'added', left: '', right });

    cursor = group.end + 1;
  }

  const trailing = tokens
    .slice(cursor)
    .filter((token) => token.op === 'equal')
    .map((token) => token.text);
  if (trailing.length > 0) {
    const text = trailing.join(' ');
    rows.push({ type: 'equal', left: text, right: text });
  }

  return rows;
}

/** Wrap plain text into lines of at most `width` characters. */
export function wrapText(text: string, width: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [''];
  if (width <= 0) return [trimmed];

  const words = trimmed.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export interface SideBySideOptions {
  /** Title rendered above each column. */
  leftTitle?: string;
  rightTitle?: string;
  /** Total width of the table. Defaults to the terminal width (or 100). */
  width?: number;
  /** Maximum number of rows to render. */
  maxRows?: number;
  /** Include unchanged rows. Defaults to true. */
  showUnchanged?: boolean;
  /** Colour mode. */
  color?: 'auto' | 'always' | 'never';
  /** Number of unchanged rows to keep around each change. */
  context?: number;
}

export interface SideBySideResult {
  text: string;
  rows: DiffRow[];
  stats: { added: number; removed: number; unchanged: number; identical: boolean };
}

const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  topTee: '┬',
  bottomTee: '┴',
  leftTee: '├',
  rightTee: '┤',
  cross: '┼',
};

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : '';
}

/**
 * Render two texts side by side with a unified frame and colour coding.
 */
export function renderSideBySide(
  leftText: string,
  rightText: string,
  options: SideBySideOptions = {},
): SideBySideResult {
  const styler: Styler = createStylerFromOption(options.color ?? 'auto');
  const segments = safeDiff(leftText, rightText, 'word');
  const stats = diffStats(segments);
  let rows = buildDiffRows(segments);

  const showUnchanged = options.showUnchanged ?? true;
  const context = Math.max(0, options.context ?? 2);

  if (!showUnchanged) {
    // Keep every changed row plus a short unchanged block that precedes it.
    // Long unchanged blocks are dropped — they only add noise.
    const maxContextWords = 30;
    const keep = new Set<number>();
    rows.forEach((row, index) => {
      if (row.type === 'equal') return;
      keep.add(index);
      for (let i = index - 1; i >= 0 && i >= index - context; i -= 1) {
        const candidate = rows[i];
        if (!candidate || candidate.type !== 'equal') break;
        if (candidate.left.split(/\s+/).length > maxContextWords) break;
        keep.add(i);
      }
    });
    rows = rows.filter((_, index) => keep.has(index));
  }

  const totalWidth = options.width ?? 100;
  const maxRows = options.maxRows ?? 60;

  const leftTitle = options.leftTitle ?? 'A';
  const rightTitle = options.rightTitle ?? 'B';

  // Column widths: 2 borders + 1 separator + 2 padding per column.
  const usable = Math.max(40, totalWidth - 5);
  let leftWidth = Math.floor(usable / 2);
  let rightWidth = usable - leftWidth;

  const titleLeftLen = visibleWidth(leftTitle);
  const titleRightLen = visibleWidth(rightTitle);
  if (titleLeftLen > leftWidth) leftWidth = titleLeftLen;
  if (titleRightLen > rightWidth) rightWidth = titleRightLen;

  const header =
    `${BOX.topLeft}${repeat(BOX.horizontal, leftWidth + 2)}${BOX.topTee}${repeat(
      BOX.horizontal,
      rightWidth + 2,
    )}${BOX.topRight}`;
  const headerDivider = `${BOX.leftTee}${repeat(BOX.horizontal, leftWidth + 2)}${BOX.cross}${repeat(
    BOX.horizontal,
    rightWidth + 2,
  )}${BOX.rightTee}`;
  const footer = `${BOX.bottomLeft}${repeat(BOX.horizontal, leftWidth + 2)}${BOX.bottomTee}${repeat(
    BOX.horizontal,
    rightWidth + 2,
  )}${BOX.bottomRight}`;

  const body: Array<{ left: string; right: string; type: DiffRowType }> = [];

  for (const row of rows) {
    const leftLines = wrapText(row.left, leftWidth);
    const rightLines = wrapText(row.right, rightWidth);
    const height = Math.max(leftLines.length, rightLines.length);

    for (let line = 0; line < height; line += 1) {
      body.push({
        left: leftLines[line] ?? '',
        right: rightLines[line] ?? '',
        type: row.type,
      });
    }
  }

  const truncated = body.length > maxRows;
  const visibleBody = truncated
    ? [...body.slice(0, Math.ceil(maxRows / 2)), ...body.slice(body.length - Math.floor(maxRows / 2))]
    : body;

  const lines: string[] = [];
  lines.push(styler.bold(header));
  lines.push(
    `${BOX.vertical} ${padVisible(
      styler.bold(truncateVisible(leftTitle, leftWidth)),
      leftWidth,
    )} ${BOX.vertical} ${padVisible(
      styler.bold(truncateVisible(rightTitle, rightWidth)),
      rightWidth,
    )} ${BOX.vertical}`,
  );
  lines.push(styler.dim(headerDivider));

  for (const line of visibleBody) {
    let leftCell: string;
    let rightCell: string;
    switch (line.type) {
      case 'equal':
        leftCell = styler.dim(line.left);
        rightCell = styler.dim(line.right);
        break;
      case 'changed':
        leftCell = styler.red(line.left);
        rightCell = styler.green(line.right);
        break;
      case 'removed':
        leftCell = styler.red(line.left);
        rightCell = '';
        break;
      case 'added':
      default:
        leftCell = '';
        rightCell = styler.green(line.right);
        break;
    }

    lines.push(
      `${BOX.vertical} ${padVisible(leftCell, leftWidth)} ${BOX.vertical} ${padVisible(
        rightCell,
        rightWidth,
      )} ${BOX.vertical}`,
    );
  }

  if (truncated) {
    lines.push(
      styler.dim(
        `${BOX.vertical} ${padVisible('… output truncated …', leftWidth)} ${BOX.vertical} ${padVisible(
          '',
          rightWidth,
        )} ${BOX.vertical}`,
      ),
    );
  }

  lines.push(styler.dim(footer));

  return {
    text: lines.join('\n'),
    rows,
    stats,
  };
}

/** Detect the terminal width, falling back to 100 columns. */
export function detectWidth(): number {
  const columns = process.stdout.columns;
  if (typeof columns === 'number' && columns >= 40) return Math.min(columns, 160);
  return 100;
}
