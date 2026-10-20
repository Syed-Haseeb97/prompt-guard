/**
 * A tiny dependency-free command line parser.
 *
 * Supports:
 *   --flag            boolean flag
 *   --flag=value      inline value
 *   --flag value      value flag (when the next token is not a flag)
 *   --no-flag         explicit negation
 *   -abc             short flag cluster
 *   --                end of options
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

const SHORT_ALIASES: Record<string, string> = {
  c: 'config',
  o: 'out',
  p: 'provider',
  m: 'model',
  t: 'tag',
  i: 'id',
  q: 'quiet',
  v: 'verbose',
  h: 'help',
  f: 'format',
  k: 'keep',
  n: 'concurrency',
  s: 'search',
  w: 'width',
  c2: 'color',
};

function assign(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[key] = [String(existing), String(value)];
  }
}

/** Parse an argv array (without `node` and the script path). */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  let index = 0;
  let sawDoubleDash = false;

  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;

    if (sawDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      sawDoubleDash = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1);
        assign(flags, key, value);
        continue;
      }
      if (body.startsWith('no-')) {
        assign(flags, body.slice(3), false);
        continue;
      }
      const next = argv[index];
      if (next !== undefined && !next.startsWith('-')) {
        assign(flags, body, next);
        index += 1;
      } else {
        assign(flags, body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const cluster = token.slice(1);
      for (let i = 0; i < cluster.length; i += 1) {
        const short = cluster[i] as string;
        const key = SHORT_ALIASES[short] ?? short;
        const isLast = i === cluster.length - 1;
        if (isLast) {
          const next = argv[index];
          if (next !== undefined && !next.startsWith('-')) {
            assign(flags, key, next);
            index += 1;
          } else {
            assign(flags, key, true);
          }
        } else {
          assign(flags, key, true);
        }
      }
      continue;
    }

    positionals.push(token);
  }

  const command = positionals.shift() ?? '';
  return { command, positionals, flags };
}

/** Read a flag as a string. */
export function flagString(args: ParsedArgs, key: string, fallback?: string): string | undefined {
  const value = args.flags[key];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

/** Read a flag as a boolean. */
export function flagBoolean(args: ParsedArgs, key: string, fallback = false): boolean {
  const value = args.flags[key];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(Array.isArray(value) ? value[value.length - 1] : value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/** Read a flag as a list of strings (comma separated values are split). */
export function flagList(args: ParsedArgs, key: string): string[] {
  const value = args.flags[key];
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Read a flag as a number. */
export function flagNumber(args: ParsedArgs, key: string, fallback?: number): number | undefined {
  const value = flagString(args, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
