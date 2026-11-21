import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(stripBom(raw)) as T;
}

export async function writeJsonFile(file: string, data: unknown, pretty = true): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, 'utf8');
}

export async function writeTextFile(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Recursively list files under a directory, returning absolute paths. */
export async function listFiles(dir: string, filter?: (file: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && (!filter || filter(full))) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Expand a glob-ish pattern relative to `cwd`.
 *
 * Supports `*`, `**`, `?` and character classes. `**` matches any number of
 * directories, `*` matches within a single segment.
 */
export async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, '/');
  const absolute = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
  // Always work with forward slashes so the segment split is platform agnostic.
  const forward = absolute.replace(/\\/g, '/');
  const isPosixRoot = forward.startsWith('/');
  const segments = forward.split('/').filter((s) => s.length > 0);

  // Find the longest leading literal prefix.
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]]/.test(segment)) break;
    literal.push(segment);
  }
  const base = literal.length > 0
    ? (isPosixRoot ? `/${literal.join('/')}` : literal.join('/'))
    : path.resolve(cwd);
  const rest = segments.slice(literal.length);

  if (rest.length === 0) {
    return (await pathExists(absolute)) ? [path.resolve(absolute)] : [];
  }

  const files = await listFiles(base);
  const regex = globToRegExp(rest.join('/'));
  const resolvedBase = path.resolve(base);

  return files.filter((file) => {
    const rel = path.relative(resolvedBase, path.resolve(file)).replace(/\\/g, '/');
    return regex.test(rel);
  });
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` — consume the pair plus an optional following slash.
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = close;
      }
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
