import type { SemanticAssertion, SemanticWeights } from '../../core/types.js';
import {
  charBigrams,
  diceCoefficient,
  jaccard,
  levenshteinSimilarity,
  normalizeText,
  stem,
  tokenize,
} from '../../utils/text.js';
import type { NormalizeOptions } from '../../utils/text.js';
import { cosineSimilarity } from './embedding.js';
import type { AssertionContext, AssertionValidator } from './types.js';
import type { AssertionResult } from '../../core/types.js';

export const DEFAULT_SEMANTIC_WEIGHTS: SemanticWeights = {
  wordJaccard: 0.35,
  wordDice: 0.3,
  charBigram: 0.2,
  levenshtein: 0.15,
};

export interface SemanticComponents {
  wordJaccard: number;
  wordDice: number;
  charBigram: number;
  levenshtein: number;
  embedding?: number;
}

export interface SemanticScore {
  /** Blended similarity in [0, 1]. */
  score: number;
  /** Individual metric components. */
  components: SemanticComponents;
  /** The reference candidate that produced the highest score. */
  bestMatch: string;
  /** Fraction of salient expected terms found in the actual text. */
  termCoverage: number;
  /** Salient terms extracted from the expected text. */
  salientTerms: string[];
  /** Salient terms missing from the actual text. */
  missingTerms: string[];
}

export interface SemanticOptions extends NormalizeOptions {
  weights?: Partial<SemanticWeights>;
  /** Weight of the embedding signal when an embedding is available. */
  embeddingWeight?: number;
}

const MIN_TERM_LENGTH = 3;

function normalizeOptions(options: SemanticOptions): Required<NormalizeOptions> {
  return {
    ignoreCase: options.ignoreCase ?? true,
    ignorePunctuation: options.ignorePunctuation ?? true,
    stopwords: options.stopwords ?? false,
    extraStopwords: options.extraStopwords ?? [],
    collapseWhitespace: options.collapseWhitespace ?? true,
  };
}

function blend(components: SemanticComponents, weights: SemanticWeights): number {
  let total = 0;
  let sum = 0;
  const entries: Array<[number | undefined, number | undefined]> = [
    [components.wordJaccard, weights.wordJaccard],
    [components.wordDice, weights.wordDice],
    [components.charBigram, weights.charBigram],
    [components.levenshtein, weights.levenshtein],
    [components.embedding, weights.embeddingWeight],
  ];
  for (const [value, weight] of entries) {
    if (value === undefined || weight === undefined || weight <= 0) continue;
    total += weight;
    sum += value * weight;
  }
  if (total === 0) return 0;
  return clamp01(sum / total);
}

/** Clamp a number into the inclusive [0, 1] range. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Extract the salient terms of a reference text: stemmed, deduplicated and
 * short words removed.
 */
export function salientTerms(text: string, options: NormalizeOptions = {}): string[] {
  const tokens = tokenize(text, { ...options, stopwords: true });
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length < MIN_TERM_LENGTH) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

/**
 * Compute a blended semantic similarity score between two texts.
 *
 * The metric combines four complementary signals:
 *  - word-level Jaccard (set overlap of stemmed tokens)
 *  - word-level Dice coefficient (softer set overlap)
 *  - character-bigram Dice (robust to paraphrasing and inflection)
 *  - normalised Levenshtein (surface edit distance)
 *
 * An optional embedding signal can be folded in through `embedding`.
 */
export function semanticSimilarity(
  actual: string,
  expected: string,
  options: SemanticOptions = {},
): SemanticScore {
  const norm = normalizeOptions(options);
  const actualNorm = normalizeText(actual, norm);
  const expectedNorm = normalizeText(expected, norm);

  const actualTokens = tokenize(actual, norm);
  const expectedTokens = tokenize(expected, norm);
  const actualSet = new Set(actualTokens);
  const expectedSet = new Set(expectedTokens);

  const components: SemanticComponents = {
    wordJaccard: jaccard(actualSet, expectedSet),
    wordDice: diceCoefficient(actualSet, expectedSet),
    charBigram: diceCoefficient(new Set(charBigrams(actualNorm)), new Set(charBigrams(expectedNorm))),
    levenshtein: levenshteinSimilarity(actualNorm, expectedNorm),
  };

  const weights: SemanticWeights = {
    ...DEFAULT_SEMANTIC_WEIGHTS,
    ...(options.weights ?? {}),
  };
  const embeddingWeight =
    options.embeddingWeight ?? (components.embedding !== undefined ? 0.4 : 0);

  const score = blend(components, { ...weights, embeddingWeight } as SemanticWeights);

  const terms = salientTerms(expected, norm);
  const actualTermSet = new Set(actualTokens);
  const present = terms.filter((t) => actualTermSet.has(t));
  const missing = terms.filter((t) => !actualTermSet.has(t));
  const termCoverage = terms.length === 0 ? 1 : present.length / terms.length;

  return {
    score: clamp01(score),
    components,
    bestMatch: expected,
    termCoverage,
    salientTerms: terms,
    missingTerms: missing,
  };
}

