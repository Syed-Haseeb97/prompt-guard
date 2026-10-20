/**
 * Helpers for pulling a JSON document out of a model response.
 *
 * Models frequently wrap JSON in prose or markdown fences, so the extractors
 * here degrade gracefully.
 */

export type JsonExtractionMode = 'auto' | 'strict' | 'markdown' | 'first' | 'last';

export interface JsonExtractionResult {
  value: unknown;
  /** The raw text that was parsed. */
  raw: string;
  /** Which strategy succeeded. */
  mode: 'strict' | 'markdown' | 'braces' | 'first' | 'last';
}

/** Parse a string as JSON, returning `undefined` on failure. */
export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Extract the contents of a fenced code block (```json ... ```). */
export function extractFencedJson(text: string): string | undefined {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null = fence.exec(text);
  let last: string | undefined;
  while (match !== null) {
    last = match[1];
    match = fence.exec(text);
  }
  return last?.trim();
}

/** Find balanced `{...}` or `[...]` substrings in a text. */
export function findBalancedJson(text: string): Array<{ text: string; start: number }> {
  const results: Array<{ text: string; start: number }> = [];
  const stack: Array<{ char: string; start: number }> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push({ char: ch, start: i });
      continue;
    }

    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (!open) continue;
      const closes = open.char === '{' ? '}' : ']';
      if (ch !== closes) continue;
      // Only report the outermost region of a nested structure.
      if (stack.length === 0) {
        results.push({ text: text.slice(open.start, i + 1), start: open.start });
      }
    }
  }

  return results.sort((a, b) => a.start - b.start);
}

/**
 * Extract a JSON value from a model response.
 *
 * @throws {Error} when no JSON could be located.
 */
export function extractJson(text: string, mode: JsonExtractionMode = 'auto'): JsonExtractionResult {
  const trimmed = text.trim();

  if (mode === 'strict') {
    const value = tryParseJson(trimmed);
    if (value === undefined) {
      throw new Error('output is not valid JSON');
    }
    return { value, raw: trimmed, mode: 'strict' };
  }

  if (mode === 'markdown') {
    const fenced = extractFencedJson(text);
    if (fenced === undefined) throw new Error('no fenced JSON block found in the output');
    const value = tryParseJson(fenced);
    if (value === undefined) throw new Error('fenced block is not valid JSON');
    return { value, raw: fenced, mode: 'markdown' };
  }

  if (mode === 'first' || mode === 'last') {
    const candidates = findBalancedJson(text)
      .map((c) => c.text)
      .map((candidate) => ({ candidate, value: tryParseJson(candidate) }))
      .filter((entry): entry is { candidate: string; value: unknown } => entry.value !== undefined);
    if (candidates.length === 0) throw new Error('no JSON object found in the output');
    const chosen = mode === 'first' ? candidates[0] : candidates[candidates.length - 1];
    if (!chosen) throw new Error('no JSON object found in the output');
    return { value: chosen.value, raw: chosen.candidate, mode };
  }

  // auto
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return { value: direct, raw: trimmed, mode: 'strict' };

  const fenced = extractFencedJson(text);
  if (fenced !== undefined) {
    const value = tryParseJson(fenced);
    if (value !== undefined) return { value, raw: fenced, mode: 'markdown' };
  }

  const candidates = findBalancedJson(text)
    .map((c) => c.text)
    .map((candidate) => ({ candidate, value: tryParseJson(candidate) }))
    .filter((entry): entry is { candidate: string; value: unknown } => entry.value !== undefined);
  if (candidates.length > 0) {
    const chosen = candidates[candidates.length - 1];
    if (chosen) return { value: chosen.value, raw: chosen.candidate, mode: 'braces' };
  }

  throw new Error('could not extract a JSON document from the output');
}
