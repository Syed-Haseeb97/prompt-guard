/** Minimal ANSI styling helpers with graceful no-op behaviour. */

const ESC = '\u001b[';

export interface StyleOptions {
  enabled: boolean;
}

export function createStyler(mode: 'auto' | 'always' | 'never', streamHasColor = true) {
  const enabled =
    mode === 'always' ? true : mode === 'never' ? false : Boolean(streamHasColor) && process.env.NO_COLOR === undefined;
  return enabled;
}

function wrap(code: string, text: string, enabled: boolean): string {
  return enabled ? `${ESC}${code}m${text}${ESC}0m` : text;
}

export interface Styler {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  gray(text: string): string;
  inverse(text: string): string;
  boldRed(text: string): string;
  boldGreen(text: string): string;
  boldYellow(text: string): string;
}

export function createStylerFromOption(mode: 'auto' | 'always' | 'never'): Styler {
  const enabled = createStyler(mode);
  return {
    enabled,
    bold: (t) => wrap('1', t, enabled),
    dim: (t) => wrap('2', t, enabled),
    red: (t) => wrap('31', t, enabled),
    green: (t) => wrap('32', t, enabled),
    yellow: (t) => wrap('33', t, enabled),
    blue: (t) => wrap('34', t, enabled),
    magenta: (t) => wrap('35', t, enabled),
    cyan: (t) => wrap('36', t, enabled),
    gray: (t) => wrap('90', t, enabled),
    inverse: (t) => wrap('7', t, enabled),
    boldRed: (t) => wrap('1;31', t, enabled),
    boldGreen: (t) => wrap('1;32', t, enabled),
    boldYellow: (t) => wrap('1;33', t, enabled),
  };
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK / full width ranges
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff);
    if (cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f)) continue;
    width += isWide ? 2 : 1;
  }
  return width;
}

/** Pad a string to `width` visible columns. */
export function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? `${text}${' '.repeat(pad)}` : text;
}

/** Truncate to `width` visible columns, appending an ellipsis. */
export function truncateVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return '…';
  const chars = [...text];
  let out = '';
  let used = 0;
  for (const ch of chars) {
    const w = visibleWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}
