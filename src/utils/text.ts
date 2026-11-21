/**
 * Text normalisation and similarity primitives used by the semantic assertion
 * engine. Everything here is dependency free and deterministic.
 */

/** Small, conservative English stopword list. */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between',
  'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not',
  'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out',
  'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'you', 'your', 'yours',
]);

export interface NormalizeOptions {
  ignoreCase?: boolean;
  ignorePunctuation?: boolean;
  stopwords?: boolean;
  /** Extra stopwords on top of the built-in list. */
  extraStopwords?: string[];
  /** Collapse whitespace. Defaults to true. */
  collapseWhitespace?: boolean;
}

const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_RE = /\s+/gu;

/** Normalise text for comparison purposes. */
export function normalizeText(input: string, options: NormalizeOptions = {}): string {
  const {
    ignoreCase = true,
    ignorePunctuation = true,
    stopwords = false,
    extraStopwords = [],
    collapseWhitespace = true,
  } = options;

  let out = input;
  if (ignoreCase) out = out.toLowerCase();
  if (ignorePunctuation) out = out.replace(PUNCTUATION_RE, ' ');
  if (collapseWhitespace) out = out.replace(WHITESPACE_RE, ' ').trim();

  if (stopwords) {
    const stop = extraStopwords.length
      ? new Set<string>([...DEFAULT_STOPWORDS, ...extraStopwords.map((s) => s.toLowerCase())])
      : DEFAULT_STOPWORDS;
    out = out
      .split(' ')
      .filter((token) => token.length > 0 && !stop.has(token))
      .join(' ');
  }

  return out;
}

/** Light stemming: folds common English inflections to a stable stem. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches'))) {
    return w.slice(0, -2);
  }
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    w = w.slice(0, -1);
  }
  if (w.length > 5 && w.endsWith('ing')) {
    w = w.slice(0, -3);
    // "running" -> "runn" -> "run"
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !'aeiou'.includes(w[w.length - 1] as string)) {
      w = w.slice(0, -1);
    }
  } else if (w.length > 4 && w.endsWith('ed')) {
    w = w.slice(0, -2);
  }
  if (w.length > 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Split normalised text into stemmed word tokens. */
export function tokenize(input: string, options: NormalizeOptions = {}): string[] {
  const normalized = normalizeText(input, options);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean).map(stem);
}

/** Character bigrams of a normalised string. */
export function charBigrams(input: string): string[] {
  const s = input.replace(WHITESPACE_RE, ' ').trim();
  if (s.length === 0) return [];
  if (s.length === 1) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

/** Jaccard similarity of two sets (0..1). */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Dice coefficient of two sets (0..1). */
export function diceCoefficient<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/** Normalised Levenshtein similarity (0..1). */
export function levenshteinSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Rough sentence splitter that tolerates abbreviations and ellipses. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Rough word count. */
export function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}'’-]+/gu);
  return matches ? matches.length : 0;
}

/**
 * Approximate token count. Uses a chars/4 heuristic blended with the word
 * count so long words are not systematically under-counted.
 */
export function estimateTokens(text: string, tokenRatio = 4): number {
  if (!text) return 0;
  const charBased = Math.ceil(text.length / Math.max(1, tokenRatio));
  const wordBased = countWords(text);
  return Math.max(charBased, wordBased);
}

/** Escape a string so it can be embedded in a RegExp safely. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
