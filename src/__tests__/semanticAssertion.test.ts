import { describe, expect, it, vi } from 'vitest';
import { semanticValidator } from '../runner/assertions/semantic.js';
import { silentLogger } from '../core/logger.js';
import type { AssertionContext } from '../runner/assertions/types.js';
import type { TestSuite } from '../core/types.js';

const suite: TestSuite = { name: 'test', fixtures: [] };

function makeContext(output: string, embed?: AssertionContext['embed']): AssertionContext {
  return {
    output,
    fixture: { id: 'f', prompt: 'p' },
    suite,
    variables: {},
    validators: new Map(),
    embed,
    logger: silentLogger,
  };
}

describe('semantic assertion', () => {
  it('passes when the output is similar enough', async () => {
    const result = await semanticValidator(
      { type: 'semantic', expected: 'refund the duplicate order', threshold: 0.5 },
      makeContext('We will refund the duplicate order after verification.'),
    );
    expect(result.passed).toBe(true);
    expect(result.status).toBe('passed');
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('fails when the output is too different', async () => {
    const result = await semanticValidator(
      { type: 'semantic', expected: 'refund the duplicate order' },
      makeContext('The weather in Berlin is mild today.'),
    );
    expect(result.passed).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('not similar enough');
  });

  it('accepts the best of several reference texts', async () => {
    const result = await semanticValidator(
      {
        type: 'semantic',
        expected: [
          'completely unrelated content about penguins',
          'we will refund the duplicate order',
        ],
        threshold: 0.5,
      },
      makeContext('We will refund the duplicate order.'),
    );
    expect(result.passed).toBe(true);
  });

  it('honours an explicit threshold', async () => {
    const strict = await semanticValidator(
      { type: 'semantic', expected: 'refund the order', threshold: 0.99 },
      makeContext('refund the order'),
    );
    expect(strict.passed).toBe(true);

    const impossible = await semanticValidator(
      { type: 'semantic', expected: 'refund the order', threshold: 1.01 },
      makeContext('refund the order'),
    );
    expect(impossible.passed).toBe(false);
  });

  it('supports the notSimilar mode', async () => {
    const leaking = await semanticValidator(
      {
        type: 'semantic',
        mode: 'notSimilar',
        expected: 'The internal fraud number is 555 0100 and the code is F-42.',
        maxSimilarity: 0.3,
      },
      makeContext('The internal fraud number is 555 0100 and the code is F-42.'),
    );
    expect(leaking.passed).toBe(false);
    expect(leaking.message).toContain('too similar');

    const safe = await semanticValidator(
      {
        type: 'semantic',
        mode: 'notSimilar',
        expected: 'The internal fraud number is 555 0100 and the code is F-42.',
        maxSimilarity: 0.3,
      },
      makeContext('I cannot share internal details, but I can open a ticket.'),
    );
    expect(safe.passed).toBe(true);
  });

  it('enforces minTermCoverage as an independent gate', async () => {
    const result = await semanticValidator(
      {
        type: 'semantic',
        expected: 'verify the duplicate charge and issue a refund',
        threshold: 0,
        minTermCoverage: 0.9,
      },
      makeContext('Something completely different about penguins.'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('term coverage');
  });

  it('fails on term coverage even when the similarity is high', async () => {
    const result = await semanticValidator(
      {
        type: 'semantic',
        expected: 'refund the duplicate order',
        threshold: 0,
        minTermCoverage: 1,
      },
      makeContext('refund the duplicate order'),
    );
    expect(result.passed).toBe(true);
  });

  it('reports the components and missing terms in the details', async () => {
    const result = await semanticValidator(
      { type: 'semantic', expected: 'refund the duplicate order' },
      makeContext('refund it'),
    );
    const details = result.details as {
      components: Record<string, number>;
      missingTerms: string[];
      termCoverage: number;
    };
    expect(details.components.wordJaccard).toBeGreaterThanOrEqual(0);
    expect(details.components.charBigram).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(details.missingTerms)).toBe(true);
    expect(details.termCoverage).toBeGreaterThanOrEqual(0);
  });

  it('errors when no expected value is provided', async () => {
    const result = await semanticValidator(
      { type: 'semantic', expected: [] },
      makeContext('text'),
    );
    expect(result.status).toBe('errored');
  });

  it('uses the supplied embedding function when available', async () => {
    const embed = vi.fn(async (text: string) => {
      // A trivially separable embedding: the first character decides.
      return [text.charCodeAt(0), 0, 0];
    });
    const result = await semanticValidator(
      { type: 'semantic', expected: 'refund the order', threshold: 0.1 },
      makeContext('refund the order', embed),
    );
    expect(embed).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(true);
    const details = result.details as { components: { embedding?: number } };
    expect(details.components.embedding).toBeCloseTo(1, 5);
  });

  it('reports a non-zero score for unrelated content', async () => {
    const result = await semanticValidator(
      { type: 'semantic', expected: 'refund the duplicate order' },
      makeContext('entirely about the weather'),
    );
    expect(result.score).toBeLessThan(0.4);
  });
});