/** Cosine-aware variant that accepts pre-computed vectors for both texts. */
export function semanticSimilarityWithEmbeddings(
  actual: string,
  expected: string,
  actualEmbedding: number[],
  expectedEmbedding: number[],
  options: SemanticOptions = {},
): SemanticScore {
  const base = semanticSimilarity(actual, expected, options);
  const embeddingScore = cosineSimilarity(actualEmbedding, expectedEmbedding);
  const components: SemanticComponents = { ...base.components, embedding: embeddingScore };
  const weights: SemanticWeights = {
    ...DEFAULT_SEMANTIC_WEIGHTS,
    ...(options.weights ?? {}),
  };
  const embeddingWeight = options.embeddingWeight ?? 0.4;
  const score = blend(components, { ...weights, embeddingWeight } as SemanticWeights);
  return { ...base, components, score: clamp01(score) };
}

/**
 * Semantic assertion validator: asserts the output is (or is not) similar to
 * one of the reference texts.
 */
export const semanticValidator: AssertionValidator = async (
  assertion,
  context,
): Promise<AssertionResult> => {
  const semantic = assertion as SemanticAssertion;
  const name = semantic.name ?? 'semantic similarity';
  const candidates = Array.isArray(semantic.expected) ? semantic.expected : [semantic.expected];
  const mode = semantic.mode ?? 'similar';

  if (candidates.length === 0) {
    return {
      name,
      type: 'semantic',
      status: 'errored',
      passed: false,
      message: 'semantic assertion requires at least one expected value',
      durationMs: 0,
    };
  }

  const options: SemanticOptions = {
    ignoreCase: semantic.ignoreCase ?? true,
    ignorePunctuation: semantic.ignorePunctuation ?? true,
    stopwords: semantic.stopwords ?? false,
    weights: semantic.weights,
  };

  let best: SemanticScore | undefined;
  for (const candidate of candidates) {
    let score: SemanticScore;
    if (context.embed) {
      const [actualEmbedding, expectedEmbedding] = await Promise.all([
        context.embed(context.output),
        context.embed(candidate),
      ]);
      score = semanticSimilarityWithEmbeddings(
        context.output,
        candidate,
        actualEmbedding,
        expectedEmbedding,
        options,
      );
    } else {
      score = semanticSimilarity(context.output, candidate, options);
    }
    if (!best || score.score > best.score) best = score;
  }

  const score = best as SemanticScore;
  const threshold = semantic.threshold ?? 0.7;
  const maxSimilarity = semantic.maxSimilarity ?? 0.3;

  const similarityPassed =
    mode === 'notSimilar' ? score.score <= maxSimilarity : score.score >= threshold;

  // Term coverage is an independent gate: it can fail a case even when the
  // blended similarity is high enough.
  const requiredCoverage = semantic.minTermCoverage;
  const coverageRequired = requiredCoverage !== undefined;
  const coveragePassed = !coverageRequired || score.termCoverage >= requiredCoverage;

  const passed = similarityPassed && coveragePassed;

  let message: string;
  if (!similarityPassed) {
    message =
      mode === 'notSimilar'
        ? `output is too similar to the reference (score ${score.score.toFixed(3)} > ${maxSimilarity})`
        : `output is not similar enough to the reference (score ${score.score.toFixed(3)} < ${threshold})`;
  } else if (!coveragePassed) {
    message =
      `term coverage ${score.termCoverage.toFixed(3)} < required ${requiredCoverage} ` +
      `(missing: ${score.missingTerms.slice(0, 8).join(', ') || 'none'})`;
  } else {
    message =
      mode === 'notSimilar'
        ? `output is sufficiently dissimilar from the reference (score ${score.score.toFixed(3)} <= ${maxSimilarity})`
        : `output is similar to the reference (score ${score.score.toFixed(3)} >= ${threshold})`;
  }

  return {
    name,
    type: 'semantic',
    status: passed ? 'passed' : 'failed',
    passed,
    message,
    score: score.score,
    expected: candidates,
    actual: context.output,
    details: {
      components: score.components,
      termCoverage: score.termCoverage,
      missingTerms: score.missingTerms,
      bestMatch: score.bestMatch,
      mode,
      threshold: mode === 'notSimilar' ? maxSimilarity : threshold,
    },
    durationMs: 0,
  };
};

/** Exposed for tests: stem a single word through the pipeline. */
export const stemWord = stem;
