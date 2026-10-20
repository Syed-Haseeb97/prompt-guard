import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEMANTIC_WEIGHTS,
  clamp01,
  salientTerms,
  semanticSimilarity,
  semanticSimilarityWithEmbeddings,
} from '../runner/assertions/semantic.js';

describe('semanticSimilarity', () => {
  it('returns 1 for identical texts', () => {
    const score = semanticSimilarity(
      'The cat sat on the mat.',
      'the cat sat on the mat',
    );
    expect(score.score).toBeCloseTo(1, 5);
    expect(score.components.wordJaccard).toBe(1);
    expect(score.components.wordDice).toBe(1);
    expect(score.components.charBigram).toBe(1);
    expect(score.components.levenshtein).toBe(1);
  });

  it('returns a low score for unrelated texts', () => {
    const score = semanticSimilarity(
      'The cat sat on the mat.',
      'Quantum chromodynamics describes the strong interaction.',
    );
    expect(score.score).toBeLessThan(0.2);
  });

  it('scores paraphrases above unrelated text', () => {
    const paraphrase = semanticSimilarity(
      'Please refund my order.',
      'I would like a refund for my order.',
    ).score;
    const unrelated = semanticSimilarity(
      'Please refund my order.',
      'Describe the water cycle in three sentences.',
    ).score;
    expect(paraphrase).toBeGreaterThan(unrelated);
    expect(paraphrase).toBeGreaterThan(0.3);
  });

  it('is insensitive to case and punctuation by default', () => {
    const a = semanticSimilarity('Hello, World!', 'hello world');
    const b = semanticSimilarity('Hello, World!', 'hello world', {
      ignoreCase: false,
      ignorePunctuation: false,
    });
    expect(a.score).toBeCloseTo(1, 5);
    expect(b.score).toBeLessThan(a.score);
  });

  it('honours stopword removal', () => {
    const withStopwords = semanticSimilarity(
      'the refund policy for a customer',
      'refund policy customer',
    ).score;
    const withoutStopwords = semanticSimilarity(
      'the refund policy for a customer',
      'refund policy customer',
      { stopwords: true },
    ).score;
    expect(withoutStopwords).toBeGreaterThan(withStopwords);
  });

  it('respects custom weights', () => {
    const jaccardHeavy = semanticSimilarity('alpha beta gamma', 'alpha beta delta', {
      weights: { ...DEFAULT_SEMANTIC_WEIGHTS, wordJaccard: 1, wordDice: 0, charBigram: 0, levenshtein: 0 },
    });
    // {alpha, beta, gamma} vs {alpha, beta, delta} -> 2 shared of 4 union
    expect(jaccardHeavy.components.wordJaccard).toBeCloseTo(0.5, 5);
    expect(jaccardHeavy.score).toBeCloseTo(0.5, 5);
  });

  it('computes term coverage against salient expected terms', () => {
    const score = semanticSimilarity(
      'We will process the refund for order 4821 tomorrow.',
      'Process the refund for the order and confirm the customer.',
    );
    // salient expected terms: process, refund, order, confirm, customer
    expect(score.termCoverage).toBeGreaterThan(0.5);
    expect(score.salientTerms.length).toBeGreaterThan(0);
    expect(score.missingTerms.length).toBeGreaterThan(0);
  });

  it('reports full coverage when every salient term is present', () => {
    const score = semanticSimilarity('refund order', 'refund order');
    expect(score.termCoverage).toBe(1);
    expect(score.missingTerms).toHaveLength(0);
  });
});

describe('semanticSimilarityWithEmbeddings', () => {
  it('folds the embedding cosine similarity into the blended score', () => {
    const base = semanticSimilarity('refund order', 'refund order');
    const withEmbedding = semanticSimilarityWithEmbeddings(
      'refund order',
      'refund order',
      [1, 0, 0],
      [1, 0, 0],
    );
    expect(withEmbedding.components.embedding).toBeCloseTo(1, 5);
    expect(withEmbedding.score).toBeCloseTo(base.score, 5);
  });

  it('penalises orthogonal embeddings', () => {
    const score = semanticSimilarityWithEmbeddings(
      'alpha',
      'beta',
      [1, 0],
      [0, 1],
    );
    expect(score.components.embedding).toBeCloseTo(0, 5);
  });
});

describe('salientTerms', () => {
  it('removes stopwords and short words', () => {
    const terms = salientTerms('The a refund of an order was issued');
    expect(terms).toContain('refund');
    expect(terms).toContain('order');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('a');
  });
});

describe('clamp01', () => {
  it('clamps values into the unit interval', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
